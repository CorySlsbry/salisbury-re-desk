/**
 * CMA from an address, the way an appraiser starts: locate the subject, pull what is known about it, pull every comp
 * on hand (imported from the MLS export), measure distances, run Pat's ladder, run the grid, write the report.
 * The only network call is the US Census geocoder (a public property address, never a client name); results are cached.
 */
import { readTextFile, mkdir, exists } from '@tauri-apps/plugin-fs';
import { appPaths, doc, native } from './native';
import * as repo from './repo';
import * as cmaRepo from './repoCma';
import { importCsv, addressKey, type ImportReport } from './compImport';
import { selectComps, distanceMi, type Candidate, type Selection } from './compSelect';
import { runCma, DEFAULT_UNITS, type Attrs, type CmaResult, type UnitValues } from './cma';
import { money } from './fmt';

export interface Located { address: string; lat: number | null; lng: number | null; matched: string | null; source: string | null }
/**
 * Locate an address through the Rust side (Utah's statewide address points first, then the US Census geocoder, then
 * OpenStreetMap), cached per address. A "manual" source is a coordinate Cory pasted. Off when Settings > geocoder is "off".
 */
export async function geocode(address: string): Promise<Located> {
  const key = address.trim().replace(/\s+/g, ' ');
  const cached = await cmaRepo.getGeo(key);
  if (cached && cached.lat != null) return { address: key, lat: cached.lat, lng: cached.lng, matched: cached.matched, source: cached.matched?.startsWith('manual') ? 'manual' : 'cache' };
  const s = await repo.getSettings();
  if (s.geocoder === 'off') return { address: key, lat: null, lng: null, matched: null, source: null };
  const hit = await native.geocodeLookup(key);
  const out: Located = hit ? { address: key, lat: hit[0], lng: hit[1], matched: hit[2], source: hit[3] } : { address: key, lat: null, lng: null, matched: null, source: null };
  await cmaRepo.setGeo(key, out.lat, out.lng, out.matched);
  return out;
}
/** Cory pastes a coordinate from Google Maps (right-click the pin, click the numbers) when no geocoder knows a brand-new street. */
export async function setManualLocation(address: string, lat: number, lng: number): Promise<Located> {
  const key = address.trim().replace(/\s+/g, ' ');
  await cmaRepo.setGeo(key, lat, lng, `manual ${lat.toFixed(5)}, ${lng.toFixed(5)}`);
  return { address: key, lat, lng, matched: `manual ${lat.toFixed(5)}, ${lng.toFixed(5)}`, source: 'manual' };
}

/** What the app already knows about the subject: the client's property row, or a prior MLS listing of the same address. */
export async function subjectHints(address: string, zip?: string | null): Promise<{ attrs: Partial<Attrs>; source: string | null; transactionId: number | null }> {
  const k = addressKey(address, zip);
  const prior = await cmaRepo.findMlsCompByAddress(k);
  let attrs: Partial<Attrs> = {}; let source: string | null = null;
  if (prior) { attrs = { sqft: prior.sqft ?? undefined, basementFinishedSqft: prior.basement_finished_sqft ?? undefined, beds: prior.beds ?? undefined, fullBaths: prior.full_baths ?? undefined, threeQuarterBaths: prior.three_quarter_baths ?? undefined, halfBaths: prior.half_baths ?? undefined, yearBuilt: prior.year_built ?? undefined, garage: prior.garage ?? undefined, acres: prior.acres ?? undefined, style: prior.style ?? undefined }; source = `prior MLS listing ${prior.mls_number ?? ''} (${prior.status}, ${prior.sold_on ?? prior.list_date ?? 'no date'})`; }
  let transactionId: number | null = null;
  const street = address.split(',')[0].trim().toLowerCase();
  for (const tx of await repo.listTransactions()) {
    if (tx.street && tx.street.trim().toLowerCase() === street) {
      transactionId = tx.id;
      const p = tx.property_id ? await repo.getProperty(tx.property_id) : null;
      if (p?.year_built && attrs.yearBuilt == null) { attrs.yearBuilt = p.year_built; source = source ?? `client file (${tx.last_name}, ${tx.first_name})`; }
      break;
    }
  }
  return { attrs, source, transactionId };
}

/** Import an MLS export file into the comps table. */
export async function importExport(path: string, onStep?: (s: string) => void): Promise<ImportReport & { added: number; updated: number }> {
  onStep?.('Reading the export');
  const text = await readTextFile(path);
  const report = importCsv(text);
  if (report.missing.length) throw new Error(`The export is missing columns the CMA needs: ${report.missing.join(', ')}. Its headers were: ${Object.values(report.mapped).concat(report.unmapped).join(', ')}.`);
  onStep?.(`Saving ${report.comps.length} listing(s)`);
  const r = await cmaRepo.upsertMlsComps(report.comps, path.split(/[\\/]/).pop() ?? 'export.csv');
  await repo.logEvent('cma.export_imported', undefined, undefined, { file: path.split(/[\\/]/).pop(), rows: report.comps.length, ...r, unmapped: report.unmapped });
  return { ...report, ...r };
}

