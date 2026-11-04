/**
 * Listing agreement (UAR Form 8, rev 11.5.2024) and Exclusive Buyer-Broker Agreement (UAR Form 6, rev 6.20.2024).
 * Both are flat PDFs (no AcroForm), so values are read from where they sit on the page: each blank on the form
 * is a known zone in PDF points. Tier 2 = text-layer words inside the zone; tier 3 = OCR lines overlapping the
 * zone, with the form's own label text stripped by a per-zone regex. Every value carries page + bbox for the crop.
 */
import type { AgreementExtraction, AgreementFields, AgreementKind, Extracted, Tier, Token } from './types';
import { DATE_RX, PLACEHOLDER, bboxOf } from './repc';
import { cleanName, toIsoDate, toMoney } from './normalize';

interface Zone { page: number | 'last'; box: [number, number, number, number]; label?: RegExp; strip?: RegExp }

/** Blank positions measured on the blank forms (tests/make_agreement_fixtures.py prints them). */
const LISTING_ZONES: Record<string, Zone> = {
  company: { page: 1, box: [36, 145, 237, 157], strip: /\(the\s*["“]?Company["”]?\).*$/i },
  agent: { page: 1, box: [310, 145, 501, 157], label: /\(the\s*["“]?Company["”]?\),?\s*(.*?)\s*(?:as the authorized.*)?$/i },
  client_names: { page: 1, box: [233, 158, 454, 171], label: /Agent["”]?\)\s*and\s*(.*?)\s*(?:\(the\s*["“]?Seller.*)?$/i },
  property: { page: 1, box: [190, 191, 576, 203], label: /described as:?\s*(.*)$/i },
  property2: { page: 1, box: [36, 203, 156, 215], strip: /\(the\s*["“]?Property["”]?\).*$/i },
  end_date: { page: 1, box: [313, 226, 474, 239], label: /Mountain Time\)?\s*on\s*(.*?)\s*(?:\(End Date.*)?$/i },
  fee_pct: { page: 1, box: [465, 319, 513, 331], label: /amount of\s*_*\s*([\d.]+)\s*_*\s*%/i },
  fee_flat: { page: 1, box: [541, 319, 576, 331], label: /%\s*and\s*\$\s*_*\s*([\d,.]+)/i },
  coop_offer_pct: { page: 1, box: [36, 403, 74, 415], label: /^\s*_*\s*([\d.]+)\s*_*\s*%/i },
  coop_offer_flat: { page: 1, box: [90, 403, 126, 415], label: /or\s*\$\s*_*\s*([\d,.]+)/i },
  client_contact: { page: 'last', box: [252, 258, 513, 271] },
  client_signed: { page: 'last', box: [252, 258, 513, 271] },
  agent_signed: { page: 'last', box: [288, 367, 328, 380] },
};
const BBA_ZONES: Record<string, Zone> = {
  company: { page: 1, box: [22, 124, 227, 135], strip: /\(the\s*["“]?Company["”]?\).*$/i },
  agent: { page: 1, box: [278, 124, 502, 135], label: /\(the\s*["“]?Company["”]?\),?\s*(.*?)\s*(?:as the authorized.*)?$/i },
  client_names: { page: 1, box: [178, 135, 411, 147], label: /Agent["”]?\)\s*and\s*(.*?)\s*(?:\(the\s*["“]?Buyer.*)?$/i },
  end_date: { page: 1, box: [17, 209, 245, 220], strip: /\(End Date\).*$/i },
  search_area: { page: 1, box: [145, 254, 587, 266], label: /within:?\s*(.*?)\s*(?:\(County.*)?$/i, strip: /\(?County\/Counties\)?;?/gi },
  property: { page: 1, box: [125, 288, 590, 299], label: /located only at:?\s*(.*)$/i, strip: /^\s*at:?\s*/i },
  property2: { page: 1, box: [22, 299, 586, 311], strip: /\(property\/properties\).*$/i },
  fee_flat: { page: 1, box: [180, 488, 239, 500], label: /\$\s*_*\s*([\d,.]+)/i },
  fee_pct: { page: 1, box: [257, 488, 292, 500], label: /_*\s*([\d.]+)\s*_*\s*%/i },
  client_contact: { page: 'last', box: [238, 340, 443, 351] },
  client_signed: { page: 'last', box: [490, 340, 531, 351] },
  agent_signed: { page: 'last', box: [310, 442, 351, 453] },
};
export const AGREEMENT_VERSIONS: Record<AgreementKind, string> = { listing_agreement: '11.5.2024', bba: '6.20.2024' };

