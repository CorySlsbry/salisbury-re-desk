/**
 * Intake orchestration: a dropped PDF -> classified -> extracted (tiers 1..3) -> reviewed by Cory -> committed
 * (client, property, transaction, folder, filed document, packet checklist, deadlines, cadence tasks, audit).
 */
import { doc, native, appPaths } from './native';
import { extractRepcFromFields, extractRepcFromTokens, mergeExtractions, tokensFromOcr, tokensFromWords, linesFromTokens, REPC_VERSION } from './extract/repc';
import type { ExtractionResult, RepcFields, Extracted, AgreementExtraction, AgreementFields, AgreementKind } from './extract/types';
import { extractAgreement } from './extract/agreement';
import { splitNames } from './extract/normalize';
import { computeRepcDeadlines, computeAgreementDeadlines, addDays, dayOfWeek } from './deadlines';
import { planCadence } from './cadences';
import * as repo from './repo';
import { prefillPacket, makeQuestionnaire, type FillData } from './formfill';
import { pushTransactionToCalendar, googleStatus } from './google';
import { askModelForFields, type FallbackAsk } from './extract/aiFallback';
import { runAutomations } from './automations';
import { folderFor } from './documents';

export type DocKind = 'repc' | 'listing_agreement' | 'bba' | 'addendum' | 'spcd' | 'agency_disclosure' | 'lead_paint' | 'wire_fraud' | 'other';

export interface Analysis {
  path: string; sha256: string; pages: number; bytes: number; hasForms: boolean;
  kind: DocKind; kindConfidence: number;
  extraction: ExtractionResult | null;          // REPC
  agreement: AgreementExtraction | null;        // listing agreement / buyer-broker agreement
  pageText: string[];
}

