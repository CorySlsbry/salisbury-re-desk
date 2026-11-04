/**
 * salisburyre.com CRM link. The website's CRM is a Supabase project Cory owns (nlnahfapzrmihqflwrac). The app signs in
 * as Cory's own CRM user (email + password typed here once, tokens kept DPAPI-encrypted, the password never stored),
 * pulls website leads and CRM contacts into an inbox for him to add as clients, and pushes his clients, listings,
 * contract deadlines and showings so the website dashboard shows the live pipeline. Every push is idempotent
 * (crm_links remembers what was written and a fingerprint of it). Nothing is deleted on either side.
 */
import { native } from './native';
import * as repo from './repo';
import * as auto from './repoAuto';
import * as link from './repoCrm';

export const CRM_DEFAULT_URL = 'https://your-project.supabase.co';
/** The project's public anon key (shipped to every browser visiting salisburyre.com); row access is governed by RLS + the signed-in user. */
export const CRM_ANON_KEY = 'REDACTED';
const SECRET = { refresh: 'crm_refresh_token', access: 'crm_access_token' } as const;
const STAGE_FOR_STATUS: Record<string, string> = { active: 'Contacted', under_contract: 'Negotiating', pending: 'Negotiating', closed: 'Won', fell_through: 'Lost' };
const MILESTONE_STATUS: Record<string, string> = { pending: 'pending', done: 'completed', waived: 'waived', missed: 'missed', superseded: 'waived' };

async function cfg() { const s = await repo.getSettings(); return { url: (s.crm_url || CRM_DEFAULT_URL).replace(/\/$/, ''), anon: s.crm_anon_key || CRM_ANON_KEY, s }; }

export interface CrmStatus { connected: boolean; email?: string; url: string; lastSync?: string; mode: 'off' | 'manual' | 'auto'; inbox: { new: number; added: number } }
export async function crmStatus(): Promise<CrmStatus> {
  const { url, s } = await cfg();
  const refresh = await native.secretGet(SECRET.refresh);
  return { connected: !!refresh, email: s.crm_email || undefined, url, lastSync: s.crm_last_sync_at || undefined, mode: (s.crm_sync_mode as CrmStatus['mode']) || 'auto', inbox: await link.inboxCounts() };
}

