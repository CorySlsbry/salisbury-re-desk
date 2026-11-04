import { describe, it, expect } from 'vitest';
import { extractFacts, groundingCheck, verdictFor, normalizeDate, dropUngroundedSentences } from './monitor';

const SOURCES = [
  JSON.stringify({ client: 'Whitfield, Sam', property: '1842 W Harvest Moon Dr, Lehi', list_price: 450000, showings: 3, due_on: '2026-10-01', due_time: '17:00', phone: '(801) 555-0142', email: 'sam@example.com' }),
  'Listing signed 2026-09-05. Fee 2.5%. Cory Salisbury, Simple Choice Real Estate.',
];

describe('fact extraction', () => {
  it('finds dates in every common spelling and normalises them', () => {
    expect(normalizeDate('September 8, 2026')).toBe('2026-09-08');
    expect(normalizeDate('Sept 8 2026')).toBe('2026-09-08');
    expect(normalizeDate('9/8/2026')).toBe('2026-09-08');
    expect(normalizeDate('2026-9-8')).toBe('2026-09-08');
    expect(normalizeDate('Oct 1')).toBe('--10-01');
    expect(normalizeDate('not a date')).toBeNull();
  });
  it('pulls money, percentages, phones, emails, addresses, times and name pairs', () => {
    const f = extractFacts('Sam Whitfield at 1842 W Harvest Moon Dr listed at $450,000 (2.5%), call (801) 555-0142 or sam@example.com before 5:00 PM on 10/1/2026.');
    const kinds = f.map(x => `${x.kind}:${x.norm}`);
    expect(kinds).toEqual(expect.arrayContaining(['name:sam whitfield', 'address:1842 w harvest moon dr', 'money:450000', 'percent:2.5', 'phone:8015550142', 'email:sam@example.com', 'time:17:00', 'date:2026-10-01']));
  });
  it('does not mistake sentence starts, weekdays or the brokerage for names', () => {
    const names = extractFacts('Thank You for Monday. Simple Choice Real Estate and Equal Housing Opportunity. Market Update for Utah County.').filter(x => x.kind === 'name');
    expect(names).toEqual([]);
  });
});

describe('grounding', () => {
  it('accepts a draft whose every fact is in the sources, in any spelling', () => {
    const g = groundingCheck('Sam Whitfield: 3 showings at 1842 W Harvest Moon Dr. List price $450k. Due Diligence is October 1, 2026 at 5 PM. Fee 2.5%. Call (801) 555-0142.', SOURCES);
    expect(g.ungrounded).toEqual([]); expect(g.score).toBe(1);
  });
  it('flags an invented date, amount and person', () => {
    const g = groundingCheck('Your deadline is October 3, 2026. We can drop to $425,000. Pat Sullivan agreed.', SOURCES);
    expect(g.ungrounded.map(f => f.text)).toEqual(expect.arrayContaining(['October 3, 2026', '$425,000', 'Pat Sullivan']));
    expect(g.score).toBeLessThan(0.95);
  });
  it('gives one verdict: compliance is a hard gate, grounding is the confidence', () => {
    const bad = verdictFor('Sam, KW Westfield is proud to present $450,000.', SOURCES, 'email');
    expect(bad.ok).toBe(false); expect(bad.confidence).toBe(0); expect(bad.problems.some(p => p.startsWith('compliance:'))).toBe(true);
    const good = verdictFor('Sam, 3 showings this week at $450,000. Cory Salisbury, REALTOR | Simple Choice Real Estate | Equal Housing Opportunity', SOURCES, 'email');
    expect(good.ok).toBe(true); expect(good.confidence).toBe(1);
  });
  it('can repair a draft by dropping only the sentences with unverifiable facts', () => {
    const fixed = dropUngroundedSentences('Three showings this week at $450,000. Your neighbour sold for $470,000 on Sept 2, 2026. Next step is the price review.', SOURCES);
    expect(fixed).toBe('Three showings this week at $450,000. Next step is the price review.');
  });
});
