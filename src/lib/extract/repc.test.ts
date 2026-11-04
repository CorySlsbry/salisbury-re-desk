import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractRepcFromFields, extractRepcFromTokens, mergeExtractions, tokensFromOcr, tokensFromWords } from './repc';
import { splitNames, toIsoDate, toMoney, toTime } from './normalize';

const fx = (n: string) => JSON.parse(readFileSync(resolve(__dirname, '../../../tests/fixtures', n), 'utf8'));

describe('normalisers', () => {
  it('dates', () => {
    expect(toIsoDate('September 11, 2026')).toBe('2026-09-11');
    expect(toIsoDate('Sept 5 2026')).toBe('2026-09-05');
    expect(toIsoDate('9/4/2026')).toBe('2026-09-04');
    expect(toIsoDate('10-02-26')).toBe('2026-10-02');
    expect(toIsoDate('4th day of September', { defaultYear: 2026 })).toBe('2026-09-04');
    expect(toIsoDate('not a date')).toBeNull();
    expect(toIsoDate('13/45/2026')).toBeNull();
  });
  it('money and time', () => {
    expect(toMoney('$612,000.00')).toBe(612000); expect(toMoney('5,000')).toBe(5000); expect(toMoney('')).toBeNull();
    expect(toTime('5:00', 'PM')).toBe('17:00'); expect(toTime('5:00 PM')).toBe('17:00'); expect(toTime('12:00 AM')).toBe('00:00');
  });
  it('splits couples', () => {
    expect(splitNames('Jordan M. Reyes and Avery L. Reyes')).toEqual([{ first: 'Jordan', last: 'Reyes' }, { first: 'Avery', last: 'Reyes' }]);
  });
});

describe('tier 1: AcroForm fields', () => {
  const r = extractRepcFromFields(fx('repc-filled.fields.json').fields);
  it('reads parties, property, price and the four deadlines exactly', () => {
    expect(r.fields.buyer_names.value).toBe('Jordan M. Reyes and Avery L. Reyes');
    expect(r.fields.seller_names.value).toBe('Sam R. Whitfield and Pat S. Whitfield');
    expect(r.fields.property_street.value).toBe('1842 W Harvest Moon Dr');
    expect(r.fields.property_city.value).toBe('Lehi'); expect(r.fields.property_zip.value).toBe('84043');
    expect(r.fields.purchase_price.value).toBe(612000); expect(r.fields.earnest_money.value).toBe(5000);
    expect(r.fields.seller_disclosure_deadline.value).toBe('2026-09-11');
    expect(r.fields.due_diligence_deadline.value).toBe('2026-09-18');
    expect(r.fields.financing_appraisal_deadline.value).toBe('2026-09-25');
    expect(r.fields.settlement_deadline.value).toBe('2026-10-02');
    expect(r.fields.offer_expires_time.value).toBe('17:00');
    expect(r.fields.is_cash.value).toBe(false);
    expect(r.fields.buyer_agent.value).toBe('Cory Salisbury'); expect(r.fields.buyer_brokerage.value).toBe('Simple Choice Real Estate');
  });
  it('derives acceptance from the ACCEPTANCE box + seller signature and keeps provenance', () => {
    expect(r.fields.acceptance_on.value).toBe('2026-09-05');
    expect(r.fields.settlement_deadline.page).toBe(6);
    expect(r.fields.settlement_deadline.bbox?.[0]).toBeGreaterThan(200);
    expect(r.tier).toBe(1);
  });
  it('flags a blank form', () => {
    const blank = extractRepcFromFields({});
    expect(blank.warnings[0]).toMatch(/flattened or blank/);
    expect(blank.fields.settlement_deadline.value).toBeNull();
  });
});

describe('tier 2: flattened text layer with geometry', () => {
  const r = extractRepcFromTokens(tokensFromWords(fx('repc-flat.text.json').pages), 2);
  it('finds the four deadlines to the right of their labels', () => {
    expect(r.fields.seller_disclosure_deadline.value).toBe('2026-09-11');
    expect(r.fields.due_diligence_deadline.value).toBe('2026-09-18');
    expect(r.fields.financing_appraisal_deadline.value).toBe('2026-09-25');
    expect(r.fields.settlement_deadline.value).toBe('2026-10-02');
  });
  it('finds parties, property and price', () => {
    expect(r.fields.buyer_names.value).toMatch(/Reyes/);
    expect(r.fields.seller_names.value).toMatch(/Whitfield/);
    expect(r.fields.property_city.value).toBe('Lehi');
    expect(r.fields.purchase_price.value).toBe(612000);
    expect(r.fields.buyer_agent.value).toMatch(/Cory Salisbury/);
  });
  it('reads signature dates', () => {
    expect(r.fields.buyer_signed_on.value).toBe('2026-09-04');
    expect(r.fields.seller_signed_on.value).toBe('2026-09-05');
  });
});

describe('tier 3: OCR of a scan', () => {
  const p1 = fx('repc-scan.p1.ocr.json'), p2 = fx('repc-scan.p2.ocr.json'), p6 = fx('repc-scan.p6.ocr.json');
  const toks = [...tokensFromOcr(1, p1.dpi, p1.lines), ...tokensFromOcr(2, p2.dpi, p2.lines), ...tokensFromOcr(6, p6.dpi, p6.lines)];
  const r = extractRepcFromTokens(toks, 3);
  it('recovers the four deadlines and the parties from OCR lines', () => {
    expect(r.fields.seller_disclosure_deadline.value).toBe('2026-09-11');
    expect(r.fields.due_diligence_deadline.value).toBe('2026-09-18');
    expect(r.fields.financing_appraisal_deadline.value).toBe('2026-09-25');
    expect(r.fields.settlement_deadline.value).toBe('2026-10-02');
    expect(r.fields.buyer_names.value).toMatch(/Reyes/);
    expect(r.fields.seller_names.value).toMatch(/Whitfield/);
    expect(r.fields.purchase_price.value).toBe(612000);
    expect(r.fields.seller_agent.value).toMatch(/Nguyen/);
  });
  it('carries lower confidence than tier 1 and merges under it', () => {
    expect(r.fields.settlement_deadline.confidence).toBeLessThan(0.9);
    const t1 = extractRepcFromFields(fx('repc-filled.fields.json').fields);
    const m = mergeExtractions(t1, r);
    expect(m.fields.settlement_deadline.tier).toBe(1);
    expect(m.fields.settlement_deadline.confidence).toBeGreaterThan(0.9);
  });
});
