import { describe, it, expect } from 'vitest';
import { ENGINE_DEFAULTS, coreDone, friendAddPlan, itemsFor, manifestTarget, platformRoom, postsTarget, reelSchedule, streak, PLATFORMS } from './engine';

const S = ENGINE_DEFAULTS; // 05:00, reset Sunday

describe('daily engine schedule', () => {
  it('every working day carries the same 11 non-negotiables, then the weekday block', () => {
    for (const d of ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12']) {
      const core = itemsFor(d, S).filter(i => i.block !== 'day');
      expect(core.length).toBe(11);
    }
    expect(itemsFor('2026-09-07', S).filter(i => i.block === 'day').map(i => i.key)).toEqual(['mon_deadlines', 'mon_listings', 'mon_buyers', 'mon_cleanup', 'mon_seller_updates']);
    expect(itemsFor('2026-09-10', S).find(i => i.key === 'thu_reels')?.countTarget).toBe(10);
  });
  it('Sunday is the reset day: nothing scheduled', () => { expect(itemsFor('2026-09-06', S)).toEqual([]); });
  it('posts: 3 sustaining, 10 on Friday, 10 in the launch phase', () => {
    expect(postsTarget('2026-09-08', S)).toBe(3);
    expect(postsTarget('2026-09-11', S)).toBe(10);
    expect(postsTarget('2026-09-08', { ...S, launchPhase: true })).toBe(10);
    expect(itemsFor('2026-09-11', S).find(i => i.key === 'posts')?.title).toBe('Post 10 pieces of content');
    expect(itemsFor('2026-09-11', S).find(i => i.key === 'marketplace')?.title).toMatch(/open houses/);
  });
  it('outreach carries the 3-gratitude rule', () => {
    const o = itemsFor('2026-09-08', S).find(i => i.key === 'outreach')!;
    expect(o.countTarget).toBe(10); expect(o.gratitudeTarget).toBe(3);
  });
  it('core completion counts only the 11', () => {
    const items = itemsFor('2026-09-08', S);
    const log: Record<string, { done: boolean; count: number }> = {};
    for (const i of items) log[i.key] = { done: true, count: 0 };
    expect(coreDone(items, log)).toEqual({ done: 11, total: 11, complete: true });
    log['walk'] = { done: false, count: 0 };
    expect(coreDone(items, log).complete).toBe(false);
  });
});

describe('streak with holes (recovery doctrine)', () => {
  it('one missed day is a hole, not a reset; two in a row breaks it; Sunday never counts', () => {
    const done = new Set(['2026-09-01', '2026-09-02', '2026-09-03', /* 04 missed */ '2026-09-05', /* 06 Sunday */ '2026-09-07', '2026-09-08']);
    expect(streak('2026-09-08', done, S)).toEqual({ days: 6, holes: 1, broken: false });
    const gap = new Set(['2026-09-01', '2026-09-02', /* 03, 04 missed */ '2026-09-05', '2026-09-07', '2026-09-08']);
    expect(streak('2026-09-08', gap, S)).toEqual({ days: 3, holes: 0, broken: false });
  });
  it('today in progress does not count against you', () => {
    expect(streak('2026-09-08', new Set(['2026-09-07']), S).days).toBe(1);
  });
});

describe('369 and posting cadence', () => {
  it('3-6-9 follows the clock', () => {
    expect(manifestTarget('05:30').count).toBe(3); expect(manifestTarget('12:10').count).toBe(6); expect(manifestTarget('21:00').count).toBe(9);
  });
  it('ten reels never exceed a platform cap (YouTube max 2, Instagram max 3)', () => {
    const sched = reelSchedule(10);
    expect(sched.length).toBe(10);
    expect(sched[0].time).toBe('08:00'); expect(sched[9].time).toBe('17:00');
    const count = (k: string) => sched.filter(s => s.platform.key === k).length;
    for (const p of PLATFORMS) expect(count(p.key)).toBeLessThanOrEqual(p.posts_per_day_max);
    expect(count('youtube')).toBeLessThanOrEqual(2);
  });
  it('three reels hit TikTok, Instagram and YouTube once each', () => {
    expect(reelSchedule(3).map(s => s.platform.key)).toEqual(['tiktok', 'instagram', 'youtube']);
  });
  it('warns when over a cap and caps friend adds per platform', () => {
    const yt = PLATFORMS.find(p => p.key === 'youtube')!, fb = PLATFORMS.find(p => p.key === 'facebook')!;
    expect(platformRoom(yt, 3, 0).warn).toMatch(/posting cap/);
    expect(platformRoom(fb, 1, 20).warn).toMatch(/friend-add cap/);
    expect(platformRoom(fb, 1, 5)).toMatchObject({ posts: 2, adds: 10, warn: null });
    const plan = friendAddPlan();
    expect(plan.find(p => p.platform.key === 'facebook')?.target).toBe(10);
    expect(plan.some(p => p.platform.key === 'youtube')).toBe(false);
  });
});