/** Every imported listing as a candidate with its distance from the subject; locates the ones the export left without coordinates. */
export async function candidatePool(subject: { lat: number; lng: number }, onStep?: (s: string) => void): Promise<Candidate[]> {
  const rows = await cmaRepo.listMlsComps();
  const out: Candidate[] = []; let located = 0;
  for (const r of rows) {
    let lat = r.lat, lng = r.lng;
    if (lat == null || lng == null) {
      onStep?.(`Locating ${r.address}`);
      const g = await geocode([r.address, r.city, r.zip].filter(Boolean).join(', '));
      lat = g.lat; lng = g.lng; if (lat != null) { located++; await cmaRepo.setMlsCompGeo(r.id, lat, lng); }
    }
    if (r.sqft == null) continue;
    out.push({
      id: String(r.id), label: `${r.address}${r.city ? ', ' + r.city : ''}${r.mls_number ? ` (MLS ${r.mls_number})` : ''}`,
      salePrice: r.sold_price ?? r.list_price ?? 0, soldOn: r.sold_on ?? undefined, status: r.status === 'other' ? undefined : r.status,
      sqft: r.sqft, basementFinishedSqft: r.basement_finished_sqft ?? 0, beds: r.beds ?? 0, fullBaths: r.full_baths ?? 0, threeQuarterBaths: r.three_quarter_baths ?? 0, halfBaths: r.half_baths ?? 0,
      yearBuilt: r.year_built ?? 0, garage: r.garage ?? 0, acres: r.acres ?? 0, updatingUnits: 0, style: r.style ?? undefined,
      lat, lng, distanceMi: lat != null && lng != null ? distanceMi(subject.lat, subject.lng, lat, lng) : undefined,
    });
  }
  if (located) onStep?.(`Located ${located} listing(s) the export had no coordinates for`);
  return out.filter(c => c.salePrice > 0);
}

export interface CmaRun { address: string; located: Located; subject: Attrs; selection: Selection; result: CmaResult; units: UnitValues; today: string }
/** Pat's ladder over the pool, then the appraisal grid over the chosen comps. Pure given the pool. */
export function buildCma(address: string, located: Located, subject: Attrs, pool: Candidate[], units: UnitValues = DEFAULT_UNITS, today = repo.today()): CmaRun {
  const selection = selectComps(subject, pool, today);
  const comps = [...selection.chosen, ...selection.context.active, ...selection.context.underContract];
  const result = runCma(subject, comps, units);
  return { address, located, subject, selection, result, units, today };
}

