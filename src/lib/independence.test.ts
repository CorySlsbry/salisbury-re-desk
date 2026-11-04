import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guard for Cory's rule (2026-09-08): this app is independent of the older platforms. Lessons may be taken from them,
 * code may not. Any import or path that points at another project fails the suite.
 */
const ROOTS = ['src', 'sidecar', 'src-tauri/src'];
// Three "../" from src/lib/extract reaches this repo's root (templates/); four would leave the repo.
const FORBIDDEN = [/topbuilder/i, /geo[-_ ]flywheel/i, /neuron[-_ ]?(hq|learnai|vault)/i, /salisburyre-guides/i, /re_compliance\.py/, /from ['"](?:\.\.\/){4,}/, /Downloads[\\/](?!salisbury-re-desk)[A-Za-z]/];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name === 'target' || name === 'dist' || name === '__pycache__') continue;
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx|py|rs)$/.test(name) && !name.endsWith('independence.test.ts')) out.push(p);
  }
  return out;
}

describe('independence from the old platforms', () => {
  it('no source file imports from or names another project', () => {
    const hits: string[] = [];
    for (const root of ROOTS) for (const f of files(root)) {
      const text = readFileSync(f, 'utf8');
      for (const rx of FORBIDDEN) { const m = rx.exec(text); if (m) hits.push(`${f}: ${m[0]}`); }
    }
    expect(hits).toEqual([]);
  });
});
