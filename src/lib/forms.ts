/**
 * Forms library: every PDF under Forms\State, Forms\UAR and Forms\MLS (UtahRealEstate.com data-input sheets and
 * listing-status forms, indexed as source "custom"), mirrored into the `forms` table so packets can link to a real
 * file. Sync is idempotent and cheap: a file is re-hashed only when it is new or its size changed.
 */
import { appPaths, db, native, doc } from './native';

export interface FormRow {
  id: number; code: string; name: string; source: 'state' | 'uar' | 'brokerage' | 'custom'; path: string; sha256: string;
  version_label: string | null; url: string | null; bytes: number | null; pages: number | null; fillable: number | null; revision: string | null; missing: number;
}

/** "Sellers Property Condition Disclosure (rev March 3, 2026).pdf" -> { name, revision } */
export function parseFormFile(file: string): { name: string; revision: string | null } {
  const base = file.replace(/\.pdf$/i, '');
  const m = /^(.*?)\s*\(rev\s+([^)]+)\)\s*$/i.exec(base);
  // kebab-case state files ('blank-addendum') become words; names that already have spaces keep their dashes ('MLS Data Input Form - Residential')
  return m ? { name: m[1].trim(), revision: m[2].trim() } : { name: (base.includes(' ') ? base : base.replace(/[-_]+/g, ' ')).trim(), revision: null };
}
export function formCode(source: string, file: string): string {
  return `${source}:${parseFormFile(file).name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
}

export async function listForms(): Promise<FormRow[]> {
  const d = await db();
  return d.select<FormRow[]>("SELECT * FROM forms WHERE missing = 0 ORDER BY source, name");
}
export async function getForm(id: number): Promise<FormRow | null> { const d = await db(); const r = await d.select<FormRow[]>('SELECT * FROM forms WHERE id=$1', [id]); return r[0] ?? null; }

/** Scan both form folders; insert new files, refresh changed ones, flag vanished ones. Returns counts. */
export async function syncFormsLibrary(onStep?: (s: string) => void): Promise<{ added: number; updated: number; missing: number; total: number }> {
  const p = await appPaths();
  const d = await db();
  const known = new Map((await d.select<FormRow[]>('SELECT * FROM forms')).map(f => [f.path.toLowerCase(), f]));
  const seen = new Set<string>();
  let added = 0, updated = 0;
  for (const [source, dir] of [['state', p.forms_state], ['uar', p.forms_uar], ['custom', `${p.root}\\Forms\\MLS`]] as const) {
    const entries = await native.listDir(dir).catch(() => [] as [string, number, boolean][]);
    for (const [full, bytes, isDir] of entries) {
      if (isDir || !/\.pdf$/i.test(full)) continue;
      const file = full.split(/[\\/]/).pop()!;
      seen.add(full.toLowerCase());
      const ex = known.get(full.toLowerCase());
      const { name, revision } = parseFormFile(file);
      if (ex && ex.bytes === bytes && !ex.missing && ex.name === name) continue; // unchanged file, unchanged naming rule
      onStep?.(`Indexing ${file}`);
      const [sha] = await native.sha256File(full);
      let pages: number | null = null, fillable: number | null = null;
      try { const info = await doc.info(full); pages = info.pages; fillable = info.has_forms ? 1 : 0; } catch { /* doc engine not up yet: fill in next sync */ }
      if (ex) {
        await d.execute('UPDATE forms SET name=$1, sha256=$2, bytes=$3, pages=$4, fillable=$5, revision=$6, version_label=$7, missing=0, checked_at=datetime(\'now\') WHERE id=$8', [name, sha, bytes, pages, fillable, revision, revision, ex.id]);
        updated++;
      } else {
        // a re-downloaded newer revision of the same form keeps one row per file (code includes the name only, so add the revision when it collides)
        let code = formCode(source, file);
        const clash = await d.select<{ id: number }[]>('SELECT id FROM forms WHERE code=$1', [code]);
        if (clash.length) code += ':' + (revision ?? sha.slice(0, 8)).toLowerCase().replace(/[^a-z0-9]+/g, '_');
        await d.execute('INSERT INTO forms(code, name, source, path, sha256, version_label, bytes, pages, fillable, revision, checked_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,datetime(\'now\'))', [code, name, source, full, sha, revision, bytes, pages, fillable, revision]);
        added++;
      }
    }
  }
  let missing = 0;
  for (const [path, f] of known) if (!seen.has(path) && !f.missing && (f.source === 'state' || f.source === 'uar' || f.source === 'custom')) { await d.execute('UPDATE forms SET missing=1 WHERE id=$1', [f.id]); missing++; }
  const total = (await d.select<{ c: number }[]>('SELECT COUNT(*) AS c FROM forms WHERE missing=0'))[0]?.c ?? 0;
  return { added, updated, missing, total };
}