/** The report as text blocks for the doc engine: subject, rung, grid, dropped, context, three numbers. Pure. */
export function reportBlocks(run: CmaRun): Array<{ text: string; size?: number; bold?: boolean; gap?: number }> {
  const b: Array<{ text: string; size?: number; bold?: boolean; gap?: number }> = [];
  const s = run.subject, sel = run.selection, r = run.result;
  b.push({ text: `Comparative Market Analysis: ${run.address}`, size: 16, bold: true, gap: 4 });
  b.push({ text: `Prepared ${run.today} by Cory Salisbury, REALTOR, Simple Choice Real Estate. Appraisal-style grid: each comp is adjusted toward the subject. Not an appraisal.`, size: 9, gap: 8 });
  b.push({ text: 'Subject', size: 12, bold: true });
  b.push({ text: `${s.sqft} sqft above grade, ${s.basementFinishedSqft ?? 0} sqft finished basement, ${s.beds} bed, ${s.fullBaths} full / ${s.threeQuarterBaths ?? 0} three-quarter / ${s.halfBaths ?? 0} half bath, built ${s.yearBuilt}, ${s.garage}-car garage, ${s.acres ?? 0} acres, style ${s.style ?? 'unknown'}, updating ${s.updatingUnits ?? 0}.`, size: 10, gap: 6 });
  b.push({ text: 'How the comps were chosen', size: 12, bold: true });
  b.push({ text: `Same style only. Radius ${sel.rung.radiusMi} mi, sold within ${sel.rung.windowDays} days, ${Math.round(sel.rung.band[0] * 100)}%-${Math.round(sel.rung.band[1] * 100)}% of the subject's square footage${sel.rung.adjacentStyle ? ', one adjacent style borrowed' : ''}. ${sel.rungsTried} rung(s) of the ladder climbed. ${sel.notes.join(' ')}`, size: 10, gap: 6 });
  b.push({ text: 'Sold comps and adjustments (comp adjusted toward the subject)', size: 12, bold: true });
  for (const a of r.adjusted) {
    const drop = r.dropped.find(d => d.comp === a);
    b.push({ text: `${a.comp.label}: sold ${money(a.comp.salePrice)}${a.comp.soldOn ? ' on ' + a.comp.soldOn : ''}${a.comp.distanceMi != null ? `, ${a.comp.distanceMi} mi` : ''}. ${a.comp.sqft} sqft, ${a.comp.beds} bed, ${a.comp.fullBaths} full bath, built ${a.comp.yearBuilt}, ${a.comp.garage}-car, ${a.comp.style ?? ''}.`, size: 10, bold: true });
    b.push({ text: a.lines.length ? a.lines.map(l => `  ${l.item}: ${l.diff > 0 ? '+' : ''}${l.diff} x ${money(l.unit)} = ${l.adjustment >= 0 ? '+' : ''}${money(l.adjustment)}`).join('\n') : '  no adjustments', size: 9 });
    b.push({ text: `  Net ${a.net >= 0 ? '+' : ''}${money(a.net)} (${(a.netPct * 100).toFixed(1)}%), gross ${money(a.gross)} (${(a.grossPct * 100).toFixed(1)}%), adjusted value ${money(a.adjusted)}${drop ? `. DROPPED: ${drop.why}` : ''}`, size: 9, gap: 4 });
  }
  if (sel.considered.length) { b.push({ text: 'Considered and not used', size: 12, bold: true }); b.push({ text: sel.considered.slice(0, 25).map(c => `${c.comp.label}: ${c.reason}`).join('\n'), size: 9, gap: 6 }); }
  if (sel.context.active.length || sel.context.underContract.length) {
    b.push({ text: 'Context (not in the math)', size: 12, bold: true });
    b.push({ text: [...sel.context.active.map(c => `Active: ${c.label}, asking ${money(c.salePrice)}, ${c.sqft} sqft`), ...sel.context.underContract.map(c => `Under contract: ${c.label}, listed ${money(c.salePrice)}, ${c.sqft} sqft`)].join('\n'), size: 9, gap: 6 });
  }
  b.push({ text: 'Indicated value', size: 12, bold: true });
  b.push({ text: `Median of adjusted survivors ${money(r.medianAdjusted)}; reliability-weighted value ${money(r.indicated)} (divergence ${(r.divergencePct * 100).toFixed(1)}%). Confidence: ${r.confidence}.${r.warnings.length ? ' ' + r.warnings.join(' ') : ''}`, size: 10, gap: 4 });
  b.push({ text: `List / top dollar: ${money(r.listTop)}    Realistic: ${money(r.realistic)}    Floor: ${money(r.floor)}`, size: 12, bold: true, gap: 8 });
  b.push({ text: 'Equal Housing Opportunity. Simple Choice Real Estate. This analysis is an opinion of value for pricing, not an appraisal.', size: 8 });
  return b;
}

/** Save the CMA row and write the PDF: into the client folder when the subject is a client file, else Documents\\Salisbury RE\\CMAs. */
export async function saveCma(run: CmaRun, transactionId: number | null): Promise<{ id: number; pdfPath: string }> {
  const paths = await appPaths();
  let dir = `${paths.root}\\CMAs`;
  if (transactionId) { const tx = await repo.getTransaction(transactionId); const c = tx ? await repo.getClient(tx.client_id) : null; if (c?.folder_path) dir = `${c.folder_path}\\00 Intake`; }
  const safe = run.address.replace(/[^A-Za-z0-9 ,.-]/g, '').slice(0, 60);
  const pdfPath = `${dir}\\CMA ${safe} ${run.today}.pdf`;
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  await doc.make(pdfPath, reportBlocks(run));
  const id = await cmaRepo.saveCmaRow({ address: run.address, lat: run.located.lat, lng: run.located.lng, transactionId, subject: run.subject, selection: { rung: run.selection.rung, rungsTried: run.selection.rungsTried, chosen: run.selection.chosen.map(c => c.id), notes: run.selection.notes, considered: run.selection.considered.map(c => ({ id: c.comp.id, reason: c.reason })) }, result: { indicated: run.result.indicated, listTop: run.result.listTop, realistic: run.result.realistic, floor: run.result.floor, confidence: run.result.confidence, survivors: run.result.survivors.length, dropped: run.result.dropped.map(d => ({ id: d.comp.comp.id, why: d.why })) }, pdfPath });
  await repo.logEvent('cma.saved', 'cma', id, { address: run.address, indicated: run.result.indicated, confidence: run.result.confidence, comps: run.selection.chosen.length, pdfPath });
  return { id, pdfPath };
}
