/** Data access. The ONE reader/writer of every row shape (PREFLIGHT P-1). Dates are YYYY-MM-DD strings. */
import { db } from './native';
import { addDays } from './deadlines';

export interface Client {
  id: number; first_name: string; last_name: string; second_first_name: string | null; second_last_name: string | null;
  phone: string | null; email: string | null; phone2: string | null; email2: string | null; mailing_address: string | null;
  source: string | null; sms_consent: number; do_not_contact: number; notes: string | null; folder_path: string | null;
  stage: 'lead' | 'nurture' | 'client' | 'past' | 'lost'; preferred_channel: string | null; birthday: string | null; interest: string | null;
  lead_received_at: string | null; last_touch_on: string | null; replied_at: string | null;
  created_at: string; updated_at: string;
}
export interface Property {
  id: number; street: string; unit: string | null; city: string | null; state: string; zip: string | null; county: string | null;
  tax_id: string | null; mls_number: string | null; year_built: number | null; has_hoa: number | null; hoa_name: string | null; address_key: string | null;
}
export type TxSide = 'seller' | 'buyer';
export type TxStatus = 'lead' | 'active' | 'under_contract' | 'pending' | 'closed' | 'fell_through' | 'cancelled';
export interface Transaction {
  id: number; client_id: number; property_id: number | null; side: TxSide; status: TxStatus;
  list_price: number | null; contract_price: number | null; agreement_signed_on: string | null; agreement_expires_on: string | null;
  acceptance_on: string | null; acceptance_time: string | null; repc_version: string | null; is_cash: number;
  lender_contact_id: number | null; title_contact_id: number | null; coop_agent_contact_id: number | null;
  commission_pct: number | null; commission_flat: number | null; broker_file_status: string; closed_on: string | null; fell_through_on: string | null;
  notes: string | null; created_at: string; updated_at: string;
  broker_submitted_on?: string | null; hoa_request_sent_on?: string | null;
}
export interface TxRow extends Transaction { first_name: string; last_name: string; street: string | null; city: string | null }
export interface DocumentRow {
  id: number; transaction_id: number | null; client_id: number | null; kind: string; title: string | null; path: string; sha256: string;
  pages: number | null; bytes: number | null; form_id: number | null; signed: number; signed_on: string | null; extracted_json: string | null;
  extraction_tier: number | null; reviewed_at: string | null; uploaded_at: string; draft?: number; packet_item_id?: number | null;
}
export interface DeadlineRow {
  id: number; transaction_id: number; type: string; label: string; due_on: string; due_time: string; basis: string;
  source_document_id: number | null; source_page: number | null; confidence: number | null; status: string; superseded_by: number | null;
  reminder_on: string | null; notes: string | null;
}
export interface TaskRow {
  id: number; transaction_id: number | null; client_id: number | null; cadence_step_id: number | null; deadline_id: number | null;
  kind: string; title: string; body: string | null; due_on: string; due_time: string | null; priority: string; done_at: string | null; snoozed_until: string | null;
}
export interface PacketItemRow { id: number; transaction_id: number; position: number; doc_kind: string; label: string; required_when: string | null; form_code: string | null; form_id: number | null; status: string; document_id: number | null; form_path?: string | null; form_name?: string | null }

/** Dynamic UPDATEs only ever name columns from these lists; a stray key is dropped, never interpolated. */
const UPDATABLE = {
  clients: new Set(['stage', 'preferred_channel', 'birthday', 'interest', 'last_touch_on', 'replied_at', 'notes', 'phone', 'email']),
  transactions: new Set(['status', 'list_price', 'contract_price', 'agreement_signed_on', 'agreement_expires_on', 'acceptance_on', 'acceptance_time', 'is_cash', 'commission_pct', 'commission_flat', 'broker_file_status', 'closed_on', 'fell_through_on', 'notes', 'lender_contact_id', 'title_contact_id', 'coop_agent_contact_id']),
  packet_items: new Set(['label', 'required_when', 'form_id', 'doc_kind', 'reason', 'note']),
  ideas: new Set(['hook', 'status', 'built_on', 'posted_on', 'platform', 'text']),
};
function updatableKeys(table: keyof typeof UPDATABLE, patch: object): string[] {
  return Object.keys(patch).filter(k => UPDATABLE[table].has(k) && (patch as Record<string, unknown>)[k] !== undefined);
}

