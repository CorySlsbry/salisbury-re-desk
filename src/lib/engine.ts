/**
 * The Daily Engine: Pat's 11 non-negotiables every day + the weekday block, as pure functions.
 * Everything here is deterministic; the page reads the DB and hands the numbers in.
 */
import engine from '../../templates/engine.json';
import platforms from '../../templates/platforms.json';
import { addDays, dayOfWeek } from './deadlines';

export type Weekday = 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday';
export const WEEKDAYS: Weekday[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export function weekdayOf(date: string): Weekday { return WEEKDAYS[dayOfWeek(date)]; }

export interface EngineSettings { morningStart: string; morningEnd: string; resetDay: Weekday; launchPhase: boolean; openHouseDay: Weekday }
export const ENGINE_DEFAULTS: EngineSettings = { morningStart: '05:00', morningEnd: '06:30', resetDay: 'sunday', launchPhase: false, openHouseDay: 'saturday' };
export function engineSettings(s: Record<string, string>): EngineSettings {
  return {
    morningStart: s.engine_morning_start ?? ENGINE_DEFAULTS.morningStart, morningEnd: s.engine_morning_end ?? ENGINE_DEFAULTS.morningEnd,
    resetDay: (s.engine_reset_day as Weekday) ?? ENGINE_DEFAULTS.resetDay, launchPhase: s.engine_launch_phase === '1',
    openHouseDay: (s.engine_open_house_day as Weekday) ?? ENGINE_DEFAULTS.openHouseDay,
  };
}

export interface EngineItem {
  key: string; block: 'reset' | 'volume' | 'day'; title: string; how?: string; minutes?: number;
  countTarget?: number; gratitudeTarget?: number; timer?: boolean; capture?: string; note?: boolean; platforms?: boolean; data?: string; agent?: string;
}

/** Posts per day: 3 sustaining, 10 in the launch phase, and Friday is always 10 (the one day the standing list is rewritten). */
export function postsTarget(date: string, s: EngineSettings): number { return weekdayOf(date) === 'friday' || s.launchPhase ? 10 : 3; }

export function isResetDay(date: string, s: EngineSettings): boolean { return weekdayOf(date) === s.resetDay; }

/** The full list for a date: reset block + volume block + the weekday block. Empty on the reset day. */
export function itemsFor(date: string, s: EngineSettings): EngineItem[] {
  if (isResetDay(date, s)) return [];
  const wd = weekdayOf(date);
  const posts = postsTarget(date, s);
  const out: EngineItem[] = [];
  for (const it of engine.blocks.reset.items) out.push({ key: it.key, block: 'reset', title: it.title, how: it.how, minutes: it.minutes, countTarget: (it as { count_target?: number }).count_target, timer: (it as { timer?: boolean }).timer, capture: (it as { capture?: string }).capture });
  for (const it of engine.blocks.volume.items) {
    const raw = it as { key: string; title: string; how: string; count_target?: number; count_target_key?: string; gratitude_target?: number; platforms?: boolean; note?: boolean };
    const title = raw.title.replace('{{posts}}', String(posts)).replace('{{marketplace}}', wd === 'friday' ? 'Post the weekend open houses on Facebook Marketplace' : 'One home on Facebook Marketplace');
    out.push({ key: raw.key, block: 'volume', title, how: raw.how, countTarget: raw.count_target_key === 'posts' ? posts : raw.count_target, gratitudeTarget: raw.gratitude_target, platforms: raw.platforms, note: raw.note });
  }
  const day = (engine.days as Record<string, { items: Array<{ key: string; title: string; data?: string; count_target?: number; agent?: string }> }>)[wd];
  for (const it of day?.items ?? []) out.push({ key: it.key, block: 'day', title: it.title, data: it.data, countTarget: it.count_target, agent: it.agent });
  return out;
}
export function dayMeta(date: string, s: EngineSettings): { title: string; note: string; minutes: number } {
  const wd = isResetDay(date, s) ? 'sunday' : weekdayOf(date);
  const d = (engine.days as Record<string, { title: string; note: string; minutes: number }>)[wd];
  return isResetDay(date, s) ? { ...engine.days.sunday, title: 'Reset day' } : d;
}

/** Core = the 11 non-negotiables (reset + volume). Done when every core item is done. */
export function coreDone(items: EngineItem[], log: Record<string, { done: boolean; count: number }>): { done: number; total: number; complete: boolean } {
  const core = items.filter(i => i.block !== 'day');
  const done = core.filter(i => log[i.key]?.done).length;
  return { done, total: core.length, complete: core.length > 0 && done === core.length };
}

/**
 * Streak with holes: consecutive working days (reset day skipped) ending today or yesterday on which the core was
 * complete; a single missed day does NOT reset it (the recovery doctrine), two in a row does. Also reports holes.
 */
export function streak(today: string, completeDates: Set<string>, s: EngineSettings): { days: number; holes: number; broken: boolean } {
  let d = today, days = 0, holes = 0, pending = 0;
  if (!completeDates.has(today)) d = addDays(today, -1); // today may still be in progress
  for (let i = 0; i < 400; i++) {
    if (isResetDay(d, s)) { d = addDays(d, -1); continue; }
    if (completeDates.has(d)) { days++; holes += pending; pending = 0; } // a hole only counts once a completed day sits on both sides of it
    else { pending++; if (pending >= 2) break; }
    d = addDays(d, -1);
  }
  return { days, holes, broken: days === 0 };
}

/** The 3-6-9 prompt for the time of day (America/Denver wall clock, HH:MM). */
export function manifestTarget(time: string): { count: number; label: string } {
  const h = Number(time.slice(0, 2));
  if (h < 11) return { count: 3, label: 'Morning: write it 3 times, say it out loud' };
  if (h < 17) return { count: 6, label: 'Lunch: write it 6 times, say it out loud' };
  return { count: 9, label: 'Night: write it 9 times, say it out loud' };
}

/* ---------- posting cadence ---------- */
export interface Platform { key: string; name: string; posts_per_day_max: number; posts_min_gap_minutes: number; friend_adds_per_day_max: number; dms_per_day_max: number; notes: string }
export const PLATFORMS: Platform[] = platforms.platforms;

/** Distribute N reels across platforms (hourly from 08:00) so no platform exceeds its daily cap. */
export function reelSchedule(n: number, startHour = 8): Array<{ slot: number; time: string; platform: Platform }> {
  const order = n >= 10 ? platforms.reel_distribution.ten : n <= 3 ? platforms.reel_distribution.three : platforms.reel_distribution.ten.slice(0, n);
  const used = new Map<string, number>();
  const out: Array<{ slot: number; time: string; platform: Platform }> = [];
  const keys = [...order];
  while (keys.length < n) keys.push('tiktok');
  for (let i = 0; i < n; i++) {
    let key = keys[i];
    let p = PLATFORMS.find(x => x.key === key)!;
    if ((used.get(key) ?? 0) >= p.posts_per_day_max) { // fall back to the roomiest platform
      p = [...PLATFORMS].filter(x => x.key !== 'marketplace' && x.key !== 'linkedin').sort((a, b) => (b.posts_per_day_max - (used.get(b.key) ?? 0)) - (a.posts_per_day_max - (used.get(a.key) ?? 0)))[0];
      key = p.key;
    }
    used.set(key, (used.get(key) ?? 0) + 1);
    out.push({ slot: i + 1, time: `${String(startHour + i).padStart(2, '0')}:00`, platform: p });
  }
  return out;
}

/** Throttle check: how many more posts / friend adds a platform can take today. */
export function platformRoom(p: Platform, postedToday: number, addsToday: number): { posts: number; adds: number; warn: string | null } {
  const posts = Math.max(0, p.posts_per_day_max - postedToday), adds = Math.max(0, p.friend_adds_per_day_max - addsToday);
  const warn = postedToday > p.posts_per_day_max ? `${p.name}: over the daily posting cap (${p.posts_per_day_max}); expect reach to drop`
    : addsToday > p.friend_adds_per_day_max && p.friend_adds_per_day_max > 0 ? `${p.name}: over the friend-add cap (${p.friend_adds_per_day_max}); risk of an action block` : null;
  return { posts, adds, warn };
}

/** Friend-add split: 10 per platform is the course number, but never above a platform's cap. */
export function friendAddPlan(): Array<{ platform: Platform; target: number }> {
  return PLATFORMS.filter(p => p.friend_adds_per_day_max > 0).map(p => ({ platform: p, target: Math.min(10, p.friend_adds_per_day_max) }));
}

export const RECOVERY = engine.recovery;
export const FAILURE_MODES = engine.failure_modes;
export const BLOCK_NOTES = { reset: engine.blocks.reset, volume: engine.blocks.volume };
