/** Data access for the CMA-from-an-address flow (migration 0009): geocode cache, imported MLS comps, saved CMAs. */
import { db } from './native';
import type { MlsComp } from './compImport';

export interface GeoRow { address: string; lat: number | null; lng: number | null; matched: string | null; at: string }
export async function getGeo(address: string): Promise<GeoRow | null> { const d = await db(); const r = await d.select<GeoRow[]>('SELECT * FROM geocache WHERE address=$1', [address]); return r[0] ?? null; }
export async function setGeo(address: string, lat: number | null, lng: number | null, matched: string | null): Promise<void> { const d = await db(); await d.execute("INSERT INTO geocache(address, lat, lng, matched) VALUES ($1,$2,$3,$4) ON CONFLICT(address) DO UPDATE SET lat=excluded.lat, lng=excluded.lng, matched=excluded.matched, at=datetime('now')", [address, lat, lng, matched]); }

export interface MlsCompRow { id: number; key: string; mls_number: string | null; address: string; city: string | null; zip: string | null; lat: number | null; lng: number | null; status: MlsComp['status']; list_price: number | null; sold_price: number | null; sold_on: string | null; list_date: string | null; dom: number | null; sqft: number | null; basement_finished_sqft: number | null; beds: number | null; full_baths: number | null; three_quarter_baths: number | null; half_baths: number | null; year_built: number | null; garage: number | null; acres: number | null; style: string | null; style_raw: string | null; source_file: string | null; imported_at: string }
export async function upsertMlsComps(comps: MlsComp[], sourceFile: string): Promise<{ added: number; updated: number }> {
  const d = await db(); let added = 0, updated = 0;
  for (const c of comps) {
    const cur = await d.select<Array<{ id: number }>>('SELECT id FROM mls_comps WHERE key=$1', [c.key]);
    await d.execute(`INSERT INTO mls_comps(key, mls_number, address, city, zip, lat, lng, status, list_price, sold_price, sold_on, list_date, dom, sqft, basement_finished_sqft, beds, full_baths, three_quarter_baths, half_baths, year_built, garage, acres, style, style_raw, source_file)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
      ON CONFLICT(key) DO UPDATE SET mls_number=excluded.mls_number, address=excluded.address, city=excluded.city, zip=excluded.zip, lat=coalesce(excluded.lat, mls_comps.lat), lng=coalesce(excluded.lng, mls_comps.lng), status=excluded.status, list_price=excluded.list_price, sold_price=excluded.sold_price, sold_on=excluded.sold_on, list_date=excluded.list_date, dom=excluded.dom, sqft=excluded.sqft, basement_finished_sqft=excluded.basement_finished_sqft, beds=excluded.beds, full_baths=excluded.full_baths, three_quarter_baths=excluded.three_quarter_baths, half_baths=excluded.half_baths, year_built=excluded.year_built, garage=excluded.garage, acres=excluded.acres, style=excluded.style, style_raw=excluded.style_raw, source_file=excluded.source_file, imported_at=datetime('now')`,
      [c.key, c.mlsNumber, c.address, c.city, c.zip, c.lat, c.lng, c.status, c.listPrice, c.soldPrice, c.soldOn, c.listDate, c.dom, c.sqft, c.basementFinishedSqft, c.beds, c.fullBaths, c.threeQuarterBaths, c.halfBaths, c.yearBuilt, c.garage, c.acres, c.style, c.styleRaw, sourceFile]);
    if (cur.length) updated++; else added++;
  }
  return { added, updated };
}
export async function listMlsComps(): Promise<MlsCompRow[]> { const d = await db(); return d.select<MlsCompRow[]>('SELECT * FROM mls_comps ORDER BY sold_on DESC, id DESC'); }
export async function setMlsCompGeo(id: number, lat: number | null, lng: number | null): Promise<void> { const d = await db(); await d.execute('UPDATE mls_comps SET lat=$1, lng=$2 WHERE id=$3', [lat, lng, id]); }
export async function findMlsCompByAddress(addressKey: string): Promise<MlsCompRow | null> { const d = await db(); const r = await d.select<MlsCompRow[]>('SELECT * FROM mls_comps WHERE key=$1 OR key LIKE $2 ORDER BY imported_at DESC LIMIT 1', [`addr:${addressKey}`, `addr:${addressKey.split('|')[0]}|%`]); return r[0] ?? null; }
export async function compStats(): Promise<{ total: number; sold: number; latest: string | null; located: number }> {
  const d = await db();
  const r = await d.select<Array<{ total: number; sold: number; latest: string | null; located: number }>>("SELECT count(*) AS total, coalesce(sum(status='sold'), 0) AS sold, max(imported_at) AS latest, coalesce(sum(lat IS NOT NULL), 0) AS located FROM mls_comps");
  return r[0] ?? { total: 0, sold: 0, latest: null, located: 0 };
}

export interface CmaRow { id: number; address: string; lat: number | null; lng: number | null; transaction_id: number | null; subject_json: string; selection_json: string; result_json: string; pdf_path: string | null; created_at: string }
export async function saveCmaRow(r: { address: string; lat: number | null; lng: number | null; transactionId: number | null; subject: unknown; selection: unknown; result: unknown; pdfPath: string | null }): Promise<number> {
  const d = await db();
  const res = await d.execute('INSERT INTO cmas(address, lat, lng, transaction_id, subject_json, selection_json, result_json, pdf_path) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [r.address, r.lat, r.lng, r.transactionId, JSON.stringify(r.subject), JSON.stringify(r.selection), JSON.stringify(r.result), r.pdfPath]);
  return res.lastInsertId as number;
}
export async function listCmas(limit = 20): Promise<CmaRow[]> { const d = await db(); return d.select<CmaRow[]>('SELECT * FROM cmas ORDER BY id DESC LIMIT $1', [limit]); }
