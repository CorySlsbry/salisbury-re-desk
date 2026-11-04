import { describe, it, expect } from 'vitest';
import { adjustComp, runCma, netSheet, underThreshold, median, type Attrs, type Comp } from './cma';

const subject: Attrs = { sqft: 2000, beds: 3, fullBaths: 2, yearBuilt: 1995, garage: 2, acres: 0.20, updatingUnits: 0, style: 'two-story' };
const compA: Comp = { id: 'A', label: 'Comp A', salePrice: 545000, sqft: 1900, beds: 3, fullBaths: 2, yearBuilt: 2000, garage: 2, acres: 0.22, updatingUnits: 2, style: 'two-story', distanceMi: 0.8 };

describe('CMA math (the course worked example)', () => {
  it('adjusts the comp toward the subject: net -25,000, gross 35,000, adjusted 520,000, both guardrails pass', () => {
    const a = adjustComp(subject, compA);
    expect(a.net).toBe(-25000); expect(a.gross).toBe(35000); expect(a.adjusted).toBe(520000);
    expect(a.netPct).toBeCloseTo(0.046, 2); expect(a.grossPct).toBeCloseTo(0.064, 2); expect(a.reliable).toBe(true);
    expect(a.lines.find(l => l.item === 'Year built')?.adjustment).toBe(-7500);
    expect(a.lines.find(l => l.item === 'Updating units')?.adjustment).toBe(-20000);
  });
  it('drops a cross-style comp and a comp needing enormous adjustment', () => {
    expect(adjustComp(subject, { ...compA, id: 'B', style: 'rambler' }).reasons[0]).toMatch(/style/);
    expect(adjustComp(subject, { ...compA, id: 'C', salePrice: 300000, sqft: 1000 }).reliable).toBe(false);
  });
  it('removes outliers more than 15% from the median (his 454 / 385 demo) and weights by reliability', () => {
    const mk = (id: string, price: number, sqft = 2000): Comp => ({ id, label: id, salePrice: price, sqft, beds: 3, fullBaths: 2, yearBuilt: 1995, garage: 2, acres: 0.2, updatingUnits: 0, style: 'two-story' });
    const r = runCma(subject, [mk('1', 536000), mk('2', 553000), mk('3', 554000), mk('4', 556000), mk('5', 559000), mk('6', 454000), mk('7', 385000)]);
    expect(r.dropped.map(d => d.comp.comp.id).sort()).toEqual(['6', '7']);
    expect(r.survivors.length).toBe(5);
    expect(r.medianAdjusted).toBe(554000);
    expect(r.indicated).toBeGreaterThan(550000); expect(r.indicated).toBeLessThan(556000);
    expect(r.confidence).toBe('high');
    expect(r.realistic).toBe(r.indicated); expect(r.floor).toBe(Math.round(r.indicated * 0.97));
    expect(r.listTop).toBeLessThan(r.indicated * 1.025 + 1);
  });
  it('flags too few solds', () => { expect(runCma(subject, [compA]).warnings[0]).toMatch(/minimum is 4/); });
  it('rounds list price to just under the threshold', () => {
    expect(underThreshold(400000)).toBe(399900); expect(underThreshold(398000)).toBe(399900); expect(underThreshold(712000)).toBe(711900);
    expect(median([1, 5, 3])).toBe(3); expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe('seller net sheet at 1.99%', () => {
  it('computes the seller net and the agent side', () => {
    const n = netSheet({ salePrice: 600000, listingFeePct: 1.99, buyerBrokeragePct: 2.5, mortgagePayoff: 310000, annualTaxes: 3650, closingOn: '2026-10-15', hoaTransfer: 250 });
    expect(n.lines[0].amount).toBe(11940);
    expect(n.lines[1].amount).toBe(15000);
    expect(n.lines.find(l => /Property tax/.test(l.label))?.amount).toBe(2880); // Oct 15 = day 288
    expect(n.agentGross).toBe(11940); expect(n.agentAfterFee).toBe(11445);
    expect(n.net).toBe(600000 - n.totalCosts);
    expect(n.totalCosts).toBeGreaterThan(340000);
  });
});
