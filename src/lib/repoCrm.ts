/** Data access for the salisburyre.com CRM link (migration 0010): what was pushed (links) and what was pulled (inbox). */
import { db } from './native';

export interface CrmLink { entity: string; local_id: number; crm_table: string; crm_id: string; fingerprint: string | null; synced_at: string }
export async function getLink(entity: string, localId: number, crmTable: string): Promise<CrmLink | null> { const d = await db(); const r = await d.select<CrmLink[]>('SELECT * FROM crm_links WHERE entity=$1 AND local_id=$2 AND crm_table=$3', [entity, localId, crmTable]); return r[0] ?? null; }
export async function setLink(entity: string, localId: number, crmTable: string, crmId: string, fingerprint: string | null): Promise<void> {
  const d = await db();
  await d.execute("INSERT INTO crm_links(entity, local_id, crm_table, crm_id, fingerprint) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(entity, local_id, crm_table) DO UPDATE SET crm_id=excluded.crm_id, fingerprint=excluded.fingerprint, synced_at=datetime('now')", [entity, localId, crmTable, crmId, fingerprint]);
}
export async function listLinks(entity?: string): Promise<CrmLink[]> { const d = await db(); return entity ? d.select<CrmLink[]>('SELECT * FROM crm_links WHERE entity=$1', [entity]) : d.select<CrmLink[]>('SELECT * FROM crm_links'); }

export interface InboxRow { crm_id: string; kind: 'lead' | 'contact'; name: string | null; email: string | null; phone: string | null; source: string | null; magnet: string | null; tags: string | null; notes: string | null; received_at: string | null; status: 'new' | 'added' | 'dismissed'; client_id: number | null; pulled_at: string }
export async function upsertInbox(r: Omit<InboxRow, 'status' | 'client_id' | 'pulled_at'>): Promise<boolean> {
  const d = await db();
  const cur = await d.select<Array<{ crm_id: string }>>('SELECT crm_id FROM crm_inbox WHERE crm_id=$1', [r.crm_id]);
  await d.execute(`INSERT INTO crm_inbox(crm_id, kind, name, email, phone, source, magnet, tags, notes, received_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT(crm_id) DO UPDATE SET name=excluded.name, email=excluded.email, phone=excluded.phone, source=excluded.source, magnet=excluded.magnet, tags=excluded.tags, notes=excluded.notes, received_at=excluded.received_at, pulled_at=datetime('now')`,
    [r.crm_id, r.kind, r.name, r.email, r.phone, r.source, r.magnet, r.tags, r.notes, r.received_at]);
  return cur.length === 0;
}
export async function listInbox(status: InboxRow['status'] | 'all' = 'new'): Promise<InboxRow[]> { const d = await db(); return status === 'all' ? d.select<InboxRow[]>('SELECT * FROM crm_inbox ORDER BY received_at DESC') : d.select<InboxRow[]>('SELECT * FROM crm_inbox WHERE status=$1 ORDER BY received_at DESC', [status]); }
export async function setInboxStatus(crmId: string, status: InboxRow['status'], clientId: number | null = null): Promise<void> { const d = await db(); await d.execute('UPDATE crm_inbox SET status=$1, client_id=$2 WHERE crm_id=$3', [status, clientId, crmId]); }
export async function inboxCounts(): Promise<{ new: number; added: number }> { const d = await db(); const r = await d.select<Array<{ new: number; added: number }>>("SELECT coalesce(sum(status='new'),0) AS new, coalesce(sum(status='added'),0) AS added FROM crm_inbox"); return r[0] ?? { new: 0, added: 0 }; }
