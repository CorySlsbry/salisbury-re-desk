/** Value normalisers shared by every tier. All return null rather than guessing. */
const MONTHS: Record<string, number> = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function pad(n: number): string { return String(n).padStart(2, '0'); }
function valid(y: number, m: number, d: number): boolean { return m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100; }

/** "September 11, 2026" | "Sept 11 2026" | "9/11/2026" | "09-11-26" | "2026-09-11" -> "2026-09-11" */
export function toIsoDate(s: string | null | undefined, opts: { defaultYear?: number } = {}): string | null {
  if (!s) return null;
  const t = s.replace(/[_‘’“”]/g, ' ').replace(/\s+/g, ' ').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) { const y = +m[1], mo = +m[2], d = +m[3]; return valid(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null; }
  m = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/.exec(t);
  if (m) { const mo = +m[1], d = +m[2]; let y = +m[3]; if (y < 100) y += 2000; return valid(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null; }
  m = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?/.exec(t);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()]; const d = +m[2]; const y = m[3] ? +m[3] : opts.defaultYear;
    if (mo && y && valid(y, mo, d)) return `${y}-${pad(mo)}-${pad(d)}`;
  }
  m = /(\d{1,2})(?:st|nd|rd|th)?\s+(?:day\s+of\s+)?([A-Za-z]{3,9}),?\s*(\d{4})?/.exec(t);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()]; const d = +m[1]; const y = m[3] ? +m[3] : opts.defaultYear;
    if (mo && y && valid(y, mo, d)) return `${y}-${pad(mo)}-${pad(d)}`;
  }
  return null;
}

/** "$612,000.00" | "612000" -> 612000 */
export function toMoney(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /-?\$?\s*([\d,]+(?:\.\d{1,2})?)/.exec(s.replace(/\s/g, ''));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** "5:00 PM" | "5:00" + ampm -> "17:00" */
export function toTime(s: string | null | undefined, ampm?: 'AM' | 'PM' | null): string | null {
  if (!s) return null;
  const m = /(\d{1,2})(?::(\d{2}))?\s*([AaPp][Mm])?/.exec(s);
  if (!m) return null;
  let h = +m[1]; const mi = m[2] ? +m[2] : 0; const ap = (m[3] ?? ampm ?? '').toUpperCase();
  if (ap === 'PM' && h < 12) h += 12; if (ap === 'AM' && h === 12) h = 0;
  if (h > 23 || mi > 59) return null;
  return `${pad(h)}:${pad(mi)}`;
}

export function cleanName(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.replace(/[_"“”]/g, ' ').replace(/\s+/g, ' ').replace(/\(?\s*(Buyer|Seller)\s*\)?/gi, '')
    .replace(/\s+[a-z]$/, '')  // OCR artefact: a stray lowercase letter after the last name (rendered underline)
    .trim();
  return t.length >= 2 ? t : null;
}

/** "Jordan M. Reyes and Avery L. Reyes" -> [{first:'Jordan', last:'Reyes'}, {first:'Avery', last:'Reyes'}] */
export function splitNames(s: string | null): Array<{ first: string; last: string }> {
  if (!s) return [];
  return s.split(/\s+(?:and|&)\s+|,\s*/i).map(p => p.trim()).filter(Boolean).map(p => {
    const parts = p.split(/\s+/); const last = parts.length > 1 ? parts[parts.length - 1] : '';
    return { first: parts[0].replace(/\.$/, ''), last };
  }).map((n, _i, all) => (n.last ? n : { first: n.first, last: all.find(x => x.last)?.last ?? '' }));
}
