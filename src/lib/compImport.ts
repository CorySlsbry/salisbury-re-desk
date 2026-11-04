/**
 * Read an MLS export (CSV) into comps. Header names vary by export; the mapper recognises the common spellings
 * (UtahRealEstate.com, RESO field names, generic) and reports what it could not map so the header can be added here.
 * Pure: no database, no network. Tested with synthetic exports.
 */
export interface MlsComp {
  key: string; mlsNumber: string | null; address: string; city: string | null; zip: string | null; lat: number | null; lng: number | null;
  status: 'sold' | 'active' | 'under_contract' | 'other'; listPrice: number | null; soldPrice: number | null; soldOn: string | null; listDate: string | null; dom: number | null;
  sqft: number | null; basementFinishedSqft: number | null; beds: number | null; fullBaths: number | null; threeQuarterBaths: number | null; halfBaths: number | null;
  yearBuilt: number | null; garage: number | null; acres: number | null; style: string | null; styleRaw: string | null;
}
export interface ImportReport { comps: MlsComp[]; mapped: Record<string, string>; unmapped: string[]; skipped: number; missing: string[] }

/** RFC 4180-style CSV: quotes, doubled quotes, commas and newlines inside quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let inQ = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) { if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += ch; continue; }
    if (ch === '"') { inQ = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** Field -> accepted header spellings (normalised). Order matters: the first match wins. */
const HEADERS: Record<string, string[]> = {
  mlsNumber: ['mls', 'mls number', 'mls id', 'listing id', 'listingid', 'listing number', 'ml'],
  address: ['address', 'street address', 'property address', 'full address', 'unparsed address', 'unparsedaddress', 'street'],
  city: ['city', 'city name'],
  zip: ['zip', 'zip code', 'postal code', 'postalcode', 'zipcode'],
  lat: ['latitude', 'lat'],
  lng: ['longitude', 'lng', 'long', 'lon'],
  status: ['status', 'listing status', 'standard status', 'standardstatus', 'mls status', 'prop status'],
  listPrice: ['list price', 'listprice', 'current price', 'asking price', 'original list price'],
  soldPrice: ['sold price', 'soldprice', 'close price', 'closeprice', 'sale price', 'saleprice', 'closed price'],
  soldOn: ['sold date', 'solddate', 'close date', 'closedate', 'closing date', 'sale date', 'date sold'],
  listDate: ['list date', 'listdate', 'listing date', 'on market date', 'onmarketdate'],
  dom: ['dom', 'days on market', 'daysonmarket', 'cdom', 'cumulative days on market'],
  sqft: ['above grade finished area', 'abovegradefinishedarea', 'above grade sqft', 'sqft above grade', 'finished sqft above grade', 'total sqft', 'total square feet', 'square feet', 'sqft', 'sq ft', 'living area', 'livingarea', 'finished sqft', 'total finished sqft'],
  basementFinishedSqft: ['below grade finished area', 'belowgradefinishedarea', 'basement finished sqft', 'basement sqft finished', 'finished basement sqft', 'bsmt finished sqft'],
  beds: ['beds', 'bedrooms', 'total bedrooms', 'bedroomstotal', 'bedrooms total', 'br'],
  fullBaths: ['full baths', 'baths full', 'bathsfull', 'fullbaths', 'full bathrooms'],
  threeQuarterBaths: ['3 4 baths', 'three quarter baths', 'baths three quarter', 'bathsthreequarter', '3 4 bath'],
  halfBaths: ['half baths', 'baths half', 'bathshalf', 'halfbaths', 'half bathrooms'],
  bathsTotal: ['baths', 'total baths', 'bathrooms', 'bathroomstotalinteger', 'bathrooms total', 'total bathrooms'],
  yearBuilt: ['year built', 'yearbuilt', 'yr built', 'built'],
  garage: ['garage spaces', 'garagespaces', 'garage capacity', 'garage', 'garage stalls', 'covered parking'],
  acres: ['acres', 'lot size acres', 'lotsizeacres', 'lot acres', 'lot size'],
  style: ['style', 'architectural style', 'architecturalstyle', 'property style', 'house style', 'levels'],
};
export function mapHeaders(headers: string[]): { mapped: Record<string, number>; unmapped: string[] } {
  const normed = headers.map(norm); const mapped: Record<string, number> = {}; const used = new Set<number>();
  for (const [field, names] of Object.entries(HEADERS)) {
    for (const n of names) { const i = normed.findIndex((h, idx) => h === n && !used.has(idx)); if (i >= 0) { mapped[field] = i; used.add(i); break; } }
  }
  return { mapped, unmapped: headers.filter((_, i) => !used.has(i)) };
}