export function today(): string { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' }); }
export function addressKey(street: string, zip?: string | null): string { return `${street}|${zip ?? ''}`.toLowerCase().replace(/[^a-z0-9|]/g, ''); }

/* ---------- clients ---------- */
export async function listClients(q = ''): Promise<Client[]> {
  const d = await db();
  return d.select<Client[]>(`SELECT * FROM clients WHERE ($1 = '' OR lower(first_name || ' ' || last_name || ' ' || coalesce(email,'') || ' ' || coalesce(phone,'')) LIKE '%' || lower($1) || '%') ORDER BY last_name, first_name`, [q]);
}
export async function getClient(id: number): Promise<Client | null> {
  const d = await db(); const r = await d.select<Client[]>('SELECT * FROM clients WHERE id = $1', [id]); return r[0] ?? null;
}
export async function upsertClient(c: Partial<Client> & { first_name: string; last_name: string }): Promise<number> {
  const d = await db();
  if (c.id) {
    await d.execute(`UPDATE clients SET first_name=$1,last_name=$2,second_first_name=$3,second_last_name=$4,phone=$5,email=$6,phone2=$7,email2=$8,mailing_address=$9,source=$10,notes=$11,updated_at=datetime('now') WHERE id=$12`,
      [c.first_name, c.last_name, c.second_first_name ?? null, c.second_last_name ?? null, c.phone ?? null, c.email ?? null, c.phone2 ?? null, c.email2 ?? null, c.mailing_address ?? null, c.source ?? null, c.notes ?? null, c.id]);
    await updateClient(c.id, { stage: c.stage, preferred_channel: c.preferred_channel, birthday: c.birthday, interest: c.interest });
    return c.id;
  }
  // merge on email or phone when present
  if (c.email || c.phone) {
    const ex = await d.select<Client[]>('SELECT * FROM clients WHERE ($1 IS NOT NULL AND lower(email) = lower($1)) OR ($2 IS NOT NULL AND phone = $2) LIMIT 1', [c.email ?? null, c.phone ?? null]);
    if (ex[0]) return ex[0].id;
  }
  const r = await d.execute(`INSERT INTO clients(first_name,last_name,second_first_name,second_last_name,phone,email,phone2,email2,mailing_address,source,notes,stage,preferred_channel,birthday,interest,lead_received_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [c.first_name, c.last_name, c.second_first_name ?? null, c.second_last_name ?? null, c.phone ?? null, c.email ?? null, c.phone2 ?? null, c.email2 ?? null, c.mailing_address ?? null, c.source ?? null, c.notes ?? null, c.stage ?? 'client', c.preferred_channel ?? null, c.birthday ?? null, c.interest ?? null, c.stage === 'lead' ? today() : null]);
  return r.lastInsertId as number;
}
/** Patch the people fields (stage, channel, birthday, interest, touch dates). Undefined keys are left alone. */
export async function updateClient(id: number, patch: Partial<Pick<Client, 'stage' | 'preferred_channel' | 'birthday' | 'interest' | 'last_touch_on' | 'replied_at' | 'notes' | 'phone' | 'email'>>): Promise<void> {
  const d = await db();
  const keys = updatableKeys('clients', patch);
  if (!keys.length) return;
  await d.execute(`UPDATE clients SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(', ')}, updated_at=datetime('now') WHERE id=$${keys.length + 1}`, [...keys.map(k => (patch as Record<string, unknown>)[k]), id]);
}
export async function listPeople(stage?: string): Promise<Client[]> {
  const d = await db();
  return stage ? d.select<Client[]>('SELECT * FROM clients WHERE stage=$1 ORDER BY last_touch_on, last_name', [stage]) : d.select<Client[]>('SELECT * FROM clients ORDER BY last_name, first_name');
}
/** Birthdays today or within N days (birthday stored as YYYY-MM-DD or MM-DD). */
export async function birthdaysWithin(days: number): Promise<Array<{ id: number; name: string; birthday: string; on: string; preferred_channel: string | null; phone: string | null; email: string | null }>> {
  const d = await db();
  const rows = await d.select<Client[]>("SELECT * FROM clients WHERE birthday IS NOT NULL AND birthday <> ''");
  const t0 = today(); const out = [];
  for (const c of rows) {
    const md = c.birthday!.slice(-5);
    for (let i = 0; i <= days; i++) { const on = addDaysIso(t0, i); if (on.slice(5) === md) out.push({ id: c.id, name: `${c.first_name} ${c.last_name}`, birthday: c.birthday!, on, preferred_channel: c.preferred_channel, phone: c.phone, email: c.email }); }
  }
  return out;
}
const addDaysIso = addDays;
export async function setClientFolder(id: number, folder: string): Promise<void> { const d = await db(); await d.execute('UPDATE clients SET folder_path=$1 WHERE id=$2', [folder, id]); }

/* ---------- properties ---------- */
export async function upsertProperty(p: Partial<Property> & { street: string }): Promise<number> {
  const d = await db();
  const key = addressKey(p.street, p.zip);
  const ex = await d.select<Property[]>('SELECT * FROM properties WHERE address_key = $1 LIMIT 1', [key]);
  if (ex[0]) {
    await d.execute('UPDATE properties SET city=coalesce($1,city), county=coalesce($2,county), zip=coalesce($3,zip), tax_id=coalesce($4,tax_id), year_built=coalesce($5,year_built), has_hoa=coalesce($6,has_hoa) WHERE id=$7',
      [p.city ?? null, p.county ?? null, p.zip ?? null, p.tax_id ?? null, p.year_built ?? null, p.has_hoa ?? null, ex[0].id]);
    return ex[0].id;
  }
  const r = await d.execute('INSERT INTO properties(street,unit,city,state,zip,county,tax_id,mls_number,year_built,has_hoa,hoa_name,address_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [p.street, p.unit ?? null, p.city ?? null, p.state ?? 'UT', p.zip ?? null, p.county ?? null, p.tax_id ?? null, p.mls_number ?? null, p.year_built ?? null, p.has_hoa ?? null, p.hoa_name ?? null, key]);
  return r.lastInsertId as number;
}
export async function getProperty(id: number): Promise<Property | null> { const d = await db(); const r = await d.select<Property[]>('SELECT * FROM properties WHERE id=$1', [id]); return r[0] ?? null; }

/* ---------- transactions ---------- */
export async function listTransactions(opts: { clientId?: number; status?: TxStatus[] } = {}): Promise<TxRow[]> {
  const d = await db();
  const where: string[] = []; const args: unknown[] = [];
  if (opts.clientId) { args.push(opts.clientId); where.push(`t.client_id = $${args.length}`); }
  if (opts.status?.length) { where.push(`t.status IN (${opts.status.map(s => `'${s}'`).join(',')})`); }
  return d.select<TxRow[]>(`SELECT t.*, c.first_name, c.last_name, p.street, p.city FROM transactions t JOIN clients c ON c.id=t.client_id LEFT JOIN properties p ON p.id=t.property_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.updated_at DESC`, args);
}
export async function getTransaction(id: number): Promise<TxRow | null> {
  const d = await db();
  const r = await d.select<TxRow[]>('SELECT t.*, c.first_name, c.last_name, p.street, p.city FROM transactions t JOIN clients c ON c.id=t.client_id LEFT JOIN properties p ON p.id=t.property_id WHERE t.id=$1', [id]);
  return r[0] ?? null;
}
export async function createTransaction(t: { client_id: number; property_id?: number | null; side: TxSide; status?: TxStatus; list_price?: number | null; contract_price?: number | null; agreement_signed_on?: string | null; agreement_expires_on?: string | null; acceptance_on?: string | null; is_cash?: boolean; repc_version?: string | null }): Promise<number> {
  const d = await db();
  const r = await d.execute('INSERT INTO transactions(client_id,property_id,side,status,list_price,contract_price,agreement_signed_on,agreement_expires_on,acceptance_on,is_cash,repc_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [t.client_id, t.property_id ?? null, t.side, t.status ?? 'active', t.list_price ?? null, t.contract_price ?? null, t.agreement_signed_on ?? null, t.agreement_expires_on ?? null, t.acceptance_on ?? null, t.is_cash ? 1 : 0, t.repc_version ?? null]);
  return r.lastInsertId as number;
}
export async function updateTransaction(id: number, patch: Partial<Transaction>): Promise<void> {
  const d = await db();
  const keys = updatableKeys('transactions', patch);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k}=$${i + 1}`).join(', ');
  await d.execute(`UPDATE transactions SET ${sets}, updated_at=datetime('now') WHERE id=$${keys.length + 1}`, [...keys.map(k => (patch as Record<string, unknown>)[k]), id]);
}

