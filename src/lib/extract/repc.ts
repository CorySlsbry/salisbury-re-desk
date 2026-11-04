/**
 * REPC extractor (Utah state form, eff. 2024-12-04). Three tiers, same output shape:
 *  Tier 1: AcroForm field values (exact). Field names on the state PDF are messy but stable; map below.
 *  Tier 2: text layer with geometry (flattened / signed PDFs). Values are located relative to label tokens.
 *  Tier 3: OCR lines with geometry (scans) run through the same geometric locator; LLM fills gaps elsewhere.
 * Every value carries page + bbox + confidence for the review screen. Nothing is committed without review.
 */
import type { Extracted, ExtractionResult, RepcFields, Token, Tier } from './types';
import { cleanName, toIsoDate, toMoney, toTime } from './normalize';

export const REPC_VERSION = '2024-12-04';

/* ---------------- Tier 1: AcroForm field map ---------------- */
export const REPC_FIELD_MAP = {
  offer_day: 's', offer_month: 'day of',
  buyer_names: 'Offer Reference Date',              // misnamed on the state form: this box is the Buyer name
  seller_names: 'from',
  earnest_money: 'calendar days after Acceptance as defined in Section 23 an Earnest Money Deposit in the amount of',
  earnest_money_form: 'of',
  property_street: 'PROPERTY', property_city: 'City of', property_county: 'County of', property_zip: 'State of Utah Zip', property_tax_id: 'Tax ID No',
  purchase_price: 'ce for the Property is',
  price_emd: 'undefined', price_additional_emd: 'undefined_2', price_new_loan: 'undefined_3', price_seller_financing: 'undefined_4', price_other: 'undefined_5', price_balance: 'undefined_6',
  financing_condition_yes: 'Check Box fin pg 4', financing_condition_no: 'Check Box no fin pg 4',
  seller_agent: 's Agents', seller_agent_license: 'Sellers Agents Utah Real Estate License Numbers', seller_brokerage: 'Sellers Brokerage', seller_brokerage_license: 'Estate License Number',
  buyer_agent: 's Agents_2', buyer_agent_license: 's Agents Utah Real Estate License Numbers', buyer_brokerage: 's Brokerage', buyer_brokerage_license: 'Estate License Number_2',
  seller_disclosure_deadline: 'Date_11', due_diligence_deadline: 'Date_12', financing_appraisal_deadline: 'Date_13', settlement_deadline: 'Date_14',
  offer_expires_time: 'Earnest Money Depos time', offer_expires_am: 'Check Box AM pg6', offer_expires_pm: 'Check Box PM pg6', offer_expires_date: 'Date this offer shal',
  buyer1_signed: 'Date pg6', buyer2_signed: 'Date_15', seller1_signed: 'Date_16', seller1_time: 'me', seller2_signed: 'Date_17', seller2_time: 'me_2',
  accepted: 'Check Box accept pg6', countered: 'Check Box counter  pg6', rejected: 'Check Box rej pg6',
  additional_emd: 's Brokerage an Additional Earnest Money Deposit in the amount of', additional_emd_will: 'Check Box will pg 4',
} as const;

