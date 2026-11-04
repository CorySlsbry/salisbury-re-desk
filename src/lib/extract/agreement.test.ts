import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractAgreement, lastDate } from './agreement';
import { tokensFromOcr, tokensFromWords } from './repc';

const fx = (n: string) => JSON.parse(readFileSync(resolve(__dirname, '../../../tests/fixtures', n), 'utf8'));

describe('lastDate', () => {
  it('takes the last valid m/d/yyyy even when OCR glues it to a phone number', () => {
    expect(lastDate('1842WHarvestMo0nDr,LehiUT(801)555-01429/5/2026')).toBe('2026-09-05');
    expect(lastDate('same (801) 555-0143 9/5/2026')).toBe('2026-09-05');
    expect(lastDate('March 5, 2027')).toBe('2027-03-05');
    expect(lastDate('nothing here')).toBeNull();
  });
});

describe('listing agreement, tier 2 (text layer)', () => {
  const r = extractAgreement(tokensFromWords(fx('listing-filled.text.json').pages), 'listing_agreement', 2);
  it('reads company, agent, sellers, property, end date and fees', () => {
    expect(r.fields.company.value).toBe('Simple Choice Real Estate');
    expect(r.fields.agent.value).toBe('Cory Salisbury');
    expect(r.fields.client_names.value).toBe('Sam R. Whitfield and Pat S. Whitfield');
    expect(r.fields.property_street.value).toBe('1842 W Harvest Moon Dr');
    expect(r.fields.property_city.value).toBe('Lehi');
    expect(r.fields.property_zip.value).toBe('84043');
    expect(r.fields.property_county.value).toBe('Utah');
    expect(r.fields.end_date.value).toBe('2027-03-05');
    expect(r.fields.fee_pct.value).toBe(2.5);
    expect(r.fields.coop_offer_pct.value).toBe(2.5);
  });
  it('reads the signature block: phone, address and signed dates', () => {
    expect(r.fields.client_phone.value).toBe('(801) 555-0142');
    expect(r.fields.client_signed_on.value).toBe('2026-09-05');
    expect(r.fields.agent_signed_on.value).toBe('2026-09-05');
    expect(r.fields.form_revision.value).toBe('11.5.2024');
    expect(r.warnings).toEqual([]);
  });
  it('carries provenance for the review crop', () => {
    expect(r.fields.client_names.page).toBe(1);
    expect(r.fields.client_names.bbox?.[1]).toBeGreaterThan(140);
    expect(r.fields.client_signed_on.page).toBe(4);
  });
});

describe('listing agreement, tier 3 (OCR of a scan)', () => {
  const p1 = fx('listing-scan.p1.ocr.json'), p4 = fx('listing-scan.p4.ocr.json');
  const r = extractAgreement([...tokensFromOcr(1, p1.dpi, p1.lines), ...tokensFromOcr(4, p4.dpi, p4.lines)], 'listing_agreement', 3);
  it('still gets the parties, property, end date and signed date', () => {
    expect(r.fields.company.value).toBe('Simple Choice Real Estate');
    expect(r.fields.agent.value).toBe('Cory Salisbury');
    expect(r.fields.client_names.value).toBe('Sam R. Whitfield and Pat S. Whitfield');
    expect(r.fields.property_street.value).toBe('1842 W Harvest Moon Dr');
    expect(r.fields.end_date.value).toBe('2027-03-05');
    expect(r.fields.fee_pct.value).toBe(2.5);
    expect(r.fields.client_signed_on.value).toBe('2026-09-05');
    expect(r.fields.agent_signed_on.value).toBe('2026-09-05');
    expect(r.tier).toBe(3);
  });
});

describe('buyer-broker agreement', () => {
  const t2 = extractAgreement(tokensFromWords(fx('bba-filled.text.json').pages), 'bba', 2);
  it('tier 2 reads buyers, end date, search area, fee and signatures', () => {
    expect(t2.fields.client_names.value).toBe('Jordan M. Reyes and Avery L. Reyes');
    expect(t2.fields.end_date.value).toBe('2027-03-05');
    expect(t2.fields.search_area.value).toBe('Utah and Salt Lake');
    expect(t2.fields.fee_pct.value).toBe(2.5);
    expect(t2.fields.property_street.value).toBeNull();
    expect(t2.fields.client_phone.value).toBe('(385) 555-0199');
    expect(t2.fields.client_signed_on.value).toBe('2026-09-05');
    expect(t2.fields.agent_signed_on.value).toBe('2026-09-05');
    expect(t2.fields.form_revision.value).toBe('6.20.2024');
    expect(t2.warnings).toEqual([]);
  });
  const p1 = fx('bba-scan.p1.ocr.json'), p3 = fx('bba-scan.p3.ocr.json');
  const t3 = extractAgreement([...tokensFromOcr(1, p1.dpi, p1.lines), ...tokensFromOcr(3, p3.dpi, p3.lines)], 'bba', 3);
  it('tier 3 reads buyers, end date, search area and signed date', () => {
    expect(t3.fields.client_names.value).toBe('Jordan M. Reyes and Avery L. Reyes');
    expect(t3.fields.end_date.value).toBe('2027-03-05');
    expect(t3.fields.search_area.value).toBe('Utah and Salt Lake');
    expect(t3.fields.client_signed_on.value).toBe('2026-09-05');
  });
});
