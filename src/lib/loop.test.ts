import { describe, it, expect } from 'vitest';
import { runWithConfidence, memoryLessons, signatureOf, hintFrom, type Job } from './loop';

interface Ctx { calls: string[]; passAt: number | null; researched: number }
/** A job whose task "passes" on a chosen pass number, so the loop's routing can be observed. */
function job(passAt: number | null, timeCapMs = 60_000): Job<Ctx, string> {
  return {
    name: 'demo', strategies: ['whole', 'narrow', 'ocr', 'rules'], timeCapMs,
    async read() { /* nothing to gather */ },
    async research(ctx) { ctx.researched++; },
    async task(ctx, strategy) { ctx.calls.push(strategy); return `${strategy}#${ctx.calls.length}`; },
    async test(out, ctx) { return ctx.passAt !== null && ctx.calls.length >= ctx.passAt ? { confidence: 0.99, problems: [] } : { confidence: 0.4, problems: ['ungrounded:date:x', 'schema:truncated'] }; },
  };
}
const ctx = (passAt: number | null): Ctx => ({ calls: [], passAt, researched: 0 });

describe('confidence loop', () => {
  it('completes on the first pass above the bar without switching approach', async () => {
    const c = ctx(1); const r = await runWithConfidence(job(1), c, { bar: 0.95 });
    expect(r.ok).toBe(true); expect(r.passes).toBe(1); expect(r.switched).toBe(false); expect(c.calls).toEqual(['whole']);
  });
  it('keeps the approach for two passes, then switches one rung per pass', async () => {
    const c = ctx(4); const r = await runWithConfidence(job(4), c);
    expect(r.ok).toBe(true); expect(r.passes).toBe(4); expect(r.switched).toBe(true);
    expect(c.calls).toEqual(['whole', 'whole', 'narrow', 'ocr']); expect(c.researched).toBe(4);
  });
  it('fails loudly after five passes with every failure kept', async () => {
    const c = ctx(null); const r = await runWithConfidence(job(null), c);
    expect(r.ok).toBe(false); expect(r.passes).toBe(5); expect(r.failures).toHaveLength(5);
    expect(c.calls).toEqual(['whole', 'whole', 'narrow', 'ocr', 'rules']);
    expect(r.failures[4].problems).toContain('schema:truncated');
  });
  it('remembers the strategy that worked and starts there next time', async () => {
    const lessons = memoryLessons();
    await runWithConfidence(job(4), ctx(4), { lessons });
    expect(lessons.rows[0]).toMatchObject({ job: 'demo', failure_signature: 'schema:truncated|ungrounded:date', strategy_worked: 'ocr' });
    const c2 = ctx(2); const r2 = await runWithConfidence(job(2), c2, { lessons });
    expect(r2.ok).toBe(true); expect(c2.calls).toEqual(['whole', 'ocr']); expect(r2.lessonsUsed).toEqual(['schema:truncated|ungrounded:date']);
  });
  it('treats the time cap as a failure, never a silent partial', async () => {
    let t = 0; const c = ctx(null);
    const r = await runWithConfidence(job(null, 100), c, { now: () => (t += 60) });
    expect(r.ok).toBe(false); expect(r.timedOut).toBe(true); expect(r.passes).toBeLessThan(5);
  });
  it('signatures and hints are built from problem kinds only', () => {
    expect(signatureOf(['ungrounded:date:Oct 3', 'ungrounded:date:Oct 4', 'compliance:BANNED:KW'])).toBe('compliance:BANNED|ungrounded:date');
    expect(hintFrom(['quote-mismatch:list_price'])).toMatch(/word for word/);
    expect(hintFrom(['ungrounded:money:$1'])).not.toMatch(/\$1/);
  });
});