function clean(s: string): string { return s.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').replace(/^[\s,:;"“”)(]+|[\s,:;"“”(]+$/g, '').trim(); }

/** Read one zone. Words (tier 2) must sit inside the box; OCR lines (tier 3) only need to overlap it. */
function readZone(tokens: Token[], z: Zone, tier: Tier, lastPage: number): { raw: string; page: number; bbox?: [number, number, number, number] } | null {
  const page = z.page === 'last' ? lastPage : z.page;
  const [x0, y0, x1, y1] = z.box;
  const cy = (t: Token) => (t.y0 + t.y1) / 2, cx = (t: Token) => (t.x0 + t.x1) / 2;
  const vTol = tier === 3 ? 9 : 4;
  let hits = tokens.filter(t => t.page === page && cy(t) >= y0 - vTol && cy(t) <= y1 + 3 && !/^_+$/.test(t.text));
  if (tier === 3) {
    // OCR tokens are whole lines: keep only the line(s) nearest the zone's centre, so the line above never bleeds in
    hits = hits.filter(t => Math.min(t.x1, x1) - Math.max(t.x0, x0) > 0);
    const zc = (y0 + y1) / 2; const best = Math.min(...hits.map(t => Math.abs(cy(t) - zc)));
    hits = hits.filter(t => Math.abs(cy(t) - zc) <= best + 3);
  } else {
    hits = hits.filter(t => cx(t) >= x0 - 2 && cx(t) <= x1 + 2);
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a.x0 - b.x0);
  let raw = hits.map(t => t.text.replace(/_+/g, ' ')).join(' ');
  if (z.label) { const m = z.label.exec(raw); if (m) raw = m[1]; else if (tier === 3) return null; }
  if (z.strip) raw = raw.replace(z.strip, ' ');
  raw = clean(raw);
  if (!raw || PLACEHOLDER.test(raw)) return null;
  return { raw, page, bbox: bboxOf(hits) };
}

/** Last valid m/d/yyyy on a line; tolerates OCR runs like "555-01429/5/2026". */
export function lastDate(s: string): string | null {
  let best: string | null = null;
  const rx = /\d{1,2}\/\d{1,2}\/\d{2,4}/g; let m: RegExpExecArray | null;
  while ((m = rx.exec(s))) {
    const iso = toIsoDate(m[0]) ?? toIsoDate(m[0].slice(1));
    if (iso) best = iso;
    rx.lastIndex = m.index + 1;
  }
  if (!best) { const d = DATE_RX.exec(s); if (d) best = toIsoDate(d[1]); }
  return best;
}

/** "1842 W Harvest Moon Dr, Lehi, Utah 84043 Utah County" -> street / city / county / zip. */
export function splitAddress(s: string): { street: string; city: string | null; county: string | null; zip: string | null } {
  const zip = /\b(\d{5})(?:-\d{4})?\b/.exec(s)?.[1] ?? null;
  const county = /\b([A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)?) County\b/.exec(s)?.[1] ?? null;
  const rest = s.replace(/\b\d{5}(?:-\d{4})?\b/, '').replace(/\b[A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)? County\b/, '').replace(/,?\s*\b(Utah|UT)\b\.?/gi, '');
  const parts = rest.split(',').map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return { street: parts[0] ?? s.trim(), city: parts[1] ?? null, county, zip };
}

export function extractAgreement(tokens: Token[], kind: AgreementKind, tier: 2 | 3): AgreementExtraction {
  const Z = kind === 'listing_agreement' ? LISTING_ZONES : BBA_ZONES;
  const lastPage = Math.max(1, ...tokens.map(t => t.page));
  const base = tier === 2 ? 0.85 : 0.7;
  const warnings: string[] = [];
  const get = (k: string) => (Z[k] ? readZone(tokens, Z[k], tier, lastPage) : null);
  const E = <T = string,>(k: string, conv: (s: string) => T | null, note?: string): Extracted<T> => {
    const r = get(k); const value = r ? conv(r.raw) : null;
    if (r && value == null) warnings.push(`Found "${r.raw}" for ${k} but could not normalise it`);
    return { value, raw: r?.raw, page: r?.page, bbox: r?.bbox, tier, confidence: value != null ? base : 0, note };
  };
  const num = (s: string) => { const n = toMoney(s); return n; };

  const p1 = get('property'), p2 = get('property2');
  const propertyRaw = [p1?.raw, p2?.raw].filter(Boolean).join(' ').trim();
  const addr = propertyRaw ? splitAddress(propertyRaw) : null;
  const propEx = (v: string | null, conf = base): Extracted => ({ value: v, raw: propertyRaw || undefined, page: p1?.page ?? p2?.page, bbox: p1?.bbox ?? p2?.bbox, tier, confidence: v ? conf : 0 });

  const contact = get('client_contact');
  const contactText = contact?.raw ?? '';
  const phone = /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.exec(contactText)?.[0] ?? null;
  const address = contactText.replace(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/, '').replace(/\d{1,2}\/\d{1,2}\/\d{2,4}\s*$/, '').trim() || null;
  const signedRaw = get('client_signed');
  const clientSigned = signedRaw ? lastDate(signedRaw.raw) : null;
  const agentSignedRaw = get('agent_signed');
  const agentSigned = agentSignedRaw ? lastDate(agentSignedRaw.raw) : null;

  // form revision: "Revised 11.5.2024" / "REVISED 6.20.2024" in the footer of the last page
  const revTok = tokens.filter(t => t.page === lastPage);
  const revText = revTok.map(t => t.text).join(' ');
  const rev = /Revised\s+(\d{1,2}\.\d{1,2}\.\d{4})/i.exec(revText)?.[1] ?? null;
  if (rev && rev !== AGREEMENT_VERSIONS[kind]) warnings.push(`This is form revision ${rev}; the reader was measured on ${AGREEMENT_VERSIONS[kind]}. Check every field.`);
  if (!rev) warnings.push('Could not read the form revision from the footer; check every field.');

  const fields: AgreementFields = {
    company: E('company', cleanName), agent: E('agent', cleanName),
    client_names: E('client_names', cleanName),
    property_street: propEx(addr?.street ?? null), property_city: propEx(addr?.city ?? null, base - 0.1), property_county: propEx(addr?.county ?? null), property_zip: propEx(addr?.zip ?? null),
    search_area: kind === 'bba' ? E('search_area', s => s) : { value: null, tier, confidence: 0 },
    end_date: E('end_date', s => { const m = DATE_RX.exec(s); return toIsoDate(m ? m[1] : s); }),
    fee_pct: E<number>('fee_pct', num), fee_flat: E<number>('fee_flat', num),
    coop_offer_pct: kind === 'listing_agreement' ? E<number>('coop_offer_pct', num) : { value: null, tier, confidence: 0 },
    coop_offer_flat: kind === 'listing_agreement' ? E<number>('coop_offer_flat', num) : { value: null, tier, confidence: 0 },
    client_phone: { value: phone, raw: contact?.raw, page: contact?.page, bbox: contact?.bbox, tier, confidence: phone ? base - 0.1 : 0 },
    client_address: { value: address, raw: contact?.raw, page: contact?.page, bbox: contact?.bbox, tier, confidence: address ? base - 0.2 : 0 },
    client_signed_on: { value: clientSigned, raw: signedRaw?.raw, page: signedRaw?.page, bbox: signedRaw?.bbox, tier, confidence: clientSigned ? base - 0.1 : 0, note: 'The agreement is effective when signed by ALL parties.' },
    agent_signed_on: { value: agentSigned, raw: agentSignedRaw?.raw, page: agentSignedRaw?.page, bbox: agentSignedRaw?.bbox, tier, confidence: agentSigned ? base - 0.1 : 0 },
    form_revision: { value: rev, tier, confidence: rev ? 0.95 : 0 },
  };
  return { kind, version: rev ?? AGREEMENT_VERSIONS[kind], tier, fields, warnings };
}
