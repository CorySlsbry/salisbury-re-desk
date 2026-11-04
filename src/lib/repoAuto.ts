/** The one reader/writer of the automation_runs and showings tables (migration 0005). */
import { db } from './native';
import { today } from './repo';

export interface AutomationRun { id: number; key: string; at: string; trigger: string; ok: number; summary: string; details_json: string | null; duration_ms: number | null }
export async function logAutomationRun(r: { key: string; trigger: string; ok: boolean; summary: string; details?: unknown; durationMs: number }): Promise<void> {
  const d = await db();
  await d.execute('INSERT INTO automation_runs(key, trigger, ok, summary, details_json, duration_ms) VALUES ($1,$2,$3,$4,$5,$6)', [r.key, r.trigger, r.ok ? 1 : 0, r.summary, r.details === undefined ? null : JSON.stringify(r.details), r.durationMs]);
}
export async function listAutomationRuns(limit = 200): Promise<AutomationRun[]> { const d = await db(); return d.select<AutomationRun[]>('SELECT * FROM automation_runs ORDER BY id DESC LIMIT $1', [limit]); }
export async function lastAutomationRun(key: string): Promise<AutomationRun | null> { const d = await db(); const r = await d.select<AutomationRun[]>('SELECT * FROM automation_runs WHERE key=$1 ORDER BY id DESC LIMIT 1', [key]); return r[0] ?? null; }

export interface ShowingRow { id: number; transaction_id: number; shown_on: string; shown_at: string | null; agent: string | null; brokerage: string | null; feedback: string | null; interest: string | null; source: string; fingerprint: string | null; created_at: string }
export async function addShowing(s: Omit<ShowingRow, 'id' | 'created_at'>): Promise<'added' | 'duplicate'> {
  const d = await db();
  if (s.fingerprint) { const ex = await d.select<{ id: number }[]>('SELECT id FROM showings WHERE fingerprint=$1', [s.fingerprint]); if (ex[0]) return 'duplicate'; }
  await d.execute('INSERT INTO showings(transaction_id, shown_on, shown_at, agent, brokerage, feedback, interest, source, fingerprint) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [s.transaction_id, s.shown_on, s.shown_at, s.agent, s.brokerage, s.feedback, s.interest, s.source, s.fingerprint]);
  return 'added';
}
export async function listShowings(transactionId: number): Promise<ShowingRow[]> { const d = await db(); return d.select<ShowingRow[]>('SELECT * FROM showings WHERE transaction_id=$1 ORDER BY shown_on DESC, shown_at DESC', [transactionId]); }
export async function showingCounts(transactionId: number, from: string, to = today()): Promise<{ total: number; week: number; withFeedback: number }> {
  const d = await db();
  const total = (await d.select<{ c: number }[]>('SELECT COUNT(*) AS c FROM showings WHERE transaction_id=$1', [transactionId]))[0]?.c ?? 0;
  const week = (await d.select<{ c: number }[]>('SELECT COUNT(*) AS c FROM showings WHERE transaction_id=$1 AND shown_on BETWEEN $2 AND $3', [transactionId, from, to]))[0]?.c ?? 0;
  const withFeedback = (await d.select<{ c: number }[]>("SELECT COUNT(*) AS c FROM showings WHERE transaction_id=$1 AND feedback IS NOT NULL AND feedback <> ''", [transactionId]))[0]?.c ?? 0;
  return { total, week, withFeedback };
}
export async function stampTransaction(id: number, patch: { broker_submitted_on?: string | null; hoa_request_sent_on?: string | null }): Promise<void> {
  const d = await db();
  if (patch.broker_submitted_on !== undefined) await d.execute("UPDATE transactions SET broker_submitted_on=$1, updated_at=datetime('now') WHERE id=$2", [patch.broker_submitted_on, id]);
  if (patch.hoa_request_sent_on !== undefined) await d.execute("UPDATE transactions SET hoa_request_sent_on=$1, updated_at=datetime('now') WHERE id=$2", [patch.hoa_request_sent_on, id]);
}
