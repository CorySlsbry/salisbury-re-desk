import { describe, it, expect } from 'vitest';
import { brokerClocks, priceOptions, pickTouches, dayDiff, mondayOf } from './reports';

describe('report helpers (pure)', () => {
  it('counts calendar days and finds the Monday of a week', () => {
    expect(dayDiff('2026-09-08', '2026-09-15')).toBe(7); expect(dayDiff('2026-09-15', '2026-09-08')).toBe(-7);
    expect(mondayOf('2026-09-08')).toBe('2026-09-07'); expect(mondayOf('2026-09-13')).toBe('2026-09-07'); expect(mondayOf('2026-09-07')).toBe('2026-09-07');
  });
  it('runs the ICA clocks: listing file 3 business days after signing, contract file 2 after binding, nothing once submitted', () => {
    // 2026-09-07 is Labor Day: a Friday signing skips it, so 3 business days from Fri 09-04 land on Thu 09-10.
    const base = { id: 1, side: 'seller', last_name: 'Whitfield', first_name: 'Sam', street: '1842 W Harvest Moon Dr', agreement_signed_on: '2026-09-04', acceptance_on: null as string | null, broker_submitted_on: null as string | null };
    const listing = brokerClocks(base, '2026-09-08');
    expect(listing).toHaveLength(1); expect(listing[0].clock).toBe('listing file'); expect(listing[0].owedBy).toBe('2026-09-10'); expect(listing[0].late).toBe(false);
    expect(brokerClocks({ ...base, agreement_signed_on: '2026-09-08' }, '2026-09-08')[0].owedBy).toBe('2026-09-11');
    const contract = brokerClocks({ ...base, acceptance_on: '2026-09-01' }, '2026-09-08');
    expect(contract[0].clock).toBe('contract file'); expect(contract[0].late).toBe(true);
    expect(brokerClocks({ ...base, broker_submitted_on: '2026-09-05' }, '2026-09-08')).toEqual([]);
  });
  it("prices Pat's three options: just under the next threshold, and a 3% decisive move", () => {
    expect(priceOptions(452_000)).toEqual({ threshold: 449_900, decisive: 438_400, decisivePct: 3 });
    expect(priceOptions(450_000).threshold).toBe(424_900);
    expect(priceOptions(478_900).threshold).toBe(474_900);
  });
  it('picks the ten touches: birthdays first as gratitude, cadence tasks, then the longest untouched, never twice a day', () => {
    const people = [
      { id: 1, first_name: 'Ann', last_name: 'Lee', stage: 'lead', preferred_channel: 'text', phone: '1', email: null, last_touch_on: '2026-08-01', do_not_contact: 0 },
      { id: 2, first_name: 'Bo', last_name: 'Kim', stage: 'past', preferred_channel: null, phone: null, email: 'person1@example.com', last_touch_on: '2026-07-01', do_not_contact: 0 },
      { id: 3, first_name: 'Cy', last_name: 'Doe', stage: 'nurture', preferred_channel: 'call', phone: '3', email: null, last_touch_on: null, do_not_contact: 1 },
      { id: 4, first_name: 'Di', last_name: 'Fox', stage: 'client', preferred_channel: 'email', phone: null, email: 'person2@example.com', last_touch_on: '2026-09-01', do_not_contact: 0 },
    ];
    const picks = pickTouches({ today: '2026-09-08', birthdays: [{ id: 4, name: 'Di Fox', on: '2026-09-08', preferred_channel: 'email', phone: null, email: 'person2@example.com' }], dueTasks: [{ client_id: 1, title: 'Day 3 call: any questions on the market report?', first_name: 'Ann', last_name: 'Lee' }], people, touchedToday: new Set([2]) });
    expect(picks.map(p => p.name)).toEqual(['Di Fox', 'Ann Lee']);
    expect(picks[0]).toMatchObject({ kind: 'gratitude', channel: 'email', reason: 'It is their birthday today.' });
    expect(picks[1]).toMatchObject({ kind: 'business', channel: 'text' });
    expect(picks.some(p => p.name === 'Cy Doe')).toBe(false);
  });
});
