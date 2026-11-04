import { describe, it, expect } from 'vitest';
import { render, weeklySellerUpdate, priceDropThreeOptions, deadlineReminder, atRiskText, touchesText, MEANING } from './drafts';
import type { SellerUpdateFacts } from './reports';

const facts: SellerUpdateFacts = { txId: 1, first: 'Sam', client: 'Whitfield, Sam', property: '1842 W Harvest Moon Dr, Lehi', listPrice: 452_000, daysOnMarket: 24, signedOn: '2026-08-15', weekStart: '2026-09-07', showingsWeek: 1, showingsTotal: 5, benchmark: '1-2 per week', verdict: 'under', priceReviewDue: true };

describe('programmed drafts', () => {
  it('fills placeholders and refuses a missing value', () => {
    expect(render('Hi {first}, {n} showings', { first: 'Sam', n: 3 })).toBe('Hi Sam, 3 showings');
    expect(() => render('Hi {first}', {})).toThrow(/first/);
  });
  it('writes the weekly seller update from the facts, compliant and fully grounded', () => {
    const d = weeklySellerUpdate(facts, { feedback: 'kitchen feels dated', marketNote: '3 competing homes under $450k', nextStep: '' }, '2026-09-08');
    expect(d.subject).toBe('Market Update 2026-09-08 1842 W Harvest Moon Dr, Lehi');
    expect(d.text).toContain('24 days'); expect(d.text).toContain('kitchen feels dated'); expect(d.text).toContain('1 this week, 5 in total'); expect(d.text).toContain('three price options');
    expect(d.verdict.ok).toBe(true); expect(d.monitor.ok).toBe(true); expect(d.text).toContain('Simple Choice Real Estate');
  });
  it('prices the three options from the list price and recommends by traffic', () => {
    const d = priceDropThreeOptions(facts);
    expect(d.text).toContain('$449,900'); expect(d.text).toContain('$438,400'); expect(d.text).toContain('option 2');
    expect(d.monitor.ok).toBe(true);
    expect(() => priceDropThreeOptions({ ...facts, listPrice: null })).toThrow(/list price/);
  });
  it('writes a deadline reminder text with the meaning and the 5 PM rule', () => {
    const d = deadlineReminder({ type: 'due_diligence', label: 'Due Diligence Deadline', due_on: '2026-10-01', due_time: '17:00' }, { first_name: 'Sam', street: '1842 W Harvest Moon Dr', side: 'buyer' });
    expect(d.kind).toBe('text'); expect(d.text).toContain('2026-10-01 at 17:00 Mountain Time'); expect(d.text).toContain(MEANING.due_diligence); expect(d.monitor.ok).toBe(true);
  });
  it('renders the at-risk and touches reports without inventing anything', () => {
    const r = atRiskText({ today: '2026-09-08', days: 7, overdue: [], next: [{ kind: 'deadline', refId: 1, txId: 1, client: 'Whitfield, Sam', property: '1842 W Harvest Moon Dr', title: 'Seller Disclosure Deadline', dueOn: '2026-09-10', dueTime: '17:00', daysLeft: 2, detail: 'contract' }], later: 3, clocks: [], gaps: [] });
    expect(r.text).toContain('in 2 days'); expect(r.text).toContain('nothing overdue'); expect(r.monitor.ok).toBe(true);
    const t = touchesText({ date: '2026-09-08', done: 2, target: 10, picks: [{ clientId: 1, name: 'Ann Lee', first: 'Ann', channel: 'text', kind: 'gratitude', reason: 'It is their birthday today.', phone: null, email: null }] });
    expect(t.text).toContain('1. Ann Lee (text, gratitude)'); expect(t.monitor.ok).toBe(true);
  });
});
