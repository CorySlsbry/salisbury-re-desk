/**
 * Live check of the Extraction Agent's confidence loop against the local llama-server (the app's own model), using the
 * canary golden set. Skipped unless REDESK_LIVE=1 so the normal suite stays fast and offline.
 */
import { describe, it, expect, vi } from 'vitest';
import { memoryLessons } from '../loop';
import canary from '../../../templates/canary.json';

const LIVE = process.env.REDESK_LIVE === '1';
(globalThis as unknown as { window: unknown }).window = globalThis;
const lessons = memoryLessons();
vi.mock('../repo', () => ({ logModelRun: async () => {}, getSettings: async () => ({ agent_confidence_min: '0.95' }), today: () => '2026-09-08' }));
vi.mock('../lessonStore', () => ({ dbLessons: () => lessons, confidenceBar: async () => 0.95 }));
vi.mock('../native', async (orig) => ({ ...(await orig<typeof import('../native')>()), llamaHealthy: async () => true }));

describe.skipIf(!LIVE)('extraction loop against the live local model', () => {
  it('works the canary golden set through the ladder, or fails loudly after five passes', async () => {
    const { askModelForFields } = await import('./aiFallback');
    const set = canary.listing;
    const steps: string[] = [];
    const r = await askModelForFields(set.pages, set.asks.map(a => ({ key: a.key, question: a.question, kind: a.kind as 'date' | 'money' | 'text', pattern: (a as { pattern?: string }).pattern })), s => steps.push(s), { known: Object.fromEntries(set.asks.map(a => [a.key, a.expect])) });
    const squash = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^0-9a-z]/g, '');
    const results = set.asks.map(a => ({ key: a.key, expect: a.expect, got: r.fields[a.key]?.value ?? null, pass: squash(r.fields[a.key]?.value) === squash(a.expect) }));
    console.log(JSON.stringify({ ok: r.ok, passes: r.passes, strategy: r.strategy, confidence: r.confidence, problems: r.problems, results, passDetail: r.passDetail, lessons: lessons.rows, steps }, null, 1));
    expect(r.passes).toBeGreaterThanOrEqual(1);
    if (r.ok) expect(results.every(x => x.pass)).toBe(true);
    else expect(r.passes).toBe(5);
  }, 7 * 60_000);
});