/* ---------- documents ---------- */
export async function addDocument(doc: Omit<DocumentRow, 'id' | 'uploaded_at'>): Promise<number> {
  const d = await db();
  const ex = await d.select<{ id: number }[]>('SELECT id FROM documents WHERE sha256=$1', [doc.sha256]);
  if (ex[0]) return ex[0].id;
  const r = await d.execute('INSERT INTO documents(transaction_id,client_id,kind,title,path,sha256,pages,bytes,form_id,signed,signed_on,extracted_json,extraction_tier,reviewed_at,draft,packet_item_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
    [doc.transaction_id, doc.client_id, doc.kind, doc.title, doc.path, doc.sha256, doc.pages, doc.bytes, doc.form_id, doc.signed, doc.signed_on, doc.extracted_json, doc.extraction_tier, doc.reviewed_at, doc.draft ?? 0, doc.packet_item_id ?? null]);
  return r.lastInsertId as number;
}
export async function listDocuments(transactionId: number): Promise<DocumentRow[]> { const d = await db(); return d.select<DocumentRow[]>('SELECT * FROM documents WHERE transaction_id=$1 ORDER BY uploaded_at DESC', [transactionId]); }

/* ---------- deadlines ---------- */
export async function replaceDeadlines(transactionId: number, rows: Array<Omit<DeadlineRow, 'id' | 'transaction_id' | 'superseded_by'>>): Promise<void> {
  const d = await db();
  await d.execute("UPDATE deadlines SET status='superseded' WHERE transaction_id=$1 AND status IN ('pending')", [transactionId]);
  for (const r of rows) {
    await d.execute('INSERT INTO deadlines(transaction_id,type,label,due_on,due_time,basis,source_document_id,source_page,confidence,status,reminder_on,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [transactionId, r.type, r.label, r.due_on, r.due_time, r.basis, r.source_document_id, r.source_page, r.confidence, r.status, r.reminder_on, r.notes]);
  }
}
export async function listDeadlines(opts: { transactionId?: number; from?: string; to?: string } = {}): Promise<Array<DeadlineRow & { first_name: string; last_name: string; street: string | null; side: TxSide }>> {
  const d = await db();
  const where = ["dl.status IN ('pending','done','waived','missed')"]; const args: unknown[] = [];
  if (opts.transactionId) { args.push(opts.transactionId); where.push(`dl.transaction_id=$${args.length}`); }
  if (opts.from) { args.push(opts.from); where.push(`dl.due_on >= $${args.length}`); }
  if (opts.to) { args.push(opts.to); where.push(`dl.due_on <= $${args.length}`); }
  return d.select(`SELECT dl.*, c.first_name, c.last_name, p.street, t.side FROM deadlines dl JOIN transactions t ON t.id=dl.transaction_id JOIN clients c ON c.id=t.client_id LEFT JOIN properties p ON p.id=t.property_id WHERE ${where.join(' AND ')} ORDER BY dl.due_on, dl.due_time`, args);
}
export async function setDeadlineStatus(id: number, status: 'pending' | 'done' | 'waived' | 'missed'): Promise<void> { const d = await db(); await d.execute("UPDATE deadlines SET status=$1, updated_at=datetime('now') WHERE id=$2", [status, id]); }

/* ---------- tasks ---------- */
export async function addTask(t: Omit<TaskRow, 'id' | 'done_at' | 'snoozed_until'>): Promise<number> {
  const d = await db();
  const r = await d.execute('INSERT INTO tasks(transaction_id,client_id,cadence_step_id,deadline_id,kind,title,body,due_on,due_time,priority) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [t.transaction_id, t.client_id, t.cadence_step_id, t.deadline_id, t.kind, t.title, t.body, t.due_on, t.due_time, t.priority]);
  return r.lastInsertId as number;
}
export async function listTasks(opts: { transactionId?: number; dueThrough?: string; includeDone?: boolean } = {}): Promise<Array<TaskRow & { first_name: string | null; last_name: string | null; street: string | null }>> {
  const d = await db();
  const where: string[] = []; const args: unknown[] = [];
  if (!opts.includeDone) where.push('t.done_at IS NULL');
  if (opts.transactionId) { args.push(opts.transactionId); where.push(`t.transaction_id=$${args.length}`); }
  if (opts.dueThrough) { args.push(opts.dueThrough); where.push(`t.due_on <= $${args.length}`); }
  return d.select(`SELECT t.*, c.first_name, c.last_name, p.street FROM tasks t LEFT JOIN transactions tx ON tx.id=t.transaction_id LEFT JOIN clients c ON c.id=coalesce(t.client_id, tx.client_id) LEFT JOIN properties p ON p.id=tx.property_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.due_on, t.due_time`, args);
}
export async function completeTask(id: number, done = true): Promise<void> { const d = await db(); await d.execute("UPDATE tasks SET done_at = CASE WHEN $1 THEN datetime('now') ELSE NULL END WHERE id=$2", [done ? 1 : 0, id]); }

/* ---------- packet templates (editable; snapshot-copied onto each transaction) ---------- */
export interface PacketTemplate { id: number; code: string; name: string; side: 'seller' | 'buyer' | 'closing' }
export interface PacketTemplateItem {
  id: number; template_id: number; position: number; doc_kind: string; label: string; required_when: string | null; form_code: string | null; note: string | null;
  form_id: number | null; source: 'exhibit_b' | 'cory' | 'ai'; reason: string | null;
  form_name?: string | null; form_path?: string | null; form_revision?: string | null; form_source?: string | null;
}
export async function listPacketTemplates(): Promise<PacketTemplate[]> { const d = await db(); return d.select<PacketTemplate[]>("SELECT * FROM packet_templates ORDER BY CASE side WHEN 'seller' THEN 0 WHEN 'buyer' THEN 1 ELSE 2 END"); }
export async function listPacketTemplateItems(templateId: number): Promise<PacketTemplateItem[]> {
  const d = await db();
  return d.select<PacketTemplateItem[]>('SELECT pi.*, f.name AS form_name, f.path AS form_path, f.revision AS form_revision, f.source AS form_source FROM packet_items pi LEFT JOIN forms f ON f.id = pi.form_id WHERE pi.template_id=$1 ORDER BY pi.position', [templateId]);
}
export async function addPacketTemplateItem(t: { template_id: number; doc_kind: string; label: string; required_when?: string | null; form_code?: string | null; form_id?: number | null; source?: 'exhibit_b' | 'cory' | 'ai'; reason?: string | null; after_position?: number | null }): Promise<number> {
  const d = await db();
  const max = (await d.select<{ m: number | null }[]>('SELECT MAX(position) AS m FROM packet_items WHERE template_id=$1', [t.template_id]))[0]?.m ?? 0;
  const pos = t.after_position != null ? t.after_position + 1 : max + 1;
  if (t.after_position != null) await d.execute('UPDATE packet_items SET position = position + 1 WHERE template_id=$1 AND position >= $2', [t.template_id, pos]);
  const r = await d.execute('INSERT INTO packet_items(template_id, position, doc_kind, label, required_when, form_code, form_id, source, reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [t.template_id, pos, t.doc_kind, t.label, t.required_when ?? 'always', t.form_code ?? null, t.form_id ?? null, t.source ?? 'cory', t.reason ?? null]);
  return r.lastInsertId as number;
}
export async function updatePacketTemplateItem(id: number, patch: Partial<Pick<PacketTemplateItem, 'label' | 'required_when' | 'form_id' | 'doc_kind' | 'reason' | 'note'>>): Promise<void> {
  const d = await db();
  const keys = updatableKeys('packet_items', patch); if (!keys.length) return;
  await d.execute(`UPDATE packet_items SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(', ')} WHERE id=$${keys.length + 1}`, [...keys.map(k => (patch as Record<string, unknown>)[k]), id]);
}
export async function removePacketTemplateItem(id: number): Promise<void> {
  const d = await db();
  const row = (await d.select<{ template_id: number; position: number }[]>('SELECT template_id, position FROM packet_items WHERE id=$1', [id]))[0];
  if (!row) return;
  await d.execute('DELETE FROM packet_items WHERE id=$1', [id]);
  await d.execute('UPDATE packet_items SET position = position - 1 WHERE template_id=$1 AND position > $2', [row.template_id, row.position]);
}
export async function movePacketTemplateItem(id: number, dir: -1 | 1): Promise<void> {
  const d = await db();
  const row = (await d.select<{ template_id: number; position: number }[]>('SELECT template_id, position FROM packet_items WHERE id=$1', [id]))[0];
  if (!row) return;
  const other = (await d.select<{ id: number; position: number }[]>('SELECT id, position FROM packet_items WHERE template_id=$1 AND position=$2', [row.template_id, row.position + dir]))[0];
  if (!other) return;
  await d.execute('UPDATE packet_items SET position=$1 WHERE id=$2', [other.position, id]);
  await d.execute('UPDATE packet_items SET position=$1 WHERE id=$2', [row.position, other.id]);
}
/** Put a template back to the Exhibit B seed (drops Cory's and the AI's additions). */
export async function resetPacketTemplate(templateId: number, items: Array<{ doc_kind: string; label: string; required_when?: string | null; form_code?: string | null }>): Promise<void> {
  const d = await db();
  await d.execute('DELETE FROM packet_items WHERE template_id=$1', [templateId]);
  let pos = 1;
  for (const it of items) await d.execute('INSERT INTO packet_items(template_id, position, doc_kind, label, required_when, form_code, source) VALUES($1,$2,$3,$4,$5,$6,\'exhibit_b\')', [templateId, pos++, it.doc_kind, it.label, it.required_when ?? 'always', it.form_code ?? null]);
}

export async function instantiatePacket(transactionId: number, side: 'seller' | 'buyer', opts: { pre1978?: boolean; hoa?: boolean } = {}): Promise<void> {
  const d = await db();
  const items = await d.select<Array<{ position: number; doc_kind: string; label: string; required_when: string | null; form_code: string | null; form_id: number | null }>>(
    'SELECT pi.position, pi.doc_kind, pi.label, pi.required_when, pi.form_code, pi.form_id FROM packet_items pi JOIN packet_templates pt ON pt.id=pi.template_id WHERE pt.code=$1 ORDER BY pi.position', [side]);
  for (const it of items) {
    const na = (it.required_when === 'pre1978' && opts.pre1978 === false) || (it.required_when === 'hoa' && opts.hoa === false);
    await d.execute('INSERT INTO transaction_packet_items(transaction_id,position,doc_kind,label,required_when,form_code,form_id,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [transactionId, it.position, it.doc_kind, it.label, it.required_when, it.form_code, it.form_id, na ? 'not_applicable' : 'missing']);
  }
}
export async function listPacket(transactionId: number): Promise<PacketItemRow[]> { const d = await db(); return d.select<PacketItemRow[]>('SELECT tpi.*, f.path AS form_path, f.name AS form_name FROM transaction_packet_items tpi LEFT JOIN forms f ON f.id = tpi.form_id WHERE tpi.transaction_id=$1 ORDER BY tpi.position', [transactionId]); }
export async function setPacketItem(id: number, status: string, documentId?: number | null): Promise<void> { const d = await db(); await d.execute("UPDATE transaction_packet_items SET status=$1, document_id=coalesce($2, document_id), updated_at=datetime('now') WHERE id=$3", [status, documentId ?? null, id]); }
export async function markPacketItemByKind(transactionId: number, docKind: string, documentId: number): Promise<void> { const d = await db(); await d.execute("UPDATE transaction_packet_items SET status='received', document_id=$1, updated_at=datetime('now') WHERE transaction_id=$2 AND doc_kind=$3 AND status IN ('missing','not_applicable')", [documentId, transactionId, docKind]); }

/* ---------- misc ---------- */
export async function logEvent(name: string, subjectType?: string, subjectId?: number, payload?: unknown): Promise<void> {
  const d = await db(); await d.execute('INSERT INTO events(name,subject_type,subject_id,payload_json) VALUES($1,$2,$3,$4)', [name, subjectType ?? null, subjectId ?? null, payload ? JSON.stringify(payload) : null]);
}
export async function getSettings(): Promise<Record<string, string>> {
  const d = await db(); const rows = await d.select<{ key: string; value: string }[]>('SELECT key, value FROM settings'); return Object.fromEntries(rows.map(r => [r.key, r.value]));
}
export async function listCadenceSteps(code: string): Promise<Array<{ id: number; day_offset: number; anchor: string; kind: string; title: string; body_template: string | null; weekdays_only: number }>> {
  const d = await db();
  return d.select('SELECT s.id, s.day_offset, s.anchor, s.kind, s.title, s.body_template, c.weekdays_only FROM cadence_steps s JOIN cadences c ON c.id=s.cadence_id WHERE c.code=$1 ORDER BY s.position', [code]);
}

/* ---------- daily engine: log, ideas, touches, posts, open houses, enrollments, settings ---------- */
export interface DailyLogRow { on_date: string; item_key: string; done_at: string | null; count: number; note: string | null }
export async function dailyLog(date: string): Promise<Record<string, DailyLogRow>> {
  const d = await db(); const rows = await d.select<DailyLogRow[]>('SELECT * FROM daily_log WHERE on_date=$1', [date]);
  return Object.fromEntries(rows.map(r => [r.item_key, r]));
}
export async function setDailyItem(date: string, key: string, patch: { done?: boolean; count?: number; note?: string | null }): Promise<void> {
  const d = await db();
  await d.execute('INSERT OR IGNORE INTO daily_log(on_date, item_key) VALUES ($1, $2)', [date, key]);
  if (patch.done !== undefined) await d.execute("UPDATE daily_log SET done_at = CASE WHEN $1 THEN datetime('now') ELSE NULL END WHERE on_date=$2 AND item_key=$3", [patch.done ? 1 : 0, date, key]);
  if (patch.count !== undefined) await d.execute('UPDATE daily_log SET count=$1 WHERE on_date=$2 AND item_key=$3', [patch.count, date, key]);
  if (patch.note !== undefined) await d.execute('UPDATE daily_log SET note=$1 WHERE on_date=$2 AND item_key=$3', [patch.note, date, key]);
}
/** Dates on which every core item was done (for the streak). coreKeys = the 11 non-negotiable keys. */
export async function coreCompleteDates(coreKeys: string[], sinceDays = 400): Promise<Set<string>> {
  const d = await db();
  const rows = await d.select<{ on_date: string; c: number }[]>(`SELECT on_date, COUNT(*) AS c FROM daily_log WHERE done_at IS NOT NULL AND item_key IN (${coreKeys.map((_, i) => `$${i + 2}`).join(',')}) AND on_date >= $1 GROUP BY on_date`, [addDaysIso(today(), -sinceDays), ...coreKeys]);
  return new Set(rows.filter(r => r.c >= coreKeys.length).map(r => r.on_date));
}

export interface IdeaRow { id: number; text: string; hook: string | null; status: 'queued' | 'built' | 'posted' | 'dropped'; captured_at: string; built_on: string | null; posted_on: string | null; platform: string | null }
export async function listIdeas(status?: string): Promise<IdeaRow[]> { const d = await db(); return status ? d.select<IdeaRow[]>('SELECT * FROM ideas WHERE status=$1 ORDER BY captured_at', [status]) : d.select<IdeaRow[]>('SELECT * FROM ideas ORDER BY captured_at DESC LIMIT 200'); }
export async function addIdea(text: string): Promise<number> { const d = await db(); const r = await d.execute('INSERT INTO ideas(text) VALUES ($1)', [text]); return r.lastInsertId as number; }
export async function updateIdea(id: number, patch: Partial<Pick<IdeaRow, 'hook' | 'status' | 'built_on' | 'posted_on' | 'platform' | 'text'>>): Promise<void> {
  const d = await db(); const keys = updatableKeys('ideas', patch); if (!keys.length) return;
  await d.execute(`UPDATE ideas SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(', ')} WHERE id=$${keys.length + 1}`, [...keys.map(k => (patch as Record<string, unknown>)[k]), id]);
}

export interface TouchRow { id: number; client_id: number | null; on_date: string; channel: string; kind: 'gratitude' | 'business'; who: string | null; note: string | null }
export async function listTouches(date: string): Promise<Array<TouchRow & { first_name: string | null; last_name: string | null }>> { const d = await db(); return d.select('SELECT t.*, c.first_name, c.last_name FROM touches t LEFT JOIN clients c ON c.id=t.client_id WHERE t.on_date=$1 ORDER BY t.id', [date]); }
export async function addTouch(t: { client_id?: number | null; on_date: string; channel: string; kind: 'gratitude' | 'business'; who?: string | null; note?: string | null }): Promise<number> {
  const d = await db();
  const r = await d.execute('INSERT INTO touches(client_id, on_date, channel, kind, who, note) VALUES ($1,$2,$3,$4,$5,$6)', [t.client_id ?? null, t.on_date, t.channel, t.kind, t.who ?? null, t.note ?? null]);
  if (t.client_id) await d.execute('UPDATE clients SET last_touch_on=$1 WHERE id=$2', [t.on_date, t.client_id]);
  return r.lastInsertId as number;
}
export async function removeTouch(id: number): Promise<void> { const d = await db(); await d.execute('DELETE FROM touches WHERE id=$1', [id]); }

export async function addPost(p: { on_date: string; platform: string; kind: 'reel' | 'post' | 'story' | 'marketplace' | 'friend_add'; idea_id?: number | null; face?: boolean; note?: string | null; count?: number }): Promise<void> {
  const d = await db();
  for (let i = 0; i < (p.count ?? 1); i++) await d.execute('INSERT INTO posts(on_date, platform, kind, idea_id, face, note) VALUES ($1,$2,$3,$4,$5,$6)', [p.on_date, p.platform, p.kind, p.idea_id ?? null, p.face ? 1 : 0, p.note ?? null]);
}
export async function postCounts(date: string): Promise<Record<string, { posts: number; adds: number; face: number }>> {
  const d = await db();
  const rows = await d.select<{ platform: string; kind: string; n: number; f: number }[]>('SELECT platform, kind, COUNT(*) AS n, SUM(face) AS f FROM posts WHERE on_date=$1 GROUP BY platform, kind', [date]);
  const out: Record<string, { posts: number; adds: number; face: number }> = {};
  for (const r of rows) { out[r.platform] ??= { posts: 0, adds: 0, face: 0 }; if (r.kind === 'friend_add') out[r.platform].adds += r.n; else { out[r.platform].posts += r.n; out[r.platform].face += r.f ?? 0; } }
  return out;
}

export interface OpenHouseRow { id: number; transaction_id: number; on_date: string; start_time: string; end_time: string; status: 'planned' | 'posted' | 'held' | 'cancelled' | 'cleaned'; marketplace_task_id: number | null; cleanup_task_id: number | null; first_name?: string; last_name?: string; street?: string | null; city?: string | null; client_id?: number }
export async function listOpenHouses(opts: { from?: string; to?: string } = {}): Promise<OpenHouseRow[]> {
  const d = await db();
  return d.select<OpenHouseRow[]>(`SELECT oh.*, c.first_name, c.last_name, c.id AS client_id, p.street, p.city FROM open_houses oh JOIN transactions t ON t.id=oh.transaction_id JOIN clients c ON c.id=t.client_id LEFT JOIN properties p ON p.id=t.property_id WHERE oh.on_date >= $1 AND oh.on_date <= $2 AND oh.status <> 'cancelled' ORDER BY oh.on_date, oh.start_time`, [opts.from ?? '0000', opts.to ?? '9999']);
}
export async function addOpenHouse(oh: { transaction_id: number; on_date: string; start_time: string; end_time: string; marketplace_task_id?: number | null; cleanup_task_id?: number | null }): Promise<number> {
  const d = await db();
  const r = await d.execute('INSERT INTO open_houses(transaction_id, on_date, start_time, end_time, marketplace_task_id, cleanup_task_id) VALUES ($1,$2,$3,$4,$5,$6)', [oh.transaction_id, oh.on_date, oh.start_time, oh.end_time, oh.marketplace_task_id ?? null, oh.cleanup_task_id ?? null]);
  return r.lastInsertId as number;
}
export async function setOpenHouseStatus(id: number, status: OpenHouseRow['status']): Promise<void> { const d = await db(); await d.execute('UPDATE open_houses SET status=$1 WHERE id=$2', [status, id]); }
export async function cancelTask(id: number | null | undefined): Promise<void> { if (!id) return; const d = await db(); await d.execute('DELETE FROM tasks WHERE id=$1 AND done_at IS NULL', [id]); }

export interface EnrollmentRow { id: number; client_id: number; cadence_id: number; started_on: string; paused_at: string | null; completed_at: string | null; cancelled_at: string | null; code?: string; name?: string }
export async function listEnrollments(clientId: number): Promise<EnrollmentRow[]> { const d = await db(); return d.select<EnrollmentRow[]>('SELECT e.*, c.code, c.name FROM cadence_enrollments e JOIN cadences c ON c.id=e.cadence_id WHERE e.client_id=$1 ORDER BY e.id DESC', [clientId]); }
export async function getCadenceId(code: string): Promise<number | null> { const d = await db(); const r = await d.select<{ id: number }[]>('SELECT id FROM cadences WHERE code=$1', [code]); return r[0]?.id ?? null; }
export async function addEnrollment(clientId: number, cadenceId: number, startedOn: string): Promise<number> { const d = await db(); const r = await d.execute('INSERT INTO cadence_enrollments(client_id, cadence_id, started_on) VALUES ($1,$2,$3)', [clientId, cadenceId, startedOn]); return r.lastInsertId as number; }
/** Pause a drip: delete its not-yet-done future tasks for this client (the human takes over) and stamp the enrollment. */
export async function pauseEnrollment(id: number): Promise<number> {
  const d = await db();
  const e = (await d.select<EnrollmentRow[]>('SELECT * FROM cadence_enrollments WHERE id=$1', [id]))[0]; if (!e) return 0;
  const r = await d.execute('DELETE FROM tasks WHERE client_id=$1 AND done_at IS NULL AND cadence_step_id IN (SELECT id FROM cadence_steps WHERE cadence_id=$2) AND due_on > $3', [e.client_id, e.cadence_id, today()]);
  await d.execute("UPDATE cadence_enrollments SET paused_at=datetime('now') WHERE id=$1", [id]);
  return r.rowsAffected;
}
export async function setSetting(key: string, value: string): Promise<void> { const d = await db(); await d.execute("INSERT INTO settings(key, value) VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')", [key, value]); }

/* ---------- google calendar links + intake sections ---------- */
export interface CalendarLink { id: number; kind: string; ref_id: number; google_event_id: string; calendar_id: string; fingerprint: string | null; synced_at: string }
export async function getCalendarLink(kind: string, refId: number): Promise<CalendarLink | null> { const d = await db(); const r = await d.select<CalendarLink[]>('SELECT * FROM calendar_links WHERE kind=$1 AND ref_id=$2', [kind, refId]); return r[0] ?? null; }
export async function listCalendarLinks(): Promise<CalendarLink[]> { const d = await db(); return d.select<CalendarLink[]>('SELECT * FROM calendar_links'); }
export async function clearCalendarLinks(): Promise<void> { const d = await db(); await d.execute('DELETE FROM calendar_links'); }
export async function deleteCalendarLink(kind: string, refId: number): Promise<void> { const d = await db(); await d.execute('DELETE FROM calendar_links WHERE kind=$1 AND ref_id=$2', [kind, refId]); }
export async function setCalendarLink(kind: string, refId: number, eventId: string, calendarId: string, fingerprint: string): Promise<void> {
  const d = await db();
  await d.execute("INSERT INTO calendar_links(kind, ref_id, google_event_id, calendar_id, fingerprint) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(kind, ref_id) DO UPDATE SET google_event_id=excluded.google_event_id, calendar_id=excluded.calendar_id, fingerprint=excluded.fingerprint, synced_at=datetime('now')", [kind, refId, eventId, calendarId, fingerprint]);
}
export interface SectionRow { id: number; transaction_id: number; section: string; author: 'cory' | 'client' | 'ai'; body_md: string; updated_at: string }
export const SECTIONS: Array<[string, string]> = [['motivation', 'Motivation'], ['timeline', 'Timeline'], ['property', 'Property facts'], ['financing', 'Financing'], ['showing', 'Showing instructions'], ['repairs', 'Repairs / credits'], ['closing', 'Closing logistics'], ['notes', 'Notes']];
export async function listSections(txId: number): Promise<SectionRow[]> { const d = await db(); return d.select<SectionRow[]>('SELECT * FROM intake_sections WHERE transaction_id=$1 ORDER BY section, author', [txId]); }
export async function saveSection(txId: number, section: string, author: 'cory' | 'client' | 'ai', body: string): Promise<void> {
  const d = await db();
  await d.execute("INSERT INTO intake_sections(transaction_id, section, author, body_md) VALUES ($1,$2,$3,$4) ON CONFLICT(transaction_id, section, author) DO UPDATE SET body_md=excluded.body_md, updated_at=datetime('now')", [txId, section, author, body]);
}
export async function setSmsConsent(clientId: number, ok: boolean): Promise<void> { const d = await db(); await d.execute("UPDATE clients SET sms_consent=$1, sms_consent_at=CASE WHEN $1 THEN datetime('now') ELSE NULL END WHERE id=$2", [ok ? 1 : 0, clientId]); }
/** Weekly scorecard counts (Mon..Sun window containing `date`). */
export async function weekScorecard(from: string, to: string): Promise<{ touches: number; gratitude: number; posts: number; face: number; leads: number; listings_taken: number; under_contract: number; closed: number; price_reviews: number; core_days: number }> {
  const d = await db();
  const one = async (sql: string, args: unknown[]) => (await d.select<{ c: number }[]>(sql, args))[0]?.c ?? 0;
  return {
    touches: await one('SELECT COUNT(*) AS c FROM touches WHERE on_date BETWEEN $1 AND $2', [from, to]),
    gratitude: await one("SELECT COUNT(*) AS c FROM touches WHERE on_date BETWEEN $1 AND $2 AND kind='gratitude'", [from, to]),
    posts: await one("SELECT COUNT(*) AS c FROM posts WHERE on_date BETWEEN $1 AND $2 AND kind <> 'friend_add'", [from, to]),
    face: await one("SELECT COUNT(*) AS c FROM posts WHERE on_date BETWEEN $1 AND $2 AND kind <> 'friend_add' AND face=1", [from, to]),
    leads: await one("SELECT COUNT(*) AS c FROM clients WHERE lead_received_at BETWEEN $1 AND $2", [from, to]),
    listings_taken: await one("SELECT COUNT(*) AS c FROM transactions WHERE side='seller' AND agreement_signed_on BETWEEN $1 AND $2", [from, to]),
    under_contract: await one("SELECT COUNT(*) AS c FROM transactions WHERE acceptance_on BETWEEN $1 AND $2", [from, to]),
    closed: await one("SELECT COUNT(*) AS c FROM transactions WHERE closed_on BETWEEN $1 AND $2", [from, to]),
    price_reviews: await one("SELECT COUNT(*) AS c FROM tasks WHERE done_at IS NOT NULL AND title LIKE 'Tuesday market review%' AND due_on BETWEEN $1 AND $2", [from, to]),
    core_days: await one("SELECT COUNT(*) AS c FROM (SELECT on_date FROM daily_log WHERE done_at IS NOT NULL AND on_date BETWEEN $1 AND $2 GROUP BY on_date HAVING COUNT(*) >= 11)", [from, to]),
  };
}
/** One deadline row (automations add clocks one at a time; intake uses replaceDeadlines). */
export async function addDeadline(d: Omit<DeadlineRow, 'id' | 'superseded_by'>): Promise<number> {
  const db_ = await db();
  const r = await db_.execute('INSERT INTO deadlines(transaction_id,type,label,due_on,due_time,basis,source_document_id,source_page,confidence,status,reminder_on,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [d.transaction_id, d.type, d.label, d.due_on, d.due_time, d.basis, d.source_document_id, d.source_page, d.confidence, d.status, d.reminder_on, d.notes]);
  return r.lastInsertId as number;
}
export async function setTaskBody(id: number, body: string): Promise<void> { const d = await db(); await d.execute('UPDATE tasks SET body=$1 WHERE id=$2', [body, id]); }
export async function completeDeadlinesOfBasis(transactionId: number, basis: string): Promise<number> { const d = await db(); const r = await d.execute("UPDATE deadlines SET status='done', updated_at=datetime('now') WHERE transaction_id=$1 AND basis=$2 AND status='pending'", [transactionId, basis]); return r.rowsAffected; }
export async function updateDocumentFile(id: number, sha256: string, bytes: number): Promise<void> { const d = await db(); await d.execute("UPDATE documents SET sha256=$1, bytes=$2, uploaded_at=datetime('now') WHERE id=$3", [sha256, bytes, id]); }

/* ---------- google drive uploads + google contacts links (migration 0006; ids and links only, never tokens) ---------- */
export interface DriveFileRow { path: string; sha256: string; google_file_id: string; web_view_link: string; folder_id: string | null; shared: string[] }
type DriveFileRaw = Omit<DriveFileRow, 'shared'> & { shared_json: string };
function driveRow(r: DriveFileRaw): DriveFileRow { const { shared_json, ...rest } = r; let shared: string[] = []; try { shared = JSON.parse(shared_json || '[]'); } catch { /* keep [] */ } return { ...rest, shared }; }
export async function getDriveFile(path: string): Promise<DriveFileRow | null> { const d = await db(); const r = await d.select<DriveFileRaw[]>('SELECT * FROM google_drive_files WHERE path=$1', [path]); return r[0] ? driveRow(r[0]) : null; }
export async function listDriveFiles(): Promise<Record<string, DriveFileRow>> { const d = await db(); const rows = await d.select<DriveFileRaw[]>('SELECT * FROM google_drive_files'); return Object.fromEntries(rows.map(r => [r.path, driveRow(r)])); }
export async function setDriveFile(f: DriveFileRow): Promise<void> {
  const d = await db();
  await d.execute("INSERT INTO google_drive_files(path, sha256, google_file_id, web_view_link, folder_id, shared_json) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(path) DO UPDATE SET sha256=excluded.sha256, google_file_id=excluded.google_file_id, web_view_link=excluded.web_view_link, folder_id=excluded.folder_id, shared_json=excluded.shared_json, uploaded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')", [f.path, f.sha256, f.google_file_id, f.web_view_link, f.folder_id, JSON.stringify(f.shared)]);
}
export interface GoogleContactRow { client_id: number; resource_name: string; fingerprint: string; synced_at: string }
export async function getGoogleContact(clientId: number): Promise<GoogleContactRow | null> { const d = await db(); const r = await d.select<GoogleContactRow[]>('SELECT * FROM google_contacts WHERE client_id=$1', [clientId]); return r[0] ?? null; }
export async function setGoogleContact(clientId: number, resourceName: string, fingerprint: string): Promise<void> {
  const d = await db();
  await d.execute("INSERT INTO google_contacts(client_id, resource_name, fingerprint) VALUES ($1,$2,$3) ON CONFLICT(client_id) DO UPDATE SET resource_name=excluded.resource_name, fingerprint=excluded.fingerprint, synced_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')", [clientId, resourceName, fingerprint]);
}

/* ---------- gmail drafts the app made (migration 0007) ---------- */
export interface GmailDraftRow { key: string; draft_id: string; to_addr: string; subject: string; created_at: string }
export async function getGmailDraft(key: string): Promise<GmailDraftRow | null> { const d = await db(); const r = await d.select<GmailDraftRow[]>('SELECT * FROM google_gmail_drafts WHERE key=$1', [key]); return r[0] ?? null; }
export async function setGmailDraft(key: string, draftId: string, to: string, subject: string): Promise<void> {
  const d = await db();
  await d.execute("INSERT INTO google_gmail_drafts(key, draft_id, to_addr, subject) VALUES ($1,$2,$3,$4) ON CONFLICT(key) DO UPDATE SET draft_id=excluded.draft_id, created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')", [key, draftId, to, subject]);
}

/* ---------- monitor: model runs with their verdicts, and what the confidence loop learned (migration 0008) ---------- */
export interface ModelRunRow { id: number; at: string; model: string; purpose: string; latency_ms: number | null; output_json: string | null; ok: number; grounding_score: number | null; ungrounded_json: string | null; input_sha: string | null; model_sha: string | null; passes: number | null; strategy: string | null }
export async function logModelRun(r: { purpose: string; latencyMs: number; ok: boolean; output: unknown; groundingScore?: number | null; ungrounded?: string[]; inputSha?: string | null; passes?: number | null; strategy?: string | null; model?: string }): Promise<void> {
  const d = await db();
  await d.execute('INSERT INTO model_runs(model, purpose, latency_ms, output_json, ok, grounding_score, ungrounded_json, input_sha, passes, strategy) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [r.model ?? 'qwen3-4b-instruct-q4km', r.purpose, Math.round(r.latencyMs), JSON.stringify(r.output ?? null), r.ok ? 1 : 0, r.groundingScore ?? null, r.ungrounded ? JSON.stringify(r.ungrounded) : null, r.inputSha ?? null, r.passes ?? null, r.strategy ?? null]);
}
export async function listModelRuns(limit = 100): Promise<ModelRunRow[]> { const d = await db(); return d.select<ModelRunRow[]>('SELECT * FROM model_runs ORDER BY id DESC LIMIT $1', [limit]); }
export interface LessonRow { id: number; job: string; failure_signature: string; strategy_failed: string; strategy_worked: string | null; hint: string; count: number; updated_at: string }
export async function listLessons(job?: string): Promise<LessonRow[]> { const d = await db(); return job ? d.select<LessonRow[]>('SELECT * FROM agent_lessons WHERE job=$1 ORDER BY count DESC, updated_at DESC LIMIT 20', [job]) : d.select<LessonRow[]>('SELECT * FROM agent_lessons ORDER BY job, count DESC'); }
export async function saveLesson(l: { job: string; failure_signature: string; strategy_failed: string; strategy_worked: string | null; hint: string }): Promise<void> {
  const d = await db();
  await d.execute("INSERT INTO agent_lessons(job, failure_signature, strategy_failed, strategy_worked, hint) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(job, failure_signature) DO UPDATE SET count=count+1, strategy_failed=excluded.strategy_failed, strategy_worked=coalesce(excluded.strategy_worked, agent_lessons.strategy_worked), hint=CASE WHEN excluded.hint<>'' THEN excluded.hint ELSE agent_lessons.hint END, updated_at=datetime('now')", [l.job, l.failure_signature, l.strategy_failed, l.strategy_worked, l.hint]);
}
export async function forgetLessons(job?: string): Promise<void> { const d = await db(); if (job) await d.execute('DELETE FROM agent_lessons WHERE job=$1', [job]); else await d.execute('DELETE FROM agent_lessons'); }
/** The two read-only views from migration 0008 ("local SQL"): one query each for reports, tools and the Audit page. */
export interface AtRiskRow { kind: 'deadline' | 'task'; ref_id: number; transaction_id: number | null; client_id: number | null; last_name: string | null; first_name: string | null; street: string | null; side: TxSide | null; title: string; due_on: string; due_time: string | null; detail: string | null }
export async function atRiskRows(): Promise<AtRiskRow[]> { const d = await db(); return d.select<AtRiskRow[]>('SELECT * FROM v_at_risk ORDER BY due_on, due_time'); }
export interface PacketGapRow { item_id: number; transaction_id: number; client_id: number; last_name: string; first_name: string; street: string | null; side: TxSide; tx_status: TxStatus; agreement_signed_on: string | null; acceptance_on: string | null; broker_submitted_on: string | null; label: string; doc_kind: string; required_when: string | null; position: number }
export async function packetGapRows(): Promise<PacketGapRow[]> { const d = await db(); return d.select<PacketGapRow[]>('SELECT * FROM v_packet_gaps ORDER BY transaction_id, position'); }
