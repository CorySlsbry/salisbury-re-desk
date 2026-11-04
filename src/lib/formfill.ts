/**
 * Prefill the packet's forms with what intake already knows. Flat UAR forms get typed values in their blanks
 * (templates/form-fills.json zones, measured per revision); AcroForm state forms get field values. Output is a
 * DRAFT in the client folder, never signed, never dated on a signature line, and the packet item stays "missing"
 * until a signed copy is filed.
 */
import fills from '../../templates/form-fills.json';
import { doc, native } from './native';
import * as repo from './repo';
import { listForms, type FormRow } from './forms';
import { friendlyError } from './errors';

export interface FillData {
  seller_names?: string; buyer_names?: string; client_names: string; property: string; street?: string; city?: string; zip?: string; county?: string;
  company: string; agent: string; agent_phone?: string; agent_email?: string; client_phone?: string; client_email?: string; today: string;
  hoa_name?: string; fee_pct?: string; coop_offer_pct?: string; end_date?: string;
}
interface FillSpec { match: string; revision?: string; source?: string; side: string[]; doc_kind: string; folder: string; only_when?: string; stamp?: Array<{ page: number; box: [number, number, number, number]; value: string }>; fields?: Record<string, string> }

function render(t: string, d: FillData): string { return t.replace(/\{\{(\w+)\}\}/g, (_, k) => ((d as unknown as Record<string, string | undefined>)[k] ?? '')).replace(/\s+\/\s*$/, '').trim(); }

export function fillSpecFor(form: FormRow, side: 'seller' | 'buyer'): FillSpec | null {
  for (const f of fills.forms as FillSpec[]) {
    if (!f.side.includes(side)) continue;
    if (f.source && f.source !== form.source) continue;
    if (!new RegExp(f.match, 'i').test(`${form.name} (rev ${form.revision ?? ''})`)) continue;
    if (f.revision && form.revision && f.revision !== form.revision) continue; // measured on another revision: do not guess
    return f;
  }
  return null;
}

/** Fill every packet item that has a linked form and a fill spec. conditions: pre1978 / hoa known? */
export async function prefillPacket(txId: number, side: 'seller' | 'buyer', folder: string, data: FillData, cond: { pre1978?: boolean | null; hoa?: boolean | null }, onStep?: (s: string) => void): Promise<Array<{ item: string; path: string }>> {
  const forms = await listForms();
  const items = await repo.listPacket(txId);
  const out: Array<{ item: string; path: string }> = [];
  for (const it of items) {
    if (!it.form_id) continue;
    const form = forms.find(f => f.id === it.form_id); if (!form) continue;
    const spec = fillSpecFor(form, side); if (!spec) continue;
    if (spec.only_when === 'manual') continue;
    if (spec.only_when === 'pre1978' && cond.pre1978 === false) continue;
    if (spec.only_when === 'hoa' && cond.hoa === false) continue;
    onStep?.(`Prefilling ${form.name}`);
    const outPath = `${folder}\\${spec.folder}\\${form.name.replace(/[<>:"/\\|?*]/g, '-')} - PREFILLED.pdf`;
    try {
      if (spec.stamp) await doc.stamp(form.path, outPath, spec.stamp.map(s => ({ page: s.page, box: s.box, text: render(s.value, data) })));
      else if (spec.fields) await doc.fill(form.path, outPath, Object.fromEntries(Object.entries(spec.fields).map(([k, v]) => [k, render(v, data)])), false);
      else continue;
      const [sha, bytes] = await native.sha256File(outPath);
      await repo.addDocument({ transaction_id: txId, client_id: null, kind: it.doc_kind, title: `${form.name} (prefilled draft)`, path: outPath, sha256: sha, pages: form.pages, bytes, form_id: form.id, signed: 0, signed_on: null, extracted_json: null, extraction_tier: null, reviewed_at: null, draft: 1, packet_item_id: it.id });
      out.push({ item: it.label, path: outPath });
    } catch (e) { await repo.logEvent('prefill.failed', 'transaction', txId, { form: form.name, error: String(e) }); }
  }
  if (out.length) await repo.logEvent('prefill.done', 'transaction', txId, { count: out.length });
  return out;
}