/** Supabase Auth password grant. The password is used for this one request and never stored. */
export async function crmSignIn(email: string, password: string): Promise<CrmStatus> {
  const { url, anon } = await cfg();
  const r = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: anon, 'content-type': 'application/json' }, body: JSON.stringify({ email: email.trim(), password }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || j.msg || j.message || `sign-in failed (${r.status})`);
  await native.secretSet(SECRET.refresh, j.refresh_token);
  await native.secretSet(SECRET.access, j.access_token);
  await repo.setSetting('crm_token_expires_at', String(Date.now() + (j.expires_in ?? 3600) * 1000 - 60_000));
  await repo.setSetting('crm_email', j.user?.email ?? email.trim());
  await repo.logEvent('crm.connected', undefined, undefined, { email: j.user?.email ?? email.trim() });
  return crmStatus();
}
export async function crmSignOut(): Promise<void> {
  for (const n of [SECRET.refresh, SECRET.access]) await native.secretSet(n, '');
  for (const k of ['crm_token_expires_at', 'crm_email']) await repo.setSetting(k, '');
  await repo.logEvent('crm.disconnected');
}
async function accessToken(): Promise<string> {
  const { url, anon, s } = await cfg();
  const [refresh, access] = await Promise.all([native.secretGet(SECRET.refresh), native.secretGet(SECRET.access)]);
  if (!refresh) throw new Error('salisburyre.com CRM is not connected (Settings).');
  if (access && Number(s.crm_token_expires_at ?? 0) > Date.now()) return access;
  const r = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: { apikey: anon, 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: refresh }) });
  const j = await r.json();
  if (!r.ok) { if (r.status === 400 || r.status === 401) await crmSignOut(); throw new Error(`CRM sign-in expired: ${j.error_description || j.msg || r.status}. Sign in again in Settings.`); }
  await native.secretSet(SECRET.refresh, j.refresh_token ?? refresh);
  await native.secretSet(SECRET.access, j.access_token);
  await repo.setSetting('crm_token_expires_at', String(Date.now() + (j.expires_in ?? 3600) * 1000 - 60_000));
  return j.access_token;
}
/** PostgREST call as the signed-in user. */
async function rest<T = unknown>(path: string, init: RequestInit & { prefer?: string } = {}): Promise<T> {
  const { url, anon } = await cfg();
  const tok = await accessToken();
  const r = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { apikey: anon, authorization: `Bearer ${tok}`, 'content-type': 'application/json', ...(init.prefer ? { Prefer: init.prefer } : {}), ...(init.headers ?? {}) } });
  const text = await r.text();
  if (!r.ok) throw new Error(`CRM ${r.status}: ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : null) as T;
}

/* ---------- pure helpers (tested) ---------- */
export const digits = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '').slice(-10);
export function splitName(full: string | null | undefined): { first: string; last: string } {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: 'Unknown', last: 'Lead' };
  if (parts.length === 1) return { first: parts[0], last: '(website)' };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}
export function clientFingerprint(c: repo.Client): string { return JSON.stringify([c.first_name, c.last_name, c.email ?? '', digits(c.phone), c.stage, c.interest ?? '', c.source ?? '', c.notes ?? '']); }
export function dealFingerprint(tx: repo.TxRow, expected: string | null): string { return JSON.stringify([tx.status, tx.side, tx.street, tx.list_price, tx.contract_price, expected]); }
/** A CRM contact or website lead becomes a lead-stage client. */
export function inboxToClient(r: link.InboxRow): Partial<repo.Client> & { first_name: string; last_name: string } {
  const { first, last } = splitName(r.name);
  const tags = (r.tags ?? '').toLowerCase();
  const interest = /seller|expired|withdrawn|cancel/.test(tags) ? 'seller' : /buyer|investor/.test(tags) ? 'buyer' : null;
  return { first_name: first, last_name: last, email: r.email || null, phone: r.phone || null, source: 'website', stage: 'lead', interest, notes: [r.magnet ? `Website lead: ${r.magnet}` : null, r.source ? `Source: ${r.source}` : null, r.notes].filter(Boolean).join('\n') || null, lead_received_at: r.received_at?.slice(0, 10) ?? repo.today() };
}

/* ---------- pull: website leads + CRM contacts into the inbox ---------- */
interface LeadRow { id: string; created_at: string; name: string; email: string; phone: string; magnet: string; source: string; worked: boolean; notes: string | null; tags: string[] | null }
interface ContactRow { id: string; email: string | null; phone: string | null; first_name: string | null; last_name: string | null; source: string | null; lead_source_type: string | null; lead_type: string | null; notes: string | null; updated_at: string | null; last_activity_at: string | null; do_not_disturb: boolean; unsubscribed: boolean }
export async function pullInbox(onStep?: (s: string) => void): Promise<{ leads: number; contacts: number; fresh: number }> {
  onStep?.('Reading website leads');
  const leads = await rest<LeadRow[]>('leads?worked=eq.false&order=created_at.desc&limit=200&select=id,created_at,name,email,phone,magnet,source,worked,notes,tags');
  let fresh = 0;
  for (const l of leads) if (await link.upsertInbox({ crm_id: `lead:${l.id}`, kind: 'lead', name: l.name, email: l.email, phone: l.phone, source: l.source, magnet: l.magnet, tags: (l.tags ?? []).join(','), notes: l.notes, received_at: l.created_at })) fresh++;
  onStep?.('Reading CRM contacts');
  const since = (await repo.getSettings()).crm_contacts_since || '2026-01-01';
  const contacts = await rest<ContactRow[]>(`crm_contacts?updated_at=gte.${since}&do_not_disturb=eq.false&unsubscribed=eq.false&order=updated_at.desc&limit=300&select=id,email,phone,first_name,last_name,source,lead_source_type,lead_type,notes,updated_at,last_activity_at,do_not_disturb,unsubscribed`);
  const linked = new Set((await link.listLinks('client')).map(l => l.crm_id));
  const clients = await repo.listClients();
  for (const c of contacts) {
    if (linked.has(c.id)) continue;
    const known = clients.find(k => (c.email && k.email && k.email.toLowerCase() === c.email.toLowerCase()) || (c.phone && k.phone && digits(k.phone) === digits(c.phone)));
    if (known) { await link.setLink('client', known.id, 'crm_contacts', c.id, null); continue; }
    if (await link.upsertInbox({ crm_id: `contact:${c.id}`, kind: 'contact', name: [c.first_name, c.last_name].filter(Boolean).join(' ') || null, email: c.email, phone: c.phone, source: c.source ?? c.lead_source_type, magnet: c.lead_type, tags: null, notes: c.notes, received_at: c.last_activity_at ?? c.updated_at })) fresh++;
  }
  return { leads: leads.length, contacts: contacts.length, fresh };
}
/** Cory clicked "Add as client": create (or merge into) the client, link it, mark the website lead worked. */
export async function addInboxAsClient(crmId: string): Promise<number> {
  const row = (await link.listInbox('all')).find(r => r.crm_id === crmId); if (!row) throw new Error('inbox row not found');
  const id = await repo.upsertClient(inboxToClient(row));
  await link.setInboxStatus(crmId, 'added', id);
  const [kind, remoteId] = crmId.split(':');
  if (kind === 'contact') await link.setLink('client', id, 'crm_contacts', remoteId, null);
  if (kind === 'lead') { try { await rest(`leads?id=eq.${remoteId}`, { method: 'PATCH', body: JSON.stringify({ worked: true, notes: `Added to Salisbury RE Desk ${repo.today()}` }), prefer: 'return=minimal' }); } catch { /* the site is the record of the lead; the client exists locally either way */ } }
  await repo.logEvent('crm.inbox.added', 'client', id, { crmId });
  return id;
}
export async function dismissInbox(crmId: string): Promise<void> { await link.setInboxStatus(crmId, 'dismissed'); }

/* ---------- push: clients, deals, milestones, showings ---------- */
let stageCache: Record<string, string> | null = null; let tagCache: Record<string, string> | null = null;
async function stageId(name: string): Promise<string | null> {
  if (!stageCache) { stageCache = {}; for (const s of await rest<Array<{ id: string; name: string }>>('crm_pipeline_stages?select=id,name')) stageCache[s.name] = s.id; }
  return stageCache[name] ?? null;
}
async function tagId(name: string): Promise<string | null> {
  if (!tagCache) { tagCache = {}; for (const t of await rest<Array<{ id: string; name: string }>>('crm_tags?select=id,name')) tagCache[t.name] = t.id; }
  if (!tagCache[name]) { try { const made = await rest<Array<{ id: string }>>('crm_tags', { method: 'POST', body: JSON.stringify({ name, color: '#c8102e' }), prefer: 'return=representation' }); tagCache[name] = made[0]?.id; } catch { return null; } }
  return tagCache[name] ?? null;
}
export async function pushClients(onStep?: (s: string) => void): Promise<{ created: number; updated: number; unchanged: number }> {
  const out = { created: 0, updated: 0, unchanged: 0 };
  const clients = (await repo.listClients()).filter(c => !c.do_not_contact);
  const tag = await tagId('re-desk');
  for (const [i, c] of clients.entries()) {
    const fp = clientFingerprint(c);
    const existing = await link.getLink('client', c.id, 'crm_contacts');
    if (existing && existing.fingerprint === fp) { out.unchanged++; continue; }
    onStep?.(`Client ${i + 1}/${clients.length}: ${c.last_name}, ${c.first_name}`);
    const body = { first_name: c.first_name, last_name: c.last_name, email: c.email || null, phone: c.phone || null, source: c.source || 'redesk', lead_type: c.interest || null, notes: c.notes || null, metadata: { redesk_client_id: c.id, stage: c.stage } };
    let crmId = existing?.crm_id ?? null;
    if (!crmId) {
      const q = c.email ? `email=ilike.${encodeURIComponent(c.email)}` : c.phone ? `phone=eq.${encodeURIComponent(c.phone)}` : null;
      if (q) { const hit = await rest<Array<{ id: string }>>(`crm_contacts?${q}&select=id&limit=1`); crmId = hit[0]?.id ?? null; }
    }
    if (crmId) { await rest(`crm_contacts?id=eq.${crmId}`, { method: 'PATCH', body: JSON.stringify(body), prefer: 'return=minimal' }); out.updated++; }
    else { const made = await rest<Array<{ id: string }>>('crm_contacts', { method: 'POST', body: JSON.stringify(body), prefer: 'return=representation' }); crmId = made[0].id; out.created++; await rest('crm_activities', { method: 'POST', body: JSON.stringify({ contact_id: crmId, type: 'redesk_linked', summary: 'Linked from Salisbury RE Desk' }), prefer: 'return=minimal' }).catch(() => {}); }
    if (tag) await rest('crm_contact_tags', { method: 'POST', body: JSON.stringify({ contact_id: crmId, tag_id: tag }), prefer: 'return=minimal,resolution=ignore-duplicates' }).catch(() => {});
    await link.setLink('client', c.id, 'crm_contacts', crmId, fp);
  }
  return out;
}
export async function pushTransactions(onStep?: (s: string) => void): Promise<{ deals: number; milestones: number; showings: number }> {
  const out = { deals: 0, milestones: 0, showings: 0 };
  for (const tx of await repo.listTransactions()) {
    const contactLink = await link.getLink('client', tx.client_id, 'crm_contacts'); if (!contactLink) continue;
    const deadlines = await repo.listDeadlines({ transactionId: tx.id });
    const settlement = deadlines.find(d => /settlement/i.test(d.label) && d.status !== 'waived');
    const fp = dealFingerprint(tx, settlement?.due_on ?? null);
    const where = tx.street ? `${tx.street}${tx.city ? ', ' + tx.city : ''}` : `${tx.last_name}, ${tx.first_name}`;
    const existing = await link.getLink('transaction', tx.id, 'crm_deals');
    let dealId = existing?.crm_id ?? null;
    if (!existing || existing.fingerprint !== fp) {
      onStep?.(`Deal: ${where}`);
      const stage = await stageId(STAGE_FOR_STATUS[tx.status] ?? 'Contacted');
      const body = { contact_id: contactLink.crm_id, stage_id: stage, title: `${tx.side === 'seller' ? 'Listing' : 'Buyer'}: ${where}`, value: tx.contract_price ?? tx.list_price ?? 0, notes: `Salisbury RE Desk status: ${tx.status}`, source: 'redesk', expected_close_date: settlement?.due_on ?? null, closed_at: tx.status === 'closed' ? new Date().toISOString() : null };
      if (dealId) await rest(`crm_deals?id=eq.${dealId}`, { method: 'PATCH', body: JSON.stringify(body), prefer: 'return=minimal' });
      else { const made = await rest<Array<{ id: string }>>('crm_deals', { method: 'POST', body: JSON.stringify(body), prefer: 'return=representation' }); dealId = made[0].id; }
      await link.setLink('transaction', tx.id, 'crm_deals', dealId!, fp); out.deals++;
    }
    if (!dealId) continue;
    for (const d of deadlines) {
      const mfp = JSON.stringify([d.label, d.status, d.due_on, d.notes ?? '']);
      const ml = await link.getLink('deadline', d.id, 'crm_transaction_milestones');
      if (ml && ml.fingerprint === mfp) continue;
      const body = { deal_id: dealId, milestone_type: d.label, status: MILESTONE_STATUS[d.status] ?? 'pending', due_date: d.due_on, completed_date: d.status === 'done' ? d.due_on : null, notes: d.notes ?? null };
      if (ml) await rest(`crm_transaction_milestones?id=eq.${ml.crm_id}`, { method: 'PATCH', body: JSON.stringify(body), prefer: 'return=minimal' });
      else { const made = await rest<Array<{ id: string }>>('crm_transaction_milestones', { method: 'POST', body: JSON.stringify(body), prefer: 'return=representation' }); await link.setLink('deadline', d.id, 'crm_transaction_milestones', made[0].id, mfp); }
      if (ml) await link.setLink('deadline', d.id, 'crm_transaction_milestones', ml.crm_id, mfp);
      out.milestones++;
    }
    for (const s of await auto.listShowings(tx.id)) {
      const sl = await link.getLink('showing', s.id, 'crm_showing_feedback'); if (sl) continue;
      const body = { deal_id: dealId, contact_id: contactLink.crm_id, property_address: where, showing_date: s.shown_on, buyer_feedback: s.feedback ?? null, agent_notes: [s.agent, s.brokerage].filter(Boolean).join(', ') || null, interested: s.interest === 'high' || s.interest === 'medium', follow_up_needed: s.interest === 'high' };
      const made = await rest<Array<{ id: string }>>('crm_showing_feedback', { method: 'POST', body: JSON.stringify(body), prefer: 'return=representation' });
      await link.setLink('showing', s.id, 'crm_showing_feedback', made[0].id, null); out.showings++;
    }
  }
  return out;
}

export interface SyncResult { pulled: { leads: number; contacts: number; fresh: number }; clients: { created: number; updated: number; unchanged: number }; tx: { deals: number; milestones: number; showings: number } }
let running: Promise<SyncResult> | null = null;
/** Pull, then push. One at a time; a second call joins the running one. */
export function syncAll(onStep?: (s: string) => void): Promise<SyncResult> {
  if (running) return running;
  running = (async () => {
    try {
      const pulled = await pullInbox(onStep);
      const clients = await pushClients(onStep);
      const tx = await pushTransactions(onStep);
      await repo.setSetting('crm_last_sync_at', new Date().toISOString());
      await repo.logEvent('crm.synced', undefined, undefined, { pulled, clients, tx });
      return { pulled, clients, tx };
    } finally { running = null; }
  })();
  return running;
}