/** Page + bbox of each mapped widget (from pdf.widgets on the blank state form), used for review crops on Tier 1. */
export const REPC_FIELD_GEOMETRY: Record<string, { page: number; bbox: [number, number, number, number] }> = {
  's': { page: 1, bbox: [61, 94, 80, 104] }, 'day of': { page: 1, bbox: [105, 94, 165, 104] }, 'Offer Reference Date': { page: 1, bbox: [285, 94, 466, 104] },
  'from': { page: 1, bbox: [53, 105, 247, 115] }, 'calendar days after Acceptance as defined in Section 23 an Earnest Money Deposit in the amount of': { page: 1, bbox: [460, 117, 534, 127] }, 'of': { page: 1, bbox: [39, 128, 199, 138] },
  'PROPERTY': { page: 1, bbox: [101, 175, 582, 185] }, 'City of': { page: 1, bbox: [58, 192, 196, 202] }, 'County of': { page: 1, bbox: [237, 192, 359, 202] }, 'State of Utah Zip': { page: 1, bbox: [439, 192, 469, 202] }, 'Tax ID No': { page: 1, bbox: [508, 192, 582, 202] },
  'ce for the Property is': { page: 1, bbox: [336, 460, 433, 470] },
  's Agents': { page: 2, bbox: [95, 549, 285, 559] }, 'Sellers Agents Utah Real Estate License Numbers': { page: 2, bbox: [228, 564, 501, 574] }, 'Sellers Brokerage': { page: 2, bbox: [98, 583, 266, 593] },
  's Agents_2': { page: 2, bbox: [95, 619, 284, 629] }, 's Agents Utah Real Estate License Numbers': { page: 2, bbox: [228, 637, 500, 647] }, 's Brokerage': { page: 2, bbox: [98, 655, 266, 665] },
  'Date_11': { page: 6, bbox: [212, 271, 388, 281] }, 'Date_12': { page: 6, bbox: [212, 288, 388, 298] }, 'Date_13': { page: 6, bbox: [212, 306, 388, 316] }, 'Date_14': { page: 6, bbox: [212, 323, 387, 333] },
  'Earnest Money Depos time': { page: 6, bbox: [64, 362, 103, 372] }, 'Date this offer shal': { page: 6, bbox: [221, 362, 322, 372] },
  'Date pg6': { page: 6, bbox: [209, 388, 255, 398] }, 'Date_15': { page: 6, bbox: [537, 388, 578, 398] }, 'Date_16': { page: 6, bbox: [171, 510, 225, 520] }, 'Date_17': { page: 6, bbox: [473, 509, 541, 519] },
  's Brokerage an Additional Earnest Money Deposit in the amount of': { page: 4, bbox: [377, 418, 457, 428] },
};

type FieldValues = Record<string, { value: string | null; type: string }>;

function isChecked(v: string | null | undefined): boolean { return !!v && !/^\/?(Off|No|False|0)$/i.test(v); }

function ex<T>(value: T | null, raw: string | null | undefined, field: string, tier: Tier, confidence: number, note?: string): Extracted<T> {
  const g = REPC_FIELD_GEOMETRY[field];
  return { value, raw: raw ?? undefined, page: g?.page, bbox: g?.bbox, tier, confidence, note };
}