/** Client questionnaire: the intake sections as a fillable-by-hand PDF the seller or buyer can answer. */
export async function makeQuestionnaire(folder: string, side: 'seller' | 'buyer', clientNames: string, property: string, agent: string, company: string): Promise<string> {
  const q = side === 'seller'
    ? [['Motivation', 'Why are you selling, and what does a great outcome look like for you?'], ['Timeline', 'When do you need to be moved? Any dates that are fixed (new home, job, school)?'], ['Property', 'Age of roof, furnace, water heater; updates in the last 10 years; anything not working; HOA name and dues; solar (owned or leased)?'], ['Financing', 'Current lender(s) and approximate payoff; any liens, second loans, or HELOCs?'], ['Showings', 'Best days and times for showings; pets; alarm codes or lockbox preference; anything to protect?'], ['Repairs and credits', 'Anything you would rather credit than repair? Any known issues a buyer should hear from us first?'], ['Closing logistics', 'Where will you be at closing; who signs; forwarding address; keys, openers, codes to hand over?'], ['Notes', 'Anything else I should know?']]
    : [['Motivation', 'What is driving the move, and what would make this a win?'], ['Timeline', 'When do you want to be in? Lease end, job start, school dates?'], ['Must-haves', 'Areas, beds, baths, garage, yard, commute limits, schools.'], ['Financing', 'Lender name; pre-approval amount; down payment source; cash?'], ['Showings', 'Best days and times to tour; who needs to be there?'], ['Deal-breakers', 'What would make you walk away?'], ['Closing logistics', 'Where will you be at closing; who signs; move-in plan?'], ['Notes', 'Anything else I should know?']];
  const blocks = [
    { text: `${side === 'seller' ? 'Seller' : 'Buyer'} questionnaire`, size: 18, bold: true, gap: 2 },
    { text: `${clientNames}${property ? '  |  ' + property : ''}\n${agent}, ${company}  |  Equal Housing Opportunity`, size: 9.5, gap: 14 },
    { text: 'Fill in what you can and send it back, or we will walk through it together. Nothing here is a commitment.', size: 9.5, gap: 12 },
    ...q.flatMap(([h, p]) => [{ text: h, size: 11.5, bold: true, gap: 1 }, { text: p, size: 9.5, gap: 2 }, { text: '\n\n\n\n', size: 9.5, gap: 8 }]),
  ];
  const outPath = `${folder}\\00 Intake\\${side === 'seller' ? 'Seller' : 'Buyer'} questionnaire.pdf`;
  await doc.make(outPath, blocks);
  return outPath;
}

