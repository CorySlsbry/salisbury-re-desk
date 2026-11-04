import { describe, it, expect } from 'vitest';
import {
  addBusinessDays, computeListingDeadlines, computeRepcDeadlines, isBusinessDay,
  repcDays, retentionEnd, suggestRepcDates, utahHolidays, dayOfWeek,
} from './deadlines';

describe('calendar math', () => {
  it('counts REPC days from the day after the trigger (Mar 10 + 14 = Mar 24)', () => {
    expect(repcDays('2026-03-10', 14)).toBe('2026-03-24');
  });
  it('EMD is 4 calendar days after acceptance even across a weekend', () => {
    const { deadlines } = computeRepcDeadlines({ acceptanceOn: '2026-09-04' }); // Friday
    expect(deadlines.find(d => d.type === 'emd_to_brokerage')?.dueOn).toBe('2026-09-08');
  });
  it('a Sunday contract deadline stays on Sunday and is flagged info', () => {
    const { deadlines, flags } = computeRepcDeadlines({ acceptanceOn: '2026-09-01', dueDiligenceOn: '2026-09-13' });
    expect(deadlines.find(d => d.type === 'due_diligence')?.dueOn).toBe('2026-09-13');
    expect(flags.some(f => f.level === 'info' && /weekend/.test(f.message))).toBe(true);
  });
  it('every contract deadline is 5:00 PM', () => {
    const { deadlines } = computeRepcDeadlines({ acceptanceOn: '2026-09-01', settlementOn: '2026-10-01' });
    for (const d of deadlines.filter(x => x.basis === 'contract')) expect(d.dueTime).toBe('17:00');
  });
});

describe('business days (broker obligations only)', () => {
  it('knows Pioneer Day', () => {
    expect(utahHolidays(2026).has('2026-07-24')).toBe(true);
    expect(isBusinessDay('2026-07-24')).toBe(false);
  });
  it('observes a Saturday July 4 on the Friday', () => {
    expect(utahHolidays(2026).has('2026-07-03')).toBe(true);
  });
  it('listing file due 3 business days after a Thursday signing skips the weekend and Labor Day', () => {
    const d = computeListingDeadlines('2026-09-03').find(x => x.type === 'broker_listing_file')!;
    expect(d.dueOn).toBe('2026-09-09'); // Fri 4, Tue 8 (Labor Day 7 skipped), Wed 9
  });
  it('addBusinessDays walks backwards for reminders', () => {
    expect(addBusinessDays('2026-09-09', -2)).toBe('2026-09-04');
  });
});

describe('flags and waivers', () => {
  it('cash offer marks Financing & Appraisal waived without a warning', () => {
    const { deadlines, flags } = computeRepcDeadlines({ acceptanceOn: '2026-09-01', isCash: true, dueDiligenceOn: '2026-09-10', settlementOn: '2026-09-20' });
    expect(deadlines.find(d => d.type === 'financing_appraisal')?.waived).toBe(true);
    expect(flags.filter(f => f.level === 'warn').length).toBe(1); // only seller disclosure is blank
  });
  it('a blank deadline is emitted as waived and warned, never skipped', () => {
    const { deadlines, flags } = computeRepcDeadlines({ acceptanceOn: '2026-09-01' });
    expect(deadlines.filter(d => d.basis === 'contract').length).toBe(4);
    expect(flags.filter(f => f.level === 'warn').length).toBe(4);
  });
  it('errors when due diligence is after settlement or before acceptance', () => {
    const { flags } = computeRepcDeadlines({ acceptanceOn: '2026-09-10', dueDiligenceOn: '2026-09-05', settlementOn: '2026-09-04' });
    expect(flags.filter(f => f.level === 'error').length).toBeGreaterThanOrEqual(2);
  });
  it('additional EMD lands on the later of DD / F&A', () => {
    const { deadlines } = computeRepcDeadlines({ acceptanceOn: '2026-09-01', dueDiligenceOn: '2026-09-15', financingAppraisalOn: '2026-09-22', additionalEmd: true });
    expect(deadlines.find(d => d.type === 'additional_emd')?.dueOn).toBe('2026-09-22');
  });
  it('walk-through window opens 7 days before settlement; broker status statement at +30; contract file at +2 business days', () => {
    const { deadlines } = computeRepcDeadlines({ acceptanceOn: '2026-09-01', settlementOn: '2026-10-15' });
    expect(deadlines.find(d => d.type === 'walkthrough_window_opens')?.dueOn).toBe('2026-10-08');
    expect(deadlines.find(d => d.type === 'broker_status_statement')?.dueOn).toBe('2026-10-01');
    expect(deadlines.find(d => d.type === 'broker_contract_file')?.dueOn).toBe('2026-09-03');
  });
});

describe('suggestions and retention', () => {
  it('suggests Thursdays about a week apart', () => {
    const s = suggestRepcDates('2026-09-04');
    for (const d of [s.sellerDisclosureOn, s.dueDiligenceOn, s.financingAppraisalOn, s.settlementOn]) expect(dayOfWeek(d as string)).toBe(4);
  });
  it('retention ends 3 years after the year of close', () => {
    expect(retentionEnd('2026-10-20')).toBe('2029-12-31');
  });
});