export function extractRepcFromFields(fields: FieldValues): ExtractionResult {
  const M = REPC_FIELD_MAP; const warnings: string[] = [];
  const v = (k: keyof typeof M): string | null => fields[M[k]]?.value?.trim() || null;
  const filled = Object.values(fields).filter(f => f.value && !/^\/?Off$/.test(f.value)).length;
  if (filled === 0) warnings.push('No filled form fields: this PDF is flattened or blank. Falling back to the text layer.');

  const buyer1 = toIsoDate(v('buyer1_signed')); const buyer2 = toIsoDate(v('buyer2_signed'));
  const seller1 = toIsoDate(v('seller1_signed')); const seller2 = toIsoDate(v('seller2_signed'));
  const sellerSigned = [seller1, seller2].filter(Boolean).sort().pop() ?? null;
  const yearHint = [buyer1, seller1].filter(Boolean).map(d => Number((d as string).slice(0, 4)))[0];
  const offerDay = v('offer_day'); const offerMonth = v('offer_month');
  const offerRef = offerDay && offerMonth ? toIsoDate(`${offerMonth} ${offerDay}`, { defaultYear: yearHint }) : null;
  const financingYes = isChecked(v('financing_condition_yes')); const financingNo = isChecked(v('financing_condition_no'));
  const accepted = isChecked(v('accepted'));
  const fa = toIsoDate(v('financing_appraisal_deadline'));
  const isCash = financingNo && !financingYes;
  if (isCash && fa) warnings.push('Financing condition is marked NO (cash) but a Financing & Appraisal deadline is filled in.');

  const S = (k: keyof typeof M, val: string | null = v(k), conf = 0.98): Extracted => ex(val, v(k), M[k], 1, val ? conf : 0);
  const D = (k: keyof typeof M): Extracted => { const raw = v(k); const iso = toIsoDate(raw, { defaultYear: yearHint }); if (raw && !iso) warnings.push(`Could not read a date from "${raw}" (${k})`); return ex(iso, raw, M[k], 1, iso ? 0.98 : 0); };
  const $ = (k: keyof typeof M): Extracted<number> => { const raw = v(k); return ex(toMoney(raw), raw, M[k], 1, raw ? 0.98 : 0); };

  const fieldsOut: RepcFields = {
    buyer_names: S('buyer_names', cleanName(v('buyer_names'))), seller_names: S('seller_names', cleanName(v('seller_names'))),
    offer_reference_date: ex(offerRef, `${offerMonth ?? ''} ${offerDay ?? ''}`.trim(), M.offer_day, 1, offerRef ? 0.9 : 0),
    property_street: S('property_street'), property_city: S('property_city'), property_county: S('property_county'), property_zip: S('property_zip'), property_tax_id: S('property_tax_id'),
    purchase_price: $('purchase_price'), earnest_money: $('earnest_money'), earnest_money_form: S('earnest_money_form'),
    is_cash: ex(financingYes || financingNo ? isCash : null, financingNo ? 'no financing' : financingYes ? 'financing' : null, M.financing_condition_yes, 1, financingYes || financingNo ? 0.95 : 0),
    seller_agent: S('seller_agent'), seller_agent_license: S('seller_agent_license'), seller_brokerage: S('seller_brokerage'),
    buyer_agent: S('buyer_agent'), buyer_agent_license: S('buyer_agent_license'), buyer_brokerage: S('buyer_brokerage'),
    seller_disclosure_deadline: D('seller_disclosure_deadline'), due_diligence_deadline: D('due_diligence_deadline'),
    financing_appraisal_deadline: D('financing_appraisal_deadline'), settlement_deadline: D('settlement_deadline'),
    offer_expires_date: D('offer_expires_date'),
    offer_expires_time: ex(toTime(v('offer_expires_time'), isChecked(v('offer_expires_pm')) ? 'PM' : isChecked(v('offer_expires_am')) ? 'AM' : null), v('offer_expires_time'), M.offer_expires_time, 1, v('offer_expires_time') ? 0.9 : 0),
    buyer_signed_on: ex([buyer1, buyer2].filter(Boolean).sort().pop() ?? null, v('buyer1_signed'), M.buyer1_signed, 1, buyer1 ? 0.95 : 0),
    seller_signed_on: ex(sellerSigned, v('seller1_signed'), M.seller1_signed, 1, sellerSigned ? 0.95 : 0),
    acceptance_on: ex(accepted ? sellerSigned : null, accepted ? 'ACCEPTANCE box checked' : null, M.seller1_signed, 1, accepted && sellerSigned ? 0.85 : 0,
      accepted ? 'Acceptance = signed AND communicated (REPC 23). Seller signature date used; confirm the date it was communicated.' : 'ACCEPTANCE box not checked: confirm the acceptance date by hand.'),
    additional_emd: $('additional_emd'),
  };
  return { kind: 'repc', version: REPC_VERSION, tier: 1, fields: fieldsOut, warnings };
}

/* ---------------- Tier 2 / 3: geometric locator over tokens ---------------- */

/** Merge tokens on the same visual line (|dy| < tolerance) into line strings with a bbox. */
export function linesFromTokens(tokens: Token[], tol = 4): Array<Token & { parts: Token[] }> {
  const byPage = new Map<number, Token[]>();
  for (const t of tokens) { if (!byPage.has(t.page)) byPage.set(t.page, []); byPage.get(t.page)!.push(t); }
  const out: Array<Token & { parts: Token[] }> = [];
  for (const [page, toks] of byPage) {
    const sorted = [...toks].sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2 || a.x0 - b.x0);
    let cur: Token[] = [];
    const flush = () => { if (!cur.length) return; const ps = [...cur].sort((a, b) => a.x0 - b.x0); out.push({ page, text: ps.map(p => p.text).join(' '), x0: Math.min(...ps.map(p => p.x0)), y0: Math.min(...ps.map(p => p.y0)), x1: Math.max(...ps.map(p => p.x1)), y1: Math.max(...ps.map(p => p.y1)), parts: ps }); cur = []; };
    for (const t of sorted) {
      if (cur.length && Math.abs((t.y0 + t.y1) / 2 - (cur[0].y0 + cur[0].y1) / 2) > tol) flush();
      cur.push(t);
    }
    flush();
  }
  return out;
}

