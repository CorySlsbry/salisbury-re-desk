/** Daily DB backup: SQLite VACUUM INTO a dated copy under Documents\Salisbury RE\Backups; keep the last 14. */
import { remove } from '@tauri-apps/plugin-fs';
import { appPaths, db, native } from './native';
import { today } from './repo';

export async function backupDatabase(): Promise<string | null> {
  const p = await appPaths();
  const file = `${p.backups}\\redesk-${today()}.db`;
  const existing = await native.listDir(p.backups).catch(() => [] as [string, number, boolean][]);
  if (existing.some(([f]) => f.endsWith(`redesk-${today()}.db`))) return null;
  const d = await db();
  await d.execute(`VACUUM INTO '${file.replace(/\\/g, '/').replace(/'/g, "''")}'`);
  const dated = existing.map(([f]) => f).filter(f => /redesk-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const old of dated.slice(0, Math.max(0, dated.length - 13))) { try { await remove(old); } catch { /* keep going */ } }
  return file;
}
