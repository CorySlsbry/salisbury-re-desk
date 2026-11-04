import { describe, it, expect } from 'vitest';
import { selectComps, distanceMi, rungs, failReason, LADDER, type Candidate } from './compSelect';
import { parseCsv, importCsv, mapHeaders, normalizeStyle, normalizeStatus } from './compImport';
import type { Attrs } from './cma';

const subject: Attrs = { sqft: 2000, beds: 3, fullBaths: 2, yearBuilt: 1995, garage: 2, acres: 0.2, style: 'two-story' };
const TODAY = '2026-09-08';
let n = 0;
const comp = (o: Partial<Candidate>): Candidate => ({ id: String(++n), label: `Comp ${n}`, salePrice: 540_000, sqft: 2000, beds: 3, fullBaths: 2, yearBuilt: 1996, garage: 2, acres: 0.2, style: 'two-story', status: 'sold', soldOn: '2026-08-01', distanceMi: 0.5, ...o });

describe('comp selection ladder', () => {
  it('measures distance in miles', () => { expect(distanceMi(40.3916, -111.8508, 40.3916, -111.8508)).toBe(0); expect(distanceMi(40.3916, -111.8508, 40.4061, -111.8508)).toBeCloseTo(1.0, 1); });
  it('climbs radius first at 90 days, then the window at 2.0 mi, then the band, then an adjacent style', () => {
    const r = rungs();
    expect(r.slice(0, 3).map(x => [x.radiusMi, x.windowDays])).toEqual([[1, 90], [1.5, 90], [2, 90]]);
    expect(r.slice(3, 6).map(x => [x.radiusMi, x.windowDays])).toEqual([[2, 180], [2, 270], [2, 365]]);
    expect(r[6].band).toEqual([0.7, 1.4]); expect(r[7].adjacentStyle).toBe(true);
  });
  it('takes six same-style comps within a mile and 90 days when they exist, and never crosses styles', () => {
    const pool = [...Array(7)].map((_, i) => comp({ distanceMi: 0.3 + i * 0.1 })).concat([comp({ style: 'rambler', distanceMi: 0.1 })]);
    const s = selectComps(subject, pool, TODAY);
    expect(s.chosen).toHaveLength(6); expect(s.rungsTried).toBe(1); expect(s.rung.radiusMi).toBe(1);
    expect(s.chosen.every(c => c.style === 'two-story')).toBe(true);
    expect(s.considered.find(x => x.comp.style === 'rambler')?.reason).toMatch(/style rambler/);
  });
  it('widens when a mile and 90 days is thin, explains each step, and flags a shortfall below four', () => {
    const pool = [comp({ distanceMi: 0.4 }), comp({ distanceMi: 1.4 }), comp({ distanceMi: 1.9, soldOn: '2026-04-01' }), comp({ distanceMi: 1.2, soldOn: '2026-01-15' }), comp({ distanceMi: 3.5 })];
    const s = selectComps(subject, pool, TODAY);
    expect(s.rung.radiusMi).toBe(2); expect(s.rung.windowDays).toBe(270); expect(s.chosen).toHaveLength(4); expect(s.shortfall).toBe(false);
    expect(s.notes.join(' ')).toMatch(/Radius widened to 2 mi/); expect(s.notes.join(' ')).toMatch(/270 days/);
    expect(s.considered.find(x => x.comp.distanceMi === 3.5)?.reason).toBe('3.5 mi > 2 mi');
    const thin = selectComps(subject, pool.slice(0, 2), TODAY);
    expect(thin.shortfall).toBe(true); expect(thin.notes.join(' ')).toMatch(/below Pat's minimum/);
  });
  it('borrows an adjacent style only on the last rung and says so', () => {
    const pool = [comp({}), comp({}), comp({}), comp({ style: 'multi-level' }), comp({ style: 'rambler' })];
    const s = selectComps(subject, pool, TODAY);
    expect(s.rung.adjacentStyle).toBe(true); expect(s.chosen.map(c => c.style)).toEqual(['two-story', 'two-story', 'two-story', 'multi-level']);
    expect(s.notes.join(' ')).toMatch(/adjacent style/); expect(s.chosen.some(c => c.style === 'rambler')).toBe(false);
  });
  it('keeps actives and under-contract listings as context only', () => {
    const pool = [comp({}), comp({}), comp({}), comp({}), comp({ status: 'active', distanceMi: 0.2 }), comp({ status: 'under_contract', distanceMi: 0.6 })];
    const s = selectComps(subject, pool, TODAY);
    expect(s.chosen.every(c => c.status === 'sold')).toBe(true); expect(s.context.active).toHaveLength(1); expect(s.context.underContract).toHaveLength(1);
    expect(failReason(subject, pool[4], s.rung, TODAY)).toBe('not a closed sale');
  });
  it('a comp without a location or a sold date cannot be used', () => {
    const r = rungs()[0];
    expect(failReason(subject, comp({ distanceMi: undefined }), r, TODAY)).toMatch(/no distance/);
    expect(failReason(subject, comp({ soldOn: undefined }), r, TODAY)).toBe('no sold date');
    expect(LADDER.minimum).toBe(4);
  });
});

describe('MLS export import', () => {
  const csv = 'MLS #,Address,City,Zip,Status,Sold Price,Sold Date,List Price,Total SqFt,Basement Finished SqFt,Beds,Full Baths,3/4 Baths,Half Baths,Year Built,Garage Capacity,Acres,Style,Latitude,Longitude\n' +
    '2034567,"1900 W Harvest Moon Dr",Lehi,84043,Sold,"$545,000",08/01/2026,"$549,900",1900,0,3,2,0,1,2000,2,0.22,2-Story,40.3916,-111.8508\n' +
    '2034568,"123 Ranch Rd",Lehi,84043,Active,,,"$510,000",1800,400,3,2,1,0,1998,2,0.18,Rambler/Ranch,40.40,-111.86\n' +
    ',"77 Pending Ln",Lehi,84043,Under Contract,,,"$530,000",2100,0,4,2,0,0,2005,3,0.25,Two Story,,\n';
  it('parses quoted commas and maps the common headers', () => {
    expect(parseCsv('a,"b,c",d\n1,"2 ""x""",3')).toEqual([['a', 'b,c', 'd'], ['1', '2 "x"', '3']]);
    const m = mapHeaders(['MLS #', 'Address', 'Sold Price', 'Total SqFt', 'Style', 'Weird Column']);
    expect(m.mapped).toMatchObject({ mlsNumber: 0, address: 1, soldPrice: 2, sqft: 3, style: 4 }); expect(m.unmapped).toEqual(['Weird Column']);
  });
  it('turns rows into comps with normalised style, status, money and dates', () => {
    const r = importCsv(csv);
    expect(r.missing).toEqual([]); expect(r.comps).toHaveLength(3); expect(r.skipped).toBe(0);
    expect(r.comps[0]).toMatchObject({ key: 'mls:2034567', status: 'sold', soldPrice: 545000, soldOn: '2026-08-01', sqft: 1900, halfBaths: 1, style: 'two-story', lat: 40.3916, lng: -111.8508 });
    expect(r.comps[1]).toMatchObject({ status: 'active', style: 'rambler', basementFinishedSqft: 400, threeQuarterBaths: 1 });
    expect(r.comps[2]).toMatchObject({ key: 'addr:77pendingln|84043', status: 'under_contract', style: 'two-story', lat: null });
    expect(normalizeStyle('Split-Entry')).toBe('split-entry'); expect(normalizeStyle('Cabin')).toBe('cabin'); expect(normalizeStatus('Active Under Contract')).toBe('under_contract');
  });
  it('reports what it could not map instead of guessing', () => {
    const r = importCsv('Street,Price\n1 Main St,100000');
    expect(r.missing).toEqual(expect.arrayContaining(['status', 'sqft'])); expect(r.comps[0].address).toBe('1 Main St');
  });
});