/** MLS style names -> the app's six styles. Anything else keeps its raw name so it never silently matches. */
export function normalizeStyle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (/rambler|ranch|one story|1 story|single level|single story/.test(s)) return 'rambler';
  if (/split.?entry|bi.?level|split foyer/.test(s)) return 'split-entry';
  if (/multi.?level|tri.?level|split.?level/.test(s)) return 'multi-level';
  if (/townho|town home|row house|attached/.test(s)) return 'townhome';
  if (/condo/.test(s)) return 'condo';
  if (/2 story|two story|2-story|two-story|2 stories|story\/2|stories: 2/.test(s)) return 'two-story';
  return s.trim();
}
export function normalizeStatus(raw: string | null | undefined): MlsComp['status'] {
  const s = (raw ?? '').toLowerCase();
  if (/sold|closed/.test(s)) return 'sold';
  if (/under contract|pending|backup|contingent|active under contract|show for backup/.test(s)) return 'under_contract';
  if (/^active|^act$|for sale|coming soon/.test(s)) return 'active';
  return 'other';
}
const num = (v: string | undefined): number | null => { if (v == null) return null; const n = Number(String(v).replace(/[^0-9.-]/g, '')); return Number.isFinite(n) && String(v).trim() !== '' ? n : null; };
const int = (v: string | undefined): number | null => { const n = num(v); return n == null ? null : Math.round(n); };
const date = (v: string | undefined): string | null => {
  if (!v) return null; const s = v.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s); if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s); if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
};
export const addressKey = (address: string, zip?: string | null) => `${address}|${zip ?? ''}`.toLowerCase().replace(/[^a-z0-9|]/g, '');

export function importCsv(text: string): ImportReport {
  const rows = parseCsv(text);
  if (!rows.length) return { comps: [], mapped: {}, unmapped: [], skipped: 0, missing: ['address'] };
  const headers = rows[0]; const { mapped, unmapped } = mapHeaders(headers);
  const get = (r: string[], f: string) => (mapped[f] != null ? r[mapped[f]] : undefined);
  const missing = ['address', 'status', 'sqft'].filter(f => mapped[f] == null);
  if (mapped.soldPrice == null && mapped.listPrice == null) missing.push('sold price');
  const comps: MlsComp[] = []; let skipped = 0;
  for (const r of rows.slice(1)) {
    const address = (get(r, 'address') ?? '').trim();
    if (!address) { skipped++; continue; }
    const status = normalizeStatus(get(r, 'status'));
    const mls = (get(r, 'mlsNumber') ?? '').trim() || null;
    const zip = (get(r, 'zip') ?? '').trim() || null;
    let full = int(get(r, 'fullBaths')), tq = int(get(r, 'threeQuarterBaths')), half = int(get(r, 'halfBaths'));
    if (full == null && tq == null && half == null) { const t = num(get(r, 'bathsTotal')); if (t != null) { full = Math.floor(t); half = Math.round((t - Math.floor(t)) * 2); } }
    const sqft = int(get(r, 'sqft'));
    comps.push({
      key: mls ? `mls:${mls}` : `addr:${addressKey(address, zip)}`, mlsNumber: mls, address, city: (get(r, 'city') ?? '').trim() || null, zip,
      lat: num(get(r, 'lat')), lng: num(get(r, 'lng')), status,
      listPrice: int(get(r, 'listPrice')), soldPrice: int(get(r, 'soldPrice')), soldOn: date(get(r, 'soldOn')), listDate: date(get(r, 'listDate')), dom: int(get(r, 'dom')),
      sqft, basementFinishedSqft: int(get(r, 'basementFinishedSqft')), beds: int(get(r, 'beds')), fullBaths: full, threeQuarterBaths: tq, halfBaths: half,
      yearBuilt: int(get(r, 'yearBuilt')), garage: int(get(r, 'garage')), acres: num(get(r, 'acres')), style: normalizeStyle(get(r, 'style')), styleRaw: (get(r, 'style') ?? '').trim() || null,
    });
  }
  return { comps, mapped: Object.fromEntries(Object.entries(mapped).map(([f, i]) => [f, headers[i]])), unmapped, skipped, missing };
}