/** Title patterns: what the form calls itself in its heading (UPPERCASE on every UAR / state form). Checked in the title region first. */
const TITLE_RULES: Array<[DocKind, RegExp]> = [
  ['addendum', /ADDENDUM\s*(NO\.?\s*\d|TO\s+(THE\s+)?(REAL ESTATE PURCHASE CONTRACT|EXCLUSIVE))|COUNTEROFFER/],
  ['listing_agreement', /EXCLUSIVE RIGHT TO SELL LISTING AGREEMENT/],
  ['bba', /EXCLUSIVE BUYER[- ]BROKER AGREEMENT|BUYER[- ]BROKER AGREEMENT\s*&/],
  ['repc', /REAL ESTATE PURCHASE CONTRACT/],
  ['spcd', /SELLER['’]?S PROPERTY CONDITION DISCLOSURE/],
  ['agency_disclosure', /LIMITED AGENCY CONSENT/],
  ['lead_paint', /LEAD[- ]BASED PAINT/],
  ['wire_fraud', /WIRE FRAUD ALERT/],
];
/** Body evidence, case-insensitive, used only when no title matched (scans, odd exports). */
const BODY_RULES: Array<[DocKind, RegExp]> = [
  ['repc', /CONTRACT DEADLINES|Seller Disclosure Deadline|Due Diligence Deadline/i],
  ['listing_agreement', /TERM OF LISTING|Listing Period/i],
  ['bba', /Buyer[’']s Agent.*Initial Term|Exclusive Buyer-Broker/i],
  ['spcd', /PROPERTY CONDITION DISCLOSURE/i],
  ['lead_paint', /LEAD[- ]BASED PAINT/i],
  ['wire_fraud', /WIRE FRAUD/i],
  ['addendum', /ADDENDUM NO\.?\s*\d/i],
];

/**
 * A form is what its TITLE says, not what its body mentions: the listing agreement talks about "any real estate
 * purchase contract" on page 2, so body words cannot decide. Title region = the first ~900 characters (the first
 * page heading), then the first page, then the body as a last resort.
 */
export function classify(text: string): { kind: DocKind; confidence: number } {
  const title = text.slice(0, 900), firstPage = text.slice(0, 5000);
  for (const [kind, rx] of TITLE_RULES) if (rx.test(title)) return { kind, confidence: 0.95 };
  for (const [kind, rx] of TITLE_RULES) if (rx.test(firstPage)) return { kind, confidence: 0.85 };
  for (const [kind, rx] of BODY_RULES) if (rx.test(firstPage)) return { kind, confidence: 0.6 };
  for (const [kind, rx] of BODY_RULES) if (rx.test(text)) return { kind, confidence: 0.5 };
  return { kind: 'other', confidence: 0.3 };
}

/** One string per page, lines rebuilt from word positions (y then x), so labels and their filled values stay together. */
export function readingOrder(pages: Array<{ page: number; text: string; words: [number, number, number, number, string][] | null }>): string[] {
  const lines = linesFromTokens(tokensFromWords(pages), 4);
  return pages.map(p => { const mine = lines.filter(l => l.page === p.page).map(l => l.text); return mine.length ? mine.join('\n') : p.text; });
}

/** Run the document engine over a PDF. OCR only when the text layer is empty on the pages we care about. */
export async function analyze(path: string, onStep?: (s: string) => void): Promise<Analysis> {
  onStep?.('Reading file');
  const info = await doc.info(path);
  const [sha, bytes] = await native.sha256File(path);
  onStep?.('Reading text');
  const text = await doc.text(path, { words: true });
  const pageText = text.pages.map(p => p.text);
  const joined = pageText.join('\n');
  const isScan = joined.replace(/\s/g, '').length < 200 * text.pages.length * 0.2;
  let ocrText = '';
  let extraction: ExtractionResult | null = null;
  let agreement: AgreementExtraction | null = null;
  const { kind, confidence } = classify(isScan ? '' : joined);
  let finalKind = kind, finalConf = confidence;

  if (isScan) {
    onStep?.('Scanned document: running OCR');
    // OCR page 1 first to classify; a REPC then needs only pages 1, 2 and 6 (parties/property, agents, deadlines + signatures);
    // an agreement needs page 1 (parties, property, end date, fee) and the last page (signatures).
    const ocrPages = [] as Array<{ page: number; dpi: number; lines: Array<{ box: [number, number][]; text: string }> }>;
    const ocrPage = async (p: number) => { onStep?.(`OCR page ${p} of ${info.pages}`); const o = await doc.ocr(path, p, 200); ocrPages.push({ page: p, dpi: o.dpi, lines: o.lines }); ocrText += '\n' + o.text; };
    await ocrPage(1);
    let c = classify(ocrText);
    if (c.kind === 'other' && info.pages > 1) { await ocrPage(2); c = classify(ocrText); }
    finalKind = c.kind; finalConf = c.confidence * 0.9;
    if (finalKind === 'repc') {
      for (const p of [2, 6]) if (p <= info.pages && !ocrPages.some(o => o.page === p)) await ocrPage(p);
      extraction = extractRepcFromTokens(ocrPages.flatMap(o => tokensFromOcr(o.page, o.dpi, o.lines)), 3);
    } else if (finalKind === 'listing_agreement' || finalKind === 'bba') {
      if (info.pages > 1 && !ocrPages.some(o => o.page === info.pages)) await ocrPage(info.pages);
      agreement = extractAgreement(ocrPages.flatMap(o => tokensFromOcr(o.page, o.dpi, o.lines)), finalKind, 3);
    }
  } else if (kind === 'repc') {
    onStep?.('Reading form fields');
    const fields = await doc.fields(path);
    const t1 = extractRepcFromFields(fields.fields);
    const t2 = extractRepcFromTokens(tokensFromWords(text.pages), 2);
    extraction = fields.count > 0 && !t1.warnings.some(w => /flattened or blank/.test(w)) ? mergeExtractions(t1, t2) : { ...t2, warnings: [...t1.warnings, ...t2.warnings] };
  } else if (kind === 'listing_agreement' || kind === 'bba') {
    onStep?.('Reading the agreement');
    agreement = extractAgreement(tokensFromWords(text.pages), kind, 2);
  }
  // Extraction Agent: only the fields the rule readers left BLANK go to the local model, which must quote where it
  // saw them. Its answers are capped at 0.6 confidence so the two-person rule always applies to them. Fields that
  // were read but sit below the bar are not re-asked; they are verified by eye on the review screen instead.
  const fill = async (fields: Record<string, Extracted<unknown>>, spec: Record<string, FallbackAsk>) => {
    const asks = Object.entries(spec).filter(([k]) => { const f = fields[k]; return !f || f.value == null; }).map(([, a]) => a);
    // Scan rung of the loop: read every page again at 300 dpi (the first pass used 200) before asking once more.
    const reread = isScan ? async () => { const out: string[] = []; for (let pg = 1; pg <= info.pages; pg++) { const hi = await doc.ocr(path, pg, 300); out.push(hi.text); } return out; } : undefined;
    // The model reads the page in reading order (lines rebuilt from word positions), so a filled value sits next to its label instead of wherever the PDF's text stream put it.
    const got = await askModelForFields(isScan ? ocrText.split('\n') : readingOrder(text.pages), asks, onStep, { reread });
    for (const [k, v] of Object.entries(got.fields)) if (!fields[k] || fields[k].value == null) fields[k] = v as Extracted<unknown>;
  };
  if (extraction) await fill(extraction.fields as unknown as Record<string, Extracted<unknown>>, REPC_ASKS);
  if (agreement) await fill(agreement.fields as unknown as Record<string, Extracted<unknown>>, finalKind === 'bba' ? BBA_ASKS : LISTING_ASKS);
  return { path, sha256: sha, pages: info.pages, bytes, hasForms: info.has_forms, kind: finalKind, kindConfidence: finalConf, extraction, agreement, pageText: isScan ? ocrText.split('\n') : pageText };
}

/** Accuracy bar for anything read off a contract: below it, Cory must look at the crop before it can be committed. */
export { confidenceBar } from './lessonStore';

const REPC_ASKS: Record<string, FallbackAsk> = {
  buyer_names: { key: 'buyer_names', question: 'the Buyer name(s) on page 1', kind: 'text' , anchors: ["buyer", "purchaser"] },
  seller_names: { key: 'seller_names', question: 'the Seller name(s) on page 1', kind: 'text' , anchors: ["seller"] },
  property_street: { key: 'property_street', question: 'the Property street address (section 1)', kind: 'text' , anchors: ["property", "address", "located"] },
  purchase_price: { key: 'purchase_price', question: 'the Purchase Price (section 2)', kind: 'money' , anchors: ["purchase price", "price"] },
  earnest_money: { key: 'earnest_money', question: 'the Earnest Money Deposit amount', kind: 'money' , anchors: ["earnest money", "deposit"] },
  seller_disclosure_deadline: { key: 'seller_disclosure_deadline', question: 'the Seller Disclosure Deadline date (section 24a)', kind: 'date' , anchors: ["seller disclosure deadline", "disclosure deadline"] },
  due_diligence_deadline: { key: 'due_diligence_deadline', question: 'the Due Diligence Deadline date (section 24b)', kind: 'date' , anchors: ["due diligence deadline"] },
  financing_appraisal_deadline: { key: 'financing_appraisal_deadline', question: 'the Financing & Appraisal Deadline date (section 24c)', kind: 'date' , anchors: ["financing", "appraisal deadline"] },
  settlement_deadline: { key: 'settlement_deadline', question: 'the Settlement Deadline date (section 24d)', kind: 'date' , anchors: ["settlement deadline", "settlement"] },
};
const LISTING_ASKS: Record<string, FallbackAsk> = {
  client_names: { key: 'client_names', question: 'the Seller name(s) in the opening paragraph', kind: 'text' , anchors: ["seller", "buyer", "undersigned"] },
  property_street: { key: 'property_street', question: 'the Property street address in section 1', kind: 'text' , anchors: ["property", "address", "located"] },
  end_date: { key: 'end_date', question: 'the End Date in section 1 (the listing ENDS at 5:00 PM on this date)', kind: 'date' , anchors: ["end date", "ends", "expire", "through", "5:00 p.m.", "5:00 pm", "listing period"] },
  fee_pct: { key: 'fee_pct', question: 'the brokerage fee percentage in section 2.1', kind: 'money', pattern: '^\\$?\\s*(?!0(?:\\.0+)?\\s*%?$)\\d{1,2}(?:\\.\\d{1,2})?\\s*%?$' , anchors: ["brokerage fee", "commission", "compensation", "percent", "%"] },
  client_signed_on: { key: 'client_signed_on', question: 'the date next to the first Seller signature on the last page', kind: 'date' , anchors: ["signature", "date", "signed"] },
};
const BBA_ASKS: Record<string, FallbackAsk> = {
  client_names: { key: 'client_names', question: 'the Buyer name(s) in the opening paragraph', kind: 'text' , anchors: ["seller", "buyer", "undersigned"] },
  end_date: { key: 'end_date', question: 'the End Date in section 1.1', kind: 'date' , anchors: ["end date", "ends", "expire", "through", "5:00 p.m.", "5:00 pm", "listing period"] },
  fee_pct: { key: 'fee_pct', question: 'the brokerage fee percentage in section 2.1', kind: 'money', pattern: '^\\$?\\s*(?!0(?:\\.0+)?\\s*%?$)\\d{1,2}(?:\\.\\d{1,2})?\\s*%?$' , anchors: ["brokerage fee", "commission", "compensation", "percent", "%"] },
  client_signed_on: { key: 'client_signed_on', question: 'the date next to the first Buyer signature on the last page', kind: 'date' , anchors: ["signature", "date", "signed"] },
};

/* ---------------- listing agreement / buyer-broker agreement ---------------- */

/** What Cory confirms for a representation agreement. Side is fixed by the form. */
export interface ReviewedAgreement {
  kind: AgreementKind;
  side: 'seller' | 'buyer';
  clientNames: string;
  street: string; city: string; county: string; zip: string;   // listing: the Property; BBA: optional "located only at"
  searchArea: string;                                           // BBA 1.2 counties
  signedOn: string; endsOn: string | null;
  listPrice: number | null;                                     // listing: from the Data Form (not on this agreement)
  feePct: number | null; feeFlat: number | null; coopOfferPct: number | null;
  clientPhone: string; clientEmail: string; clientAddress: string;
  yearBuilt: number | null; hasHoa: boolean | null;
}

export function draftAgreementReview(kind: AgreementKind, f: AgreementFields): ReviewedAgreement {
  const v = <T,>(e: Extracted<T>): T | null => e.value;
  return {
    kind, side: kind === 'listing_agreement' ? 'seller' : 'buyer',
    clientNames: v(f.client_names) ?? '',
    street: v(f.property_street) ?? '', city: v(f.property_city) ?? '', county: v(f.property_county) ?? '', zip: v(f.property_zip) ?? '',
    searchArea: v(f.search_area) ?? '',
    signedOn: v(f.client_signed_on) ?? v(f.agent_signed_on) ?? '', endsOn: v(f.end_date),
    listPrice: null, feePct: v(f.fee_pct), feeFlat: v(f.fee_flat), coopOfferPct: v(f.coop_offer_pct),
    clientPhone: v(f.client_phone) ?? '', clientEmail: '', clientAddress: v(f.client_address) ?? '',
    yearBuilt: null, hasHoa: null,
  };
}

/** Commit a reviewed listing agreement or BBA: client + (property) + folder + filed agreement + packet + deadlines + cadence. */
export async function commitAgreement(a: Analysis, r: ReviewedAgreement, onStep?: (s: string) => void): Promise<{ transactionId: number; clientId: number; folder: string }> {
  const names = splitNames(r.clientNames);
  const primary = names[0] ?? { first: 'Unknown', last: 'Client' };
  const second = names[1];
  const listing = r.kind === 'listing_agreement';
  onStep?.('Creating client');
  const clientId = await repo.upsertClient({ first_name: primary.first, last_name: primary.last, second_first_name: second?.first ?? null, second_last_name: second?.last ?? null, phone: r.clientPhone || null, email: r.clientEmail || null, mailing_address: r.clientAddress || null, source: listing ? 'listing_agreement' : 'buyer_agreement' });
  const propertyId = r.street ? await repo.upsertProperty({ street: r.street, city: r.city || null, county: r.county || null, zip: r.zip || null, year_built: r.yearBuilt ?? null, has_hoa: r.hasHoa == null ? null : r.hasHoa ? 1 : 0 }) : null;
  onStep?.('Creating folder');
  const folder = await native.createClientFolder(folderName({ clientLast: primary.last, clientFirst: primary.first, street: r.street || (listing ? 'Listing' : `Buyer${r.searchArea ? ' - ' + r.searchArea : ''}`), city: r.street ? r.city : '' }));
  await repo.setClientFolder(clientId, folder);
  const txId = await repo.createTransaction({ client_id: clientId, property_id: propertyId, side: r.side, status: 'active', list_price: r.listPrice, agreement_signed_on: r.signedOn, agreement_expires_on: r.endsOn });
  if (r.feePct != null || r.feeFlat != null) await repo.updateTransaction(txId, { commission_pct: r.feePct, commission_flat: r.feeFlat });
  onStep?.('Filing the agreement');
  const fileName = a.path.split(/[\\/]/).pop() ?? (listing ? 'Listing Agreement.pdf' : 'Buyer-Broker Agreement.pdf');
  const [vaultPath, sha] = await native.fileIntoVault(a.path, `${folder}\\${folderFor(r.kind)}`, fileName);
  const docId = await repo.addDocument({ transaction_id: txId, client_id: clientId, kind: r.kind, title: listing ? 'Exclusive Right to Sell Listing Agreement & Agency Disclosure' : 'Exclusive Buyer-Broker Agreement & Agency Disclosure', path: vaultPath, sha256: sha, pages: a.pages, bytes: a.bytes, form_id: null, signed: 1, signed_on: r.signedOn, extracted_json: JSON.stringify(a.agreement), extraction_tier: a.agreement?.tier ?? null, reviewed_at: new Date().toISOString() });
  onStep?.('Packet checklist');
  await repo.instantiatePacket(txId, r.side, { pre1978: r.yearBuilt ? r.yearBuilt < 1978 : undefined, hoa: r.hasHoa ?? undefined });
  await repo.markPacketItemByKind(txId, r.kind, docId);
  await repo.markPacketItemByKind(txId, 'agency_disclosure', docId); // the UAR agreements carry the agency disclosure in the same form
  onStep?.('Computing deadlines');
  const deadlines = computeAgreementDeadlines(r.kind, r.signedOn, r.endsOn);
  await repo.replaceDeadlines(txId, deadlines.map(d => ({ type: d.type, label: d.label, due_on: d.dueOn, due_time: d.dueTime, basis: d.basis, source_document_id: docId, source_page: d.basis === 'contract' ? 1 : null, confidence: d.basis === 'contract' ? (a.agreement?.fields.end_date.confidence ?? null) : null, status: 'pending', reminder_on: d.reminderOn ?? null, notes: d.note ?? null })));
  onStep?.('Planning follow-up');
  const steps = await repo.listCadenceSteps(listing ? 'listing_launch' : 'buyer_onboarding');
  const vars = { first_name: primary.first, city: r.city, phone: (await repo.getSettings()).agent_phone };
  for (const t of planCadence(steps, { start: r.signedOn }, vars)) {
    await repo.addTask({ transaction_id: txId, client_id: clientId, cadence_step_id: t.cadence_step_id, deadline_id: null, kind: t.kind, title: t.title, body: t.body, due_on: t.due_on, due_time: null, priority: t.priority });
  }
  if (listing) {
    // Pat's weekly rhythm for an active listing: Monday-by-4pm seller update + Tuesday market/price review, for the life of the agreement (capped at 26 weeks).
    const end = r.endsOn ?? addDays(r.signedOn, 182);
    let monday = r.signedOn; while (dayOfWeek(monday) !== 1) monday = addDays(monday, 1);
    for (let w = 0; w < 26 && monday <= end; w++, monday = addDays(monday, 7)) {
      await repo.addTask({ transaction_id: txId, client_id: clientId, cadence_step_id: null, deadline_id: null, kind: 'email', title: `Weekly seller update to ${primary.first} by 4 PM (showings, feedback, market, next step). Even a quiet week.`, body: null, due_on: monday, due_time: '16:00', priority: 'normal' });
      await repo.addTask({ transaction_id: txId, client_id: clientId, cadence_step_id: null, deadline_id: null, kind: 'task', title: `Tuesday market review for ${r.street}: comps by status in the price band, showings vs 1-2/week, three pricing options. Get the price reduction.`, body: null, due_on: addDays(monday, 1), due_time: null, priority: 'normal' });
    }
  }
  // Prefill every packet form the app knows how to type into, plus the client questionnaire; push the calendar if Google is connected.
  const settings = await repo.getSettings();
  const property = `${r.street}${r.city ? ', ' + r.city : ''}${r.zip ? ' ' + r.zip : ''}`.trim();
  const fill: FillData = { seller_names: listing ? r.clientNames : '', buyer_names: listing ? '' : r.clientNames, client_names: r.clientNames, property, street: r.street, city: r.city, zip: r.zip, county: r.county, company: settings.brokerage ?? 'Simple Choice Real Estate', agent: settings.agent_name ?? 'Cory Salisbury', agent_phone: settings.agent_phone, agent_email: settings.agent_email, client_phone: r.clientPhone, client_email: r.clientEmail, today: repo.today(), fee_pct: r.feePct != null ? String(r.feePct) : '', coop_offer_pct: r.coopOfferPct != null ? String(r.coopOfferPct) : '', end_date: r.endsOn ?? '' };
  onStep?.('Prefilling packet forms');
  const prefilled = await prefillPacket(txId, r.side, folder, fill, { pre1978: r.yearBuilt ? r.yearBuilt < 1978 : null, hoa: r.hasHoa }, onStep).catch(() => [] as Array<{ item: string; path: string }>);
  const questionnaire = await makeQuestionnaire(folder, r.side, r.clientNames, property, fill.agent, fill.company).catch(() => null);
  let calendar: { created: number; updated: number; unchanged: number } | null = null;
  // Calendar only when Cory has said "always"; otherwise the client page asks first.
  if (settings.google_calendar_auto_push === 'always' && (await googleStatus()).connected) { onStep?.('Pushing to Google Calendar'); try { calendar = await pushTransactionToCalendar(txId, onStep); } catch (e) { await repo.logEvent('google.calendar.failed', 'transaction', txId, { error: String(e) }); } }
  const p = await appPaths();
  const lines = [`# ${primary.last}, ${primary.first} - ${r.street || (listing ? 'Listing' : 'Buyer')}${r.city ? ', ' + r.city : ''}`, '',
    `${listing ? 'Listing agreement' : 'Buyer-broker agreement'} signed ${r.signedOn}${r.endsOn ? `, ends ${r.endsOn} 5:00 PM` : ''}  |  Client(s): ${r.clientNames}`,
    listing ? `Fee: ${r.feePct ?? '?'}%${r.feeFlat ? ` + $${r.feeFlat}` : ''}  |  Offer to buyer brokerage: ${r.coopOfferPct ?? 'none'}%  |  List price: ${r.listPrice ?? 'see Data Form'}` : `Fee: ${r.feePct ?? '?'}%${r.feeFlat ? ` + $${r.feeFlat}` : ''}  |  Area: ${r.searchArea || 'see 1.2'}`,
    `Contact: ${r.clientPhone || '?'} ${r.clientEmail || ''} ${r.clientAddress || ''}`.trim(), '',
    '## Deadlines (5:00 PM Mountain)', ...deadlines.map(d => `- ${d.dueOn} ${d.dueTime}  ${d.label}`), '',
    ...(prefilled.length ? ['## Prefilled drafts (unsigned)', ...prefilled.map(x => `- ${x.item}: ${x.path.split(/[\\/]/).pop()}`), ''] : []),
    ...(questionnaire ? [`Questionnaire: ${questionnaire.split(/[\\/]/).pop()}`, ''] : []),
    ...(calendar ? [`Google Calendar: ${calendar.created} created, ${calendar.updated} updated`, ''] : []),
    `Generated by Salisbury RE Desk. Vault root: ${p.root}`, ''];
  await native.writeText(`${folder}\\_index.md`, lines.join('\n'));
  await repo.logEvent(`intake.${r.kind}.committed`, 'transaction', txId, { sha256: a.sha256, tier: a.agreement?.tier, revision: a.agreement?.version, prefilled: prefilled.length, calendar });
  onStep?.('Running the automations'); await runAutomations('intake', txId).catch(() => []);
  return { transactionId: txId, clientId, folder };
}

/** What Cory confirms on the review screen. Mirrors RepcFields but flattened to plain values. */
export interface ReviewedRepc {
  side: 'buyer' | 'seller';
  buyerNames: string; sellerNames: string;
  street: string; city: string; county: string; zip: string; taxId: string;
  purchasePrice: number | null; earnestMoney: number | null; isCash: boolean;
  acceptanceOn: string; sellerDisclosureOn: string | null; dueDiligenceOn: string | null; financingAppraisalOn: string | null; settlementOn: string | null;
  coopAgent: string; coopBrokerage: string;
  clientPhone?: string; clientEmail?: string; yearBuilt?: number | null; hasHoa?: boolean | null;
}

export function draftReview(f: RepcFields): ReviewedRepc {
  const v = <T,>(e: Extracted<T>): T | null => e.value;
  const ourSide: 'buyer' | 'seller' = /Simple Choice|Salisbury/i.test(v(f.buyer_brokerage) ?? '') || /Cory Salisbury/i.test(v(f.buyer_agent) ?? '') ? 'buyer' : 'seller';
  return {
    side: ourSide,
    buyerNames: v(f.buyer_names) ?? '', sellerNames: v(f.seller_names) ?? '',
    street: v(f.property_street) ?? '', city: v(f.property_city) ?? '', county: v(f.property_county) ?? '', zip: v(f.property_zip) ?? '', taxId: v(f.property_tax_id) ?? '',
    purchasePrice: v(f.purchase_price), earnestMoney: v(f.earnest_money), isCash: v(f.is_cash) ?? false,
    acceptanceOn: v(f.acceptance_on) ?? v(f.seller_signed_on) ?? '', sellerDisclosureOn: v(f.seller_disclosure_deadline), dueDiligenceOn: v(f.due_diligence_deadline),
    financingAppraisalOn: v(f.financing_appraisal_deadline), settlementOn: v(f.settlement_deadline),
    coopAgent: ourSide === 'buyer' ? v(f.seller_agent) ?? '' : v(f.buyer_agent) ?? '', coopBrokerage: ourSide === 'buyer' ? v(f.seller_brokerage) ?? '' : v(f.buyer_brokerage) ?? '',
  };
}

export function folderName(r: { clientLast: string; clientFirst: string; street: string; city: string }): string {
  return `${r.clientLast}, ${r.clientFirst} - ${r.street}${r.city ? ', ' + r.city : ''}`.replace(/\s+/g, ' ').trim();
}

/** Commit a reviewed REPC: everything happens here, in order, with an audit trail. Returns the transaction id. */
export async function commitRepc(a: Analysis, r: ReviewedRepc, onStep?: (s: string) => void): Promise<{ transactionId: number; clientId: number; folder: string }> {
  const names = splitNames(r.side === 'buyer' ? r.buyerNames : r.sellerNames);
  const primary = names[0] ?? { first: 'Unknown', last: 'Client' };
  const second = names[1];
  onStep?.('Creating client');
  const clientId = await repo.upsertClient({ first_name: primary.first, last_name: primary.last, second_first_name: second?.first ?? null, second_last_name: second?.last ?? null, phone: r.clientPhone ?? null, email: r.clientEmail ?? null, source: 'contract' });
  const propertyId = await repo.upsertProperty({ street: r.street, city: r.city || null, county: r.county || null, zip: r.zip || null, tax_id: r.taxId || null, year_built: r.yearBuilt ?? null, has_hoa: r.hasHoa == null ? null : r.hasHoa ? 1 : 0 });
  onStep?.('Creating folder');
  const folder = await native.createClientFolder(folderName({ clientLast: primary.last, clientFirst: primary.first, street: r.street, city: r.city }));
  await repo.setClientFolder(clientId, folder);
  const txId = await repo.createTransaction({ client_id: clientId, property_id: propertyId, side: r.side, status: 'under_contract', contract_price: r.purchasePrice, acceptance_on: r.acceptanceOn, is_cash: r.isCash, repc_version: REPC_VERSION });
  onStep?.('Filing the contract');
  const fileName = a.path.split(/[\\/]/).pop() ?? 'REPC.pdf';
  const [vaultPath, sha] = await native.fileIntoVault(a.path, `${folder}\\${folderFor('repc')}`, fileName);
  const docId = await repo.addDocument({ transaction_id: txId, client_id: clientId, kind: 'repc', title: 'Real Estate Purchase Contract', path: vaultPath, sha256: sha, pages: a.pages, bytes: a.bytes, form_id: null, signed: 1, signed_on: r.acceptanceOn, extracted_json: JSON.stringify(a.extraction), extraction_tier: a.extraction?.tier ?? null, reviewed_at: new Date().toISOString() });
  onStep?.('Packet checklist');
  await repo.instantiatePacket(txId, r.side, { pre1978: r.yearBuilt ? r.yearBuilt < 1978 : undefined, hoa: r.hasHoa ?? undefined });
  await repo.markPacketItemByKind(txId, 'repc', docId);
  onStep?.('Computing deadlines');
  const { deadlines, flags } = computeRepcDeadlines({ acceptanceOn: r.acceptanceOn, sellerDisclosureOn: r.sellerDisclosureOn, dueDiligenceOn: r.dueDiligenceOn, financingAppraisalOn: r.financingAppraisalOn, settlementOn: r.settlementOn, isCash: r.isCash });
  await repo.replaceDeadlines(txId, deadlines.map(d => ({ type: d.type, label: d.label, due_on: d.dueOn, due_time: d.dueTime, basis: d.basis, source_document_id: docId, source_page: d.basis === 'contract' ? 6 : null, confidence: d.basis === 'contract' ? (a.extraction?.fields.settlement_deadline.confidence ?? null) : null, status: d.waived ? 'waived' : 'pending', reminder_on: d.reminderOn ?? null, notes: d.note ?? null })));
  onStep?.('Planning follow-up');
  const steps = await repo.listCadenceSteps('under_contract_chase');
  const vars = { first_name: primary.first, city: r.city, phone: (await repo.getSettings()).agent_phone };
  for (const t of planCadence(steps, { start: r.acceptanceOn, acceptance: r.acceptanceOn, due_diligence: r.dueDiligenceOn, financing_appraisal: r.financingAppraisalOn, settlement: r.settlementOn }, vars)) {
    await repo.addTask({ transaction_id: txId, client_id: clientId, cadence_step_id: t.cadence_step_id, deadline_id: null, kind: t.kind, title: t.title, body: t.body, due_on: t.due_on, due_time: null, priority: t.priority });
  }
  const p = await appPaths();
  await native.writeText(`${folder}\\_index.md`, indexMarkdown(r, primary, deadlines.map(d => `${d.dueOn} ${d.dueTime}  ${d.label}${d.waived ? ' (waived)' : ''}`), flags.map(f => `${f.level.toUpperCase()}: ${f.message}`), p.root));
  // Prefill the buyer/seller disclosures the app can type into, the questionnaire, and the calendar when allowed.
  const settings = await repo.getSettings();
  const property = `${r.street}${r.city ? ', ' + r.city : ''}${r.zip ? ' ' + r.zip : ''}`.trim();
  const clientNames = r.side === 'buyer' ? r.buyerNames : r.sellerNames;
  onStep?.('Prefilling packet forms');
  await prefillPacket(txId, r.side, folder, { seller_names: r.sellerNames, buyer_names: r.buyerNames, client_names: clientNames, property, street: r.street, city: r.city, zip: r.zip, county: r.county, company: settings.brokerage ?? 'Simple Choice Real Estate', agent: settings.agent_name ?? 'Cory Salisbury', agent_phone: settings.agent_phone, agent_email: settings.agent_email, client_phone: r.clientPhone, client_email: r.clientEmail, today: repo.today() }, { pre1978: r.yearBuilt ? r.yearBuilt < 1978 : null, hoa: r.hasHoa ?? null }, onStep).catch(() => []);
  await makeQuestionnaire(folder, r.side, clientNames, property, settings.agent_name ?? 'Cory Salisbury', settings.brokerage ?? 'Simple Choice Real Estate').catch(() => null);
  if (settings.google_calendar_auto_push === 'always' && (await googleStatus()).connected) { try { await pushTransactionToCalendar(txId, onStep); } catch (e) { await repo.logEvent('google.calendar.failed', 'transaction', txId, { error: String(e) }); } }
  await repo.logEvent('intake.repc.committed', 'transaction', txId, { sha256: a.sha256, tier: a.extraction?.tier, flags });
  onStep?.('Running the automations'); await runAutomations('intake', txId).catch(() => []);
  return { transactionId: txId, clientId, folder };
}

function indexMarkdown(r: ReviewedRepc, primary: { first: string; last: string }, deadlines: string[], flags: string[], root: string): string {
  return [`# ${primary.last}, ${primary.first} - ${r.street}${r.city ? ', ' + r.city : ''}`, '',
    `Side: ${r.side}  |  Buyer(s): ${r.buyerNames}  |  Seller(s): ${r.sellerNames}`,
    `Price: ${r.purchasePrice ?? '?'}  |  EMD: ${r.earnestMoney ?? '?'}  |  ${r.isCash ? 'CASH' : 'Financed'}  |  Acceptance: ${r.acceptanceOn}`,
    `Co-op: ${r.coopAgent} (${r.coopBrokerage})`, '', '## Deadlines (5:00 PM Mountain unless noted)', ...deadlines.map(d => `- ${d}`), '',
    ...(flags.length ? ['## Flags', ...flags.map(f => `- ${f}`), ''] : []),
    `Generated by Salisbury RE Desk. Vault root: ${root}`, ''].join('\n');
}
