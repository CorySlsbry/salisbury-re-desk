/**
 * Comp selection the way an appraiser (and Pat) does it, as a pure ladder over the comps on hand.
 * Rules (bearded-realtor listing-system section 6, Cory 2026-09-08): same style is absolute; radius 1.0 -> 1.5 -> 2.0 mi
 * and stop; window starts at 90 days (Cory) and widens 180 -> 270 -> 365 only after the radius is exhausted; sqft band
 * 0.8x-1.3x of the subject; 6 sold comps preferred, 4 minimum; context sets of actives and under-contract are for the
 * story, never the math. Every comp that was considered and not used carries the reason.
 */
import type { Attrs, Comp } from './cma';

export interface Candidate extends Comp { lat?: number | null; lng?: number | null; distanceMi?: number }
export interface Rung { radiusMi: number; windowDays: number; band: [number, number]; adjacentStyle: boolean }
export interface Selection { chosen: Candidate[]; rung: Rung; rungsTried: number; shortfall: boolean; considered: Array<{ comp: Candidate; reason: string }>; context: { active: Candidate[]; underContract: Candidate[] }; notes: string[] }
export const LADDER = { radiusMi: [1.0, 1.5, 2.0], windowDays: [90, 180, 270, 365], band: [0.8, 1.3] as [number, number], wideBand: [0.7, 1.4] as [number, number], preferred: 6, minimum: 4 };
/** Styles a comp may be borrowed from when the same style cannot fill the minimum (tagged, confidence downgraded). */
export const ADJACENT: Record<string, string[]> = { 'two-story': ['multi-level'], 'multi-level': ['two-story', 'split-entry'], 'split-entry': ['multi-level', 'rambler'], rambler: ['split-entry'], townhome: ['condo'], condo: ['townhome'] };

/** Great-circle distance in statute miles. */
export function distanceMi(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 3958.7613, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 100) / 100;
}
/** Calendar days between two ISO dates. UTC-DAY-OK: pure date-string arithmetic. */
export function daysBetween(a: string, b: string): number { const [ay, am, ad] = a.split('-').map(Number), [by, bm, bd] = b.split('-').map(Number); return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000); }

/** The rungs in the order Pat climbs them: radius first at the base window, then the window at 2.0 mi, then the band, then an adjacent style. */
export function rungs(): Rung[] {
  const out: Rung[] = [];
  for (const r of LADDER.radiusMi) out.push({ radiusMi: r, windowDays: LADDER.windowDays[0], band: LADDER.band, adjacentStyle: false });
  for (const w of LADDER.windowDays.slice(1)) out.push({ radiusMi: 2.0, windowDays: w, band: LADDER.band, adjacentStyle: false });
  out.push({ radiusMi: 2.0, windowDays: 365, band: LADDER.wideBand, adjacentStyle: false });
  out.push({ radiusMi: 2.0, windowDays: 365, band: LADDER.wideBand, adjacentStyle: true });
  return out;
}
function styleOk(subject: Attrs, c: Candidate, adjacent: boolean): boolean {
  if (!subject.style || !c.style) return !subject.style;                          // an unknown comp style never passes a known subject style
  if (c.style === subject.style) return true;
  return adjacent && (ADJACENT[subject.style] ?? []).includes(c.style);
}
/** Why a sold comp fails a rung, or null when it passes. */
export function failReason(subject: Attrs, c: Candidate, rung: Rung, today: string): string | null {
  if ((c.status ?? 'sold') !== 'sold') return 'not a closed sale';
  if (!styleOk(subject, c, rung.adjacentStyle)) return `style ${c.style ?? 'unknown'} vs subject ${subject.style ?? 'unknown'}`;
  if (c.distanceMi == null) return 'no distance (address could not be located)';
  if (c.distanceMi > rung.radiusMi) return `${c.distanceMi} mi > ${rung.radiusMi} mi`;
  if (!c.soldOn) return 'no sold date';
  const age = daysBetween(c.soldOn, today);
  if (age < 0 || age > rung.windowDays) return `sold ${age} days ago > ${rung.windowDays}`;
  const lo = subject.sqft * rung.band[0], hi = subject.sqft * rung.band[1];
  if (c.sqft < lo || c.sqft > hi) return `${c.sqft} sqft outside ${Math.round(lo)}-${Math.round(hi)}`;
  return null;
}
/** Closer, newer and more alike ranks higher; a borrowed style always ranks below a same-style comp. */
export function similarity(subject: Attrs, c: Candidate, today: string): number {
  const age = c.soldOn ? daysBetween(c.soldOn, today) : 365;
  const sqftDiff = Math.abs(c.sqft - subject.sqft) / subject.sqft;
  const yearDiff = Math.abs(c.yearBuilt - subject.yearBuilt) / 30;
  const bedDiff = Math.abs(c.beds - subject.beds) / 2;
  const styleMiss = subject.style && c.style && c.style !== subject.style ? 1 : 0;
  return -((c.distanceMi ?? 2) / 2 + age / 365 + sqftDiff * 2 + yearDiff + bedDiff * 0.5 + styleMiss * 3);
}

export function selectComps(subject: Attrs, pool: Candidate[], today: string): Selection {
  const notes: string[] = [];
  let best: { rung: Rung; passing: Candidate[]; tried: number } | null = null;
  const all = rungs();
  for (const [i, rung] of all.entries()) {
    const passing = pool.filter(c => failReason(subject, c, rung, today) === null);
    if (!best || passing.length > best.passing.length) best = { rung, passing, tried: i + 1 };
    if (passing.length >= LADDER.preferred) { best = { rung, passing, tried: i + 1 }; break; }
  }
  const rung = best!.rung;
  const ranked = [...best!.passing].sort((a, b) => similarity(subject, b, today) - similarity(subject, a, today));
  const chosen = ranked.slice(0, LADDER.preferred);
  const shortfall = chosen.length < LADDER.minimum;
  if (rung.radiusMi > 1.0) notes.push(`Radius widened to ${rung.radiusMi} mi.`);
  if (rung.windowDays > LADDER.windowDays[0]) notes.push(`Window widened to ${rung.windowDays} days: note market drift and consider a time adjustment.`);
  if (rung.band[0] < LADDER.band[0]) notes.push('Square-footage band widened to 0.7x-1.4x.');
  if (rung.adjacentStyle && chosen.some(c => c.style !== subject.style)) notes.push('Borrowed an adjacent style to reach the minimum: tagged, confidence downgraded.');
  if (shortfall) notes.push(`Only ${chosen.length} sold comp(s) pass every rung: below Pat's minimum of ${LADDER.minimum}. Say so out loud; do not quote a tight number.`);
  else if (chosen.length < LADDER.preferred) notes.push(`${chosen.length} sold comps (6 preferred, 4 minimum).`);
  const considered = pool.filter(c => (c.status ?? 'sold') === 'sold' && !chosen.includes(c)).map(c => ({ comp: c, reason: failReason(subject, c, rung, today) ?? 'passed the rung but ranked below the six chosen' }));
  const inRadius = (c: Candidate) => c.distanceMi != null && c.distanceMi <= rung.radiusMi && styleOk(subject, c, true);
  const context = {
    active: pool.filter(c => c.status === 'active' && inRadius(c)).sort((a, b) => (a.distanceMi ?? 9) - (b.distanceMi ?? 9)).slice(0, 6),
    underContract: pool.filter(c => c.status === 'under_contract' && inRadius(c)).sort((a, b) => (a.distanceMi ?? 9) - (b.distanceMi ?? 9)).slice(0, 6),
  };
  return { chosen, rung, rungsTried: best!.tried, shortfall, considered, context, notes };
}
