/**
 * Auto-build a packet template from Pat's Exhibit B and the forms library.
 * Two layers: a deterministic rule table (what a seasoned Utah agent would pull for each Exhibit B line) and the
 * local model, which reads Exhibit B + the forms list and proposes additions with a reason each. Proposals are
 * shown to Cory and applied only on confirmation.
 */
import exhibitB from '../../templates/exhibit-b.json';
import { runWithConfidence, type Job } from './loop';
import { parseModelJson } from './modelJson';
import { PacketPicks } from './schemas';
import { dbLessons, confidenceBar } from './lessonStore';
import { logModelRun } from './repo';
import { chat, modelAvailable, modelFor } from './native';
import type { FormRow } from './forms';
import { listPacketTemplateItems, updatePacketTemplateItem, type PacketTemplateItem } from './repo';

export type PacketSide = 'seller' | 'buyer' | 'closing';
export interface Proposal {
  form_id: number; form_name: string; source: 'rule' | 'ai';
  doc_kind: string; satisfies: string;              // the Exhibit B line (or situational need) it covers
  required_when: 'always' | 'pre1978' | 'hoa' | 'under_contract' | 'if_applicable';
  reason: string; already: boolean;                 // already in the template
}

/** Rule table: Exhibit B line -> form title patterns. Order matters: first pattern is the primary form. */
const RULES: Record<PacketSide, Array<{ doc_kind: string; satisfies: string; required_when: Proposal['required_when']; forms: Array<{ rx: RegExp; reason: string }> }>> = {
  seller: [
    { doc_kind: 'listing_agreement', satisfies: exhibitB.seller[0], required_when: 'always', forms: [
      { rx: /^Exclusive Right to Sell Listing Agreement/i, reason: 'The listing agreement itself (UAR Form 8); carries the agency disclosure.' },
      { rx: /^Addendum to Exclusive Right to Sell Listing Agreement (and|&) Agency Disclosure \(rev/i, reason: 'Extensions, price changes and amendments to the listing.' },
      { rx: /^Cancellation and Termination of the Exclusive Right to Sell/i, reason: 'If the listing is cancelled early, the file needs the signed cancellation.' } ] },
    { doc_kind: 'spcd', satisfies: exhibitB.seller[1], required_when: 'always', forms: [
      { rx: /^Sellers Property Condition Disclosure \(rev/i, reason: 'Seller completes it personally (listing agreement 4).' },
      { rx: /^Addendum to Sellers Property Condition Disclosure/i, reason: 'Seller updates after the disclosure changes.' } ] },
    { doc_kind: 'agency_disclosure', satisfies: exhibitB.seller[2], required_when: 'if_applicable', forms: [
      { rx: /^Limited Agency Consent Agreement/i, reason: 'Only when you represent both sides (limited agency); otherwise the disclosure is inside the listing agreement.' } ] },
    { doc_kind: 'lead_paint', satisfies: exhibitB.seller[3], required_when: 'pre1978', forms: [
      { rx: /^Disclosure & Acknowledgement Regarding Lead-Based Paint/i, reason: 'Federal disclosure for homes built before 1978.' },
      { rx: /^Lead-Based Paint Addendum to REPC/i, reason: 'Goes with the contract on a pre-1978 home.' } ] },
    { doc_kind: 'compensation', satisfies: exhibitB.seller[4], required_when: 'always', forms: [
      { rx: /^Real Estate Brokerage Compensation Agreement \(rev/i, reason: 'Written offer of compensation to the buyer brokerage (listing agreement 2.3).' },
      { rx: /^Real Estate Brokerage Payment Addendum to REPC/i, reason: 'When compensation is paid through the REPC.' } ] },
    { doc_kind: 'mls_input', satisfies: exhibitB.seller[5], required_when: 'always', forms: [
      { rx: /^MLS Data Input Form[\s-]+Residential(?! Lease)/i, reason: 'UtahRealEstate.com residential data entry sheet (auto-fills from the listing when printed from URE).' },
      { rx: /^MLS Seller Notice to Classify Listing as Limited Marketing/i, reason: 'Delayed-marketing / limited-marketing election; the MLS Listing Exclusion is an online form on URE.' } ] },
    { doc_kind: 'wire_fraud', satisfies: exhibitB.seller[6], required_when: 'always', forms: [
      { rx: /^Wire Fraud Alert Disclosure/i, reason: 'Seller signs at listing (listing agreement 4).' } ] },
    { doc_kind: 'hoa', satisfies: exhibitB.seller[7], required_when: 'hoa', forms: [
      { rx: /^Request to Homeowner/i, reason: 'Orders the HOA documents, CC&Rs and disclosures.' } ] },
    { doc_kind: 'repc', satisfies: 'Executed purchase contract with all counteroffers and addenda (once under contract)', required_when: 'under_contract', forms: [
      { rx: /^Real Estate Purchase Contract \(rev/i, reason: 'The state REPC, as received from the buyer side.' },
      { rx: /^AddendumCounteroffer to REPC/i, reason: 'Counters and addenda.' },
      { rx: /^Sellers Notice to Buyer of Accepted Offer \(Multiple Offers/i, reason: 'Multiple-offer situations.' },
      { rx: /^Sellers Notice to Buyers of Multiple Offers/i, reason: 'Multiple-offer situations.' } ] },
    { doc_kind: 'emd_receipt', satisfies: 'Earnest money receipt and deposit confirmation (once under contract)', required_when: 'under_contract', forms: [
      { rx: /^Confirmation of Receipt of Earnest Money/i, reason: 'Proves the deposit was received.' } ] },
  ],
  buyer: [
    { doc_kind: 'bba', satisfies: exhibitB.buyer[0], required_when: 'always', forms: [
      { rx: /^Exclusive Buyer-Broker Agreement/i, reason: 'The buyer-broker agreement itself (UAR Form 6); carries the agency disclosure.' },
      { rx: /^Addendum to Exclusive Buyer-Broker Agreement (and|&) Agency Disclosure \(rev/i, reason: 'Extensions and amendments.' },
      { rx: /^Buyer Due Diligence Checklist/i, reason: 'Signed at the same time as the BBA (BBA 4(e)).' },
      { rx: /^Cancellation and Termination of the Exclusive Buyer-Broker/i, reason: 'If the agreement is cancelled early.' } ] },
    { doc_kind: 'agency_disclosure', satisfies: exhibitB.buyer[1], required_when: 'if_applicable', forms: [
      { rx: /^Limited Agency Consent Agreement/i, reason: 'Only when you represent both sides.' } ] },
    { doc_kind: 'repc', satisfies: exhibitB.buyer[2], required_when: 'under_contract', forms: [
      { rx: /^Real Estate Purchase Contract \(rev/i, reason: 'The state REPC.' },
      { rx: /^AddendumCounteroffer to REPC/i, reason: 'Counters and addenda.' },
      { rx: /^Buyers Notice of Withdrawal of Offer/i, reason: 'If the buyer withdraws before acceptance.' } ] },
    { doc_kind: 'preapproval', satisfies: exhibitB.buyer[3], required_when: 'always', forms: [
      { rx: /^Buyer Financial Information Sheet/i, reason: 'Utah form that documents the buyer\'s financial position alongside the lender letter.' } ] },
    { doc_kind: 'emd_receipt', satisfies: exhibitB.buyer[4], required_when: 'under_contract', forms: [
      { rx: /^Confirmation of Receipt of Earnest Money/i, reason: 'Proves the deposit was received.' },
      { rx: /^Deposit of Earnest Money with Title Insurance Company/i, reason: 'When the EMD goes to the title company instead of the brokerage.' } ] },
    { doc_kind: 'inspection', satisfies: exhibitB.buyer[5], required_when: 'under_contract', forms: [
      { rx: /^Resolution of Due Diligence Addendum/i, reason: 'Records the repair/credit resolution before the Due Diligence Deadline.' },
      { rx: /^Appraisal Addendum to REPC/i, reason: 'Records how a low appraisal was resolved.' },
      { rx: /^Buyers Notice of Cancellation of the Real Estate Purchase Contract/i, reason: 'If the buyer cancels under due diligence or financing.' } ] },
    { doc_kind: 'spcd_ack', satisfies: exhibitB.buyer[6], required_when: 'under_contract', forms: [
      { rx: /^Sellers Property Condition Disclosure \(rev/i, reason: 'The seller\'s disclosure, acknowledged (initialed) by the buyer.' } ] },
    { doc_kind: 'wire_fraud', satisfies: exhibitB.buyer[7], required_when: 'always', forms: [
      { rx: /^Wire Fraud Alert Disclosure/i, reason: 'Buyer signs at the BBA (BBA 4(e)).' } ] },
    { doc_kind: 'lead_paint', satisfies: 'Lead-based paint disclosure acknowledged (built before 1978)', required_when: 'pre1978', forms: [
      { rx: /^Disclosure & Acknowledgement Regarding Lead-Based Paint/i, reason: 'Federal disclosure for homes built before 1978.' },
      { rx: /^Lead-Based Paint Addendum to REPC/i, reason: 'Goes with the contract on a pre-1978 home.' } ] },
  ],
  closing: [
    { doc_kind: 'referral', satisfies: exhibitB.closing[2], required_when: 'if_applicable', forms: [
      { rx: /^Referral Agreement \(Broker to Broker\)/i, reason: 'When a referral fee is owed or received.' } ] },
    { doc_kind: 'cancellation', satisfies: exhibitB.closing[4], required_when: 'if_applicable', forms: [
      { rx: /^Buyers Notice of Cancellation of the Real Estate Purchase Contract/i, reason: 'Buyer-side cancellation.' },
      { rx: /^Sellers Notice of Cancellation of REPC/i, reason: 'Seller-side cancellation.' },
      { rx: /^Resolution of Earnest Money Dispute/i, reason: 'Mutual release of the earnest money.' } ] },
  ],
};

/** For a manual "+ add" from the library: what Exhibit B line does this form serve, if any? */
export function classifyForm(side: PacketSide, form: FormRow): { doc_kind: string; required_when: Proposal['required_when']; satisfies: string | null } {
  const title = `${form.name} (rev ${form.revision ?? ''})`;
  for (const rule of RULES[side]) for (const f of rule.forms) if (f.rx.test(title)) return { doc_kind: rule.doc_kind, required_when: rule.required_when, satisfies: rule.satisfies };
  return { doc_kind: 'other', required_when: 'if_applicable', satisfies: null };
}

export function proposeByRules(side: PacketSide, forms: FormRow[], existing: PacketTemplateItem[]): Proposal[] {
  const have = new Set(existing.map(i => i.form_id).filter((x): x is number => x != null));
  const out: Proposal[] = [];
  for (const rule of RULES[side]) {
    for (const f of rule.forms) {
      const hit = forms.filter(x => f.rx.test(`${x.name} (rev ${x.revision ?? ''})`)).sort((a, b) => (Date.parse(b.revision ?? '') || 0) - (Date.parse(a.revision ?? '') || 0))[0];
      if (!hit || out.some(o => o.form_id === hit.id)) continue;
      out.push({ form_id: hit.id, form_name: hit.name, source: 'rule', doc_kind: rule.doc_kind, satisfies: rule.satisfies, required_when: rule.required_when, reason: f.reason, already: have.has(hit.id) });
    }
  }
  return out;
}

const MAX_PICKS = 8;
const SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { picks: { type: 'array', maxItems: MAX_PICKS, items: { type: 'object', additionalProperties: false, properties: {
    form_number: { type: 'integer' }, situation: { type: 'string', maxLength: 40 }, required_when: { type: 'string', enum: ['pre1978', 'hoa', 'if_applicable'] }, reason: { type: 'string', maxLength: 110 } },
    required: ['form_number', 'situation', 'required_when', 'reason'] } } },
  required: ['picks'],
};
type Pick = { form_number: number; situation: string; required_when: Proposal['required_when']; reason: string };

/** The model sometimes runs out of tokens mid-array; keep every complete object that made it out. */
export function salvagePicks(raw: string): Pick[] {
  try { const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); if (Array.isArray(j.picks)) return j.picks; } catch { /* fall through */ }
  const out: Pick[] = [];
  const rx = /\{\s*"form_number"\s*:\s*(\d+)\s*,\s*"situation"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"required_when"\s*:\s*"(\w+)"\s*,\s*"reason"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(raw))) out.push({ form_number: Number(m[1]), situation: m[2], required_when: m[3] as Proposal['required_when'], reason: m[4] });
  return out;
}

/** Forms the model never needs to read for a packet (they cannot be an Exhibit B item). Shorter prompt = faster answer. */
const NOISE = /lease|rental|property management|how to complete|park city|covid|unrepresented buyer disclosure|inventory list|transaction documents receipt/i;

/** Situations a careful agent keeps a form ready for. Used by the model prompt and by the no-model similarity rung. */
const SITUATIONS = ['fha', 'va', 'seller financing', 'assumption', 'short sale', 'new construction', 'subject to sale', 'lease-back', 'lease back', 'backup', 'multiple offer', 'cancellation', '1031', 'firpta'];
const words = (t: string) => new Set((t.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []));
/** Pure: is a pick believable? The form must exist and its name must share a real word with the situation or reason. */
export function testPicks(picks: Pick[], candidates: FormRow[]): { confidence: number; problems: string[]; valid: Pick[] } {
  const problems: string[] = []; const valid: Pick[] = []; const seen = new Set<number>();
  for (const pk of picks) {
    const f = candidates[pk.form_number - 1];
    if (!f) { problems.push(`pick-out-of-range:${pk.form_number}`); continue; }
    if (seen.has(pk.form_number)) { problems.push(`pick-duplicate:${pk.form_number}`); continue; }
    seen.add(pk.form_number);
    const name = words(f.name); const said = words(`${pk.situation} ${pk.reason}`);
    const related = [...said].some(w => name.has(w)) || SITUATIONS.some(sit => f.name.toLowerCase().includes(sit) && `${pk.situation} ${pk.reason}`.toLowerCase().includes(sit));
    if (!related) { problems.push(`pick-unrelated:${f.name.slice(0, 40)}`); continue; }
    valid.push(pk);
  }
  return { confidence: picks.length ? valid.length / picks.length : 1, problems, valid };
}
/** No-model rung: forms whose names name a situation outright. */
export function picksBySimilarity(candidates: FormRow[], max = MAX_PICKS): Pick[] {
  const out: Pick[] = [];
  candidates.forEach((f, i) => { const sit = SITUATIONS.find(x => f.name.toLowerCase().includes(x)); if (sit && out.length < max) out.push({ form_number: i + 1, situation: sit, required_when: 'if_applicable', reason: `form name names the situation: ${sit}` }); });
  return out;
}

/**
 * Ask the local model for situational additions beyond the rules, inside the confidence loop: the picks are tested
 * (form exists, no duplicates, the name relates to the situation), the model is re-asked with the reviewer's findings,
 * then a no-model similarity rung takes over, then nothing. Returns [] when the model is not running.
 */
export async function proposeByModel(side: PacketSide, forms: FormRow[], rulePicks: Proposal[], onStep?: (s: string) => void): Promise<Proposal[]> {
  if (!(await modelAvailable('packet'))) return [];
  const taken = new Set(rulePicks.map(p => p.form_id));
  const candidates = forms.filter(f => !taken.has(f.id) && !NOISE.test(f.name));
  onStep?.(`Asking the local model about ${candidates.length} other forms (30-60 s)`);
  const list = candidates.map((f, i) => `${i + 1}. ${f.name}`).join('\n');
  const lines = (exhibitB as Record<string, unknown>)[side] as string[];
  const covered = rulePicks.map(p => p.form_name).join('; ');
  const base = `Utah REALTOR at Simple Choice Real Estate. Broker's Complete File checklist (Exhibit B), ${side === 'closing' ? 'closing (both sides)' : side + ' side'}:
${lines.map(l => `- ${l}`).join('\n')}

Already in the packet: ${covered || 'none'}.

Other forms in the library (pick by number):
${list}

Pick at most ${MAX_PICKS} SITUATIONAL forms a careful ${side === 'buyer' ? 'buyer' : 'listing'} agent keeps ready so the checklist can always be completed: FHA/VA, seller financing, assumption, short sale, new construction, subject-to-sale, lease-back, backup offer, multiple offers, cancellation, 1031/FIRPTA. For each: form number, the situation (a few words), required_when (if_applicable unless it is pre1978 or hoa), and a reason under 15 words that names the form. JSON only.`;
  interface Ctx { candidates: FormRow[] }
  interface Out { picks: Pick[]; problems: string[] }
  const job: Job<Ctx, Out> = {
    name: 'packet', strategies: ['model', 'strict', 'similarity', 'none'], timeCapMs: 5 * 60_000,
    async read() { /* the library is in hand */ }, async research() { /* nothing to widen */ },
    async task(c, strategy, failures, hints) {
      if (strategy === 'none') return { picks: [], problems: [] };
      if (strategy === 'similarity') return { picks: picksBySimilarity(c.candidates), problems: [] };
      const f = failures.slice(-1)[0];
      const prompt = `${base}${hints.length ? `\nKnown pitfalls: ${hints.join(' ')}` : ''}${f ? `\nA reviewer rejected the previous answer: ${f.problems.slice(0, 5).join('; ')}. Fix exactly that.` : ''}`;
      const raw = await chat(prompt, { job: 'packet', jsonSchema: SCHEMA, temperature: strategy === 'strict' ? 0 : 0.1, maxTokens: strategy === 'strict' ? 450 : 700, timeoutMs: 240_000 });
      const parsed = parseModelJson(PacketPicks, raw, { arrayKey: 'picks' });
      return { picks: (parsed.data?.picks ?? salvagePicks(raw)) as Pick[], problems: parsed.problems };
    },
    async test(out, c) { const t = testPicks(out.picks, c.candidates); const hard = out.problems.some(x => x.startsWith('schema:') && x !== 'schema:truncated'); return { confidence: hard ? 0 : t.confidence, problems: [...out.problems, ...t.problems] }; },
  };
  const t0 = performance.now();
  const r = await runWithConfidence(job, { candidates }, { bar: await confidenceBar(), lessons: dbLessons(), onStep });
  const out: Proposal[] = [];
  const valid = r.ok && r.output ? testPicks(r.output.picks, candidates).valid : [];
  for (const pk of valid) {
    const f = candidates[pk.form_number - 1];
    if (!f || taken.has(f.id) || out.some(o => o.form_id === f.id)) continue;
    const when: Proposal['required_when'] = pk.required_when === 'pre1978' || pk.required_when === 'hoa' ? pk.required_when : 'if_applicable';
    out.push({ form_id: f.id, form_name: f.name, source: 'ai', doc_kind: 'other', satisfies: pk.situation, required_when: when, reason: pk.reason, already: false });
  }
  const problems = r.failures.slice(-1)[0]?.problems ?? [];
  try { await logModelRun({ model: (await modelFor('packet')).model, purpose: `packet_${side}`, latencyMs: performance.now() - t0, ok: r.ok, output: { picks: out.length, problems }, groundingScore: r.confidence, ungrounded: problems, passes: r.passes, strategy: r.strategy }); } catch { /* logging only */ }
  return out;
}

/**
 * Two-phase: the rule picks are returned instantly through onRules (the page shows them at once); the model's
 * situational extras arrive when the promise resolves. Nothing waits on the model to show the checklist.
 */
export async function proposePacket(side: PacketSide, forms: FormRow[], existing: PacketTemplateItem[], onStep?: (s: string) => void, onRules?: (rules: Proposal[]) => void): Promise<{ proposals: Proposal[]; modelUsed: boolean; error?: string }> {
  onStep?.('Matching Exhibit B to the forms library');
  const rules = proposeByRules(side, forms, existing);
  onRules?.(rules);
  const have = new Set(existing.map(i => i.form_id));
  let ai: Proposal[] = []; let error: string | undefined;
  try { ai = await proposeByModel(side, forms, rules, onStep); } catch (e) { error = String(e); }
  return { proposals: [...rules, ...ai.map(p => ({ ...p, already: have.has(p.form_id) }))], modelUsed: !error && (await modelAvailable('packet')), error };
}

/**
 * Link the Exhibit B items of a template to the right library form using the rule table, without adding rows.
 * Idempotent: only items with no form yet are touched. Run on boot and whenever the library changes.
 */
export async function linkFormsByRules(templateId: number, side: PacketSide, forms: FormRow[]): Promise<number> {
  const items = await listPacketTemplateItems(templateId);
  let linked = 0;
  for (const rule of RULES[side]) {
    const primary = rule.forms[0];
    const form = forms.filter(f => primary.rx.test(`${f.name} (rev ${f.revision ?? ''})`)).sort((a, b) => (Date.parse(b.revision ?? '') || 0) - (Date.parse(a.revision ?? '') || 0))[0];
    if (!form) continue;
    const slot = items.find(i => i.doc_kind === rule.doc_kind && !i.form_id);
    if (!slot) continue;
    await updatePacketTemplateItem(slot.id, { form_id: form.id, reason: slot.reason ?? primary.reason });
    linked++;
  }
  return linked;
}