/** The "Prefill packet forms" button: build the fill data from what intake stored and run every mapped form. */
export async function prefillFromTransaction(txId: number, opts: { includeManual?: boolean } = {}, onStep?: (s: string) => void): Promise<{ filled: Array<{ item: string; path: string }>; skipped: string[] }> {
  const tx = await repo.getTransaction(txId); if (!tx) throw new Error('no transaction');
  const client = await repo.getClient(tx.client_id); if (!client?.folder_path) throw new Error('this client has no folder yet');
  const prop = tx.property_id ? await repo.getProperty(tx.property_id) : null;
  const s = await repo.getSettings();
  const names = `${client.first_name} ${client.last_name}${client.second_first_name ? ` and ${client.second_first_name} ${client.second_last_name ?? client.last_name}` : ''}`;
  const property = prop ? `${prop.street}${prop.city ? ', ' + prop.city : ''}${prop.state ? ', ' + (prop.state === 'UT' ? 'Utah' : prop.state) : ''}${prop.zip ? ' ' + prop.zip : ''}` : '';
  const data: FillData = {
    seller_names: tx.side === 'seller' ? names : '', buyer_names: tx.side === 'buyer' ? names : '', client_names: names, property, street: prop?.street, city: prop?.city ?? undefined, zip: prop?.zip ?? undefined, county: prop?.county ?? undefined,
    company: s.brokerage ?? 'Simple Choice Real Estate', agent: s.agent_name ?? 'Cory Salisbury', agent_phone: s.agent_phone, agent_email: s.agent_email, client_phone: client.phone ?? '', client_email: client.email ?? '', today: repo.today(),
    hoa_name: prop?.hoa_name ?? '', fee_pct: tx.commission_pct != null ? String(tx.commission_pct) : '', coop_offer_pct: '', end_date: tx.agreement_expires_on ?? '',
  };
  const forms = await listForms();
  const items = await repo.listPacket(txId);
  const existing = await repo.listDocuments(txId);
  const filled: Array<{ item: string; path: string }> = []; const skipped: string[] = [];
  for (const it of items) {
    if (!it.form_id) { skipped.push(`${it.label}: comes from outside the forms library (MLS, lender, title), nothing to prefill`); continue; }
    const form = forms.find(f => f.id === it.form_id); if (!form) continue;
    if (['listing_agreement', 'bba', 'repc'].includes(it.doc_kind)) { skipped.push(`${form.name}: ${it.doc_kind === 'repc' ? 'filled when you write the offer or receive one' : 'this is the signed agreement you uploaded'}`); continue; }
    const spec = fillSpecFor(form, tx.side); if (!spec) { skipped.push(`${form.name}: I do not have the blank positions for this revision yet, open it from the packet and fill by hand`); continue; }
    if (spec.only_when === 'manual' && !opts.includeManual) { skipped.push(`${form.name}: situational, use "+ situational forms" when this deal needs it`); continue; }
    if (spec.only_when === 'pre1978' && prop?.year_built && prop.year_built >= 1978) { skipped.push(`${form.name}: home built ${prop.year_built}, lead paint disclosure not required`); continue; }
    if (spec.only_when === 'hoa' && prop?.has_hoa === 0) { skipped.push(`${form.name}: property has no HOA`); continue; }
    onStep?.(`Prefilling ${form.name}`);
    const outPath = `${client.folder_path}\\${spec.folder}\\${form.name.replace(/[<>:"/\\|?*]/g, '-')} - PREFILLED.pdf`;
    try {
      if (spec.stamp) await doc.stamp(form.path, outPath, spec.stamp.map(x => ({ page: x.page, box: x.box, text: render(x.value, data) })));
      else if (spec.fields) await doc.fill(form.path, outPath, Object.fromEntries(Object.entries(spec.fields).map(([k, v]) => [k, render(v, data)])), false);
      else continue;
      const [sha, bytes] = await native.sha256File(outPath);
      const prior = existing.find(d => d.draft && d.path === outPath);
      if (prior) await repo.updateDocumentFile(prior.id, sha, bytes);
      else await repo.addDocument({ transaction_id: txId, client_id: null, kind: it.doc_kind, title: `${form.name} (prefilled draft)`, path: outPath, sha256: sha, pages: form.pages, bytes, form_id: form.id, signed: 0, signed_on: null, extracted_json: null, extraction_tier: null, reviewed_at: null, draft: 1, packet_item_id: it.id });
      filled.push({ item: it.label, path: outPath });
    } catch (e) { skipped.push(`${form.name}: ${friendlyError(e)}`); await repo.logEvent('prefill.failed', 'transaction', txId, { form: form.name, error: String(e) }); }
  }
  await repo.logEvent('prefill.button', 'transaction', txId, { filled: filled.length, skipped: skipped.length, manual: !!opts.includeManual });
  return { filled, skipped };
}