interface Anchor { page: number; label: RegExp; take: 'right' | 'after' | 'nextline' | 'line'; stopAt?: RegExp; minX?: number }

const ANCHORS: Record<string, Anchor> = {
  buyer_names: { page: 1, label: /Offer\s*Reference\s*Date/i, take: 'after', stopAt: /\(?\s*["“]?Buyer/i },
  seller_names: { page: 1, label: /^\s*from\b/i, take: 'after', stopAt: /\(?\s*["“]?Seller/i },
  earnest_money: { page: 1, label: /Earnest Money Deposit in the amount of/i, take: 'after', stopAt: /in the form/i },
  property_street: { page: 1, label: /^\s*1\.\s*PROPERTY/i, take: 'after' },
  property_city: { page: 1, label: /City of/i, take: 'after', stopAt: /,?\s*County/i },
  property_county: { page: 1, label: /County of/i, take: 'after', stopAt: /,?\s*State/i },
  property_zip: { page: 1, label: /Zip/i, take: 'after', stopAt: /Tax/i },
  property_tax_id: { page: 1, label: /Tax ID No\.?/i, take: 'after' },
  purchase_price: { page: 1, label: /Purchase Price for the Property is/i, take: 'after' },
  seller_agent: { page: 2, label: /Seller['’]?s Agent\(s\)/i, take: 'after', stopAt: /,?\s*represent/i },
  seller_brokerage: { page: 2, label: /Seller['’]?s Brokerage/i, take: 'after', stopAt: /,?\s*represent/i },
  buyer_agent: { page: 2, label: /Buyer['’]?s Agent\(s\)/i, take: 'after', stopAt: /,?\s*represent/i },
  buyer_brokerage: { page: 2, label: /Buyer['’]?s Brokerage/i, take: 'after', stopAt: /,?\s*represent/i },
  seller_disclosure_deadline: { page: 6, label: /Seller\s*Disclosure\s*Deadline/i, take: 'right' },
  due_diligence_deadline: { page: 6, label: /Due\s*Diligence\s*Deadline/i, take: 'right' },
  financing_appraisal_deadline: { page: 6, label: /Financing\s*&?\s*(and)?\s*Appraisal\s*Deadline/i, take: 'right' },
  settlement_deadline: { page: 6, label: /Settlement\s*Deadline/i, take: 'right' },
  offer_expires_date: { page: 6, label: /Mountain\s*Time\s*on/i, take: 'after' },
  offer_expires_time: { page: 6, label: /offer\s*by:?/i, take: 'after', stopAt: /AM|PM|Mountain/i },
};

export const DATE_RX = /((?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+\d{1,2},?\s*\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/;

export function bboxOf(parts: Token[]): [number, number, number, number] | undefined {
  if (!parts.length) return undefined;
  return [Math.min(...parts.map(p => p.x0)), Math.min(...parts.map(p => p.y0)), Math.max(...parts.map(p => p.x1)), Math.max(...parts.map(p => p.y1))];
}

export const PLACEHOLDER = /^[\s_,.:;()$"“”]*(\(Date\)|Date|\$)?[\s_,.:;()$"“”]*$/i;

/** Locate a value for one anchor. Returns raw text + bbox, or null. Works on PDF words and OCR lines alike. */
function locate(lines: ReturnType<typeof linesFromTokens>, all: Token[], a: Anchor): { raw: string; page: number; bbox?: [number, number, number, number] } | null {
  const cands = lines.filter(l => l.page === a.page && a.label.test(l.text));
  for (const line of cands) {
    const m = a.label.exec(line.text)!;
    if (a.take === 'line') return { raw: line.text, page: line.page, bbox: [line.x0, line.y0, line.x1, line.y1] };
    const labelEndIdx = m.index + m[0].length;
    // 1) value glued into the same string (OCR lines, or text-layer words that happened to merge)
    let after = line.text.slice(labelEndIdx);
    if (a.stopAt) { const s = a.stopAt.exec(after); if (s) after = after.slice(0, s.index); }
    after = after.replace(/^[\s,:_"“”)(]+|[\s,_"“”]+$/g, '');
    if (after && !PLACEHOLDER.test(after)) {
      let acc = 0; let endTok: Token | null = null;
      for (const p of line.parts) { acc += p.text.length + 1; if (acc >= labelEndIdx) { endTok = p; break; } }
      const parts = line.parts.filter(p => endTok ? p.x0 > endTok!.x0 : true);
      return { raw: after, page: line.page, bbox: bboxOf(parts) ?? [line.x0, line.y0, line.x1, line.y1] };
    }
    // 2) geometric: tokens on the page vertically overlapping the label line and to its right (the text
    //    layer often puts a filled value on its own line a few points above the label baseline)
    let acc = 0; let labelEndX = line.x0;
    for (const p of line.parts) { acc += p.text.length + 1; labelEndX = p.x1; if (acc >= labelEndIdx) break; }
    const cy = (line.y0 + line.y1) / 2; const h = Math.max(6, line.y1 - line.y0);
    const right = all.filter(t => t.page === a.page && t.x0 >= labelEndX - 2 && Math.abs((t.y0 + t.y1) / 2 - cy) < h * 0.9 && !PLACEHOLDER.test(t.text))
      .sort((x, y) => x.x0 - y.x0);
    if (right.length) {
      let raw = right.map(t => t.text).join(' ');
      if (a.stopAt) { const s = a.stopAt.exec(raw); if (s) raw = raw.slice(0, s.index); }
      raw = raw.replace(/^[\s,:_"“”)(]+|[\s,_"“”]+$/g, '');
      if (raw && !PLACEHOLDER.test(raw)) return { raw, page: line.page, bbox: bboxOf(right) };
    }
  }
  return null;
}

export function extractRepcFromTokens(tokens: Token[], tier: 2 | 3): ExtractionResult {
  const lines = linesFromTokens(tokens, tier === 3 ? 6 : 4);
  const warnings: string[] = [];
  const base = tier === 2 ? 0.85 : 0.7;
  const get = (k: string) => locate(lines, tokens, ANCHORS[k]);
  const E = (k: string, conv: (s: string) => string | null = s => s): Extracted => {
    const r = get(k); const val = r ? conv(r.raw) : null;
    if (r && !val) warnings.push(`Found "${r.raw}" for ${k} but could not normalise it`);
    return { value: val, raw: r?.raw, page: r?.page, bbox: r?.bbox, tier, confidence: val ? base : 0 };
  };
  const dateFrom = (s: string) => { const m = DATE_RX.exec(s); return toIsoDate(m ? m[1] : s); };
  const money = (k: string): Extracted<number> => { const r = get(k); const val = r ? toMoney(r.raw) : null; return { value: val, raw: r?.raw, page: r?.page, bbox: r?.bbox, tier, confidence: val ? base : 0 }; };

  // signature dates: all m/d/yyyy tokens in the bottom half of page 6, buyer side left (x<300) / seller side, ordered by y
  const sigDates = lines.filter(l => l.page === 6 && l.y0 > 340 && /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(l.text));
  const buyerSig = sigDates.filter(l => l.y0 < 450).map(l => toIsoDate(DATE_RX.exec(l.text)?.[1])).filter(Boolean).sort().pop() ?? null;
  const sellerSig = sigDates.filter(l => l.y0 >= 450).map(l => toIsoDate(DATE_RX.exec(l.text)?.[1])).filter(Boolean).sort().pop() ?? null;
  const fields: RepcFields = {
    buyer_names: E('buyer_names', cleanName), seller_names: E('seller_names', cleanName),
    offer_reference_date: { value: null, tier, confidence: 0, note: 'Offer Reference Date is split across three boxes on the form; confirm by hand.' },
    property_street: E('property_street', s => s.replace(/\s*\(the "Property"\).*$/i, '').trim() || null), property_city: E('property_city'), property_county: E('property_county'), property_zip: E('property_zip', s => (/\d{5}/.exec(s)?.[0] ?? null)), property_tax_id: E('property_tax_id'),
    purchase_price: money('purchase_price'), earnest_money: money('earnest_money'), earnest_money_form: { value: null, tier, confidence: 0 },
    is_cash: { value: null, tier, confidence: 0, note: 'Read the financing checkbox in section 8.3 by hand.' },
    seller_agent: E('seller_agent', cleanName), seller_agent_license: { value: null, tier, confidence: 0 }, seller_brokerage: E('seller_brokerage', cleanName),
    buyer_agent: E('buyer_agent', cleanName), buyer_agent_license: { value: null, tier, confidence: 0 }, buyer_brokerage: E('buyer_brokerage', cleanName),
    seller_disclosure_deadline: E('seller_disclosure_deadline', dateFrom), due_diligence_deadline: E('due_diligence_deadline', dateFrom),
    financing_appraisal_deadline: E('financing_appraisal_deadline', dateFrom), settlement_deadline: E('settlement_deadline', dateFrom),
    offer_expires_date: E('offer_expires_date', dateFrom), offer_expires_time: E('offer_expires_time', s => toTime(s, /PM/i.test(s) ? 'PM' : /AM/i.test(s) ? 'AM' : null)),
    buyer_signed_on: { value: buyerSig, tier, confidence: buyerSig ? base - 0.1 : 0 },
    seller_signed_on: { value: sellerSig, tier, confidence: sellerSig ? base - 0.1 : 0 },
    acceptance_on: { value: sellerSig, tier, confidence: sellerSig ? base - 0.2 : 0, note: 'Assumed = latest seller signature date. Confirm the ACCEPTANCE box and the date it was communicated (REPC 23).' },
    additional_emd: { value: null, tier, confidence: 0 },
  };
  return { kind: 'repc', version: REPC_VERSION, tier, fields, warnings };
}

/* ---------------- token adapters ---------------- */
export function tokensFromWords(pages: Array<{ page: number; words: [number, number, number, number, string][] | null }>): Token[] {
  const out: Token[] = [];
  for (const p of pages) for (const w of p.words ?? []) out.push({ page: p.page, x0: w[0], y0: w[1], x1: w[2], y1: w[3], text: w[4] });
  return out;
}
/** OCR boxes are in pixels at `dpi`; convert to PDF points. */
export function tokensFromOcr(page: number, dpi: number, lines: Array<{ box: [number, number][]; text: string }>): Token[] {
  const k = 72 / dpi;
  return lines.map(l => ({ page, text: l.text, x0: Math.min(...l.box.map(b => b[0])) * k, y0: Math.min(...l.box.map(b => b[1])) * k, x1: Math.max(...l.box.map(b => b[0])) * k, y1: Math.max(...l.box.map(b => b[1])) * k }));
}

/** Merge: prefer the higher-confidence value per field. */
export function mergeExtractions(primary: ExtractionResult, fallback: ExtractionResult): ExtractionResult {
  const fields = { ...primary.fields } as Record<string, Extracted<unknown>>;
  for (const [k, v] of Object.entries(fallback.fields) as Array<[string, Extracted<unknown>]>) {
    if ((fields[k]?.confidence ?? 0) < v.confidence) fields[k] = v;
  }
  return { kind: 'repc', version: primary.version, tier: primary.tier, fields: fields as unknown as RepcFields, warnings: [...primary.warnings, ...fallback.warnings] };
}
