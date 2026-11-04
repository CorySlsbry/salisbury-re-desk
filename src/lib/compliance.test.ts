import { describe, it, expect } from 'vitest';
import { checkCompliance, complianceFooter } from './compliance';

const clean = `Weekly update on 123 Main St. Two showings this week. ${complianceFooter()}`;

describe('compliance gate', () => {
  it('passes a clean email with the footer', () => {
    expect(checkCompliance(clean, 'email').ok).toBe(true);
  });
  it('requires the Simple Choice string and EHO on pages and emails', () => {
    const v = checkCompliance('Hello there, here is your update.', 'email');
    expect(v.problems.map(p => p.type)).toEqual(['MISSING', 'MISSING']);
  });
  it('bans the old KW strings', () => {
    const v = checkCompliance(clean + ' Brought to you by KW Westfield.', 'email');
    expect(v.problems.some(p => /KW Westfield/.test(p.what))).toBe(true);
  });
  it('flags Fair Housing framing', () => {
    const v = checkCompliance(clean + ' Perfect for young families near good schools.', 'email');
    expect(v.problems.filter(p => /Fair Housing/.test(p.what)).length).toBe(1);
  });
  it('requires the mortgage disclaimer when money is discussed, and accepts it when present', () => {
    expect(checkCompliance(clean + ' At a 6.5% interest rate the monthly payment is about $2,400.', 'email').ok).toBe(false);
    expect(checkCompliance(clean + ' At a 6.5% interest rate the monthly payment is about $2,400. I am not a mortgage broker; a licensed lender confirms figures.', 'email').ok).toBe(true);
  });
  it('social copy skips the footer requirement but bans "for sale"', () => {
    expect(checkCompliance('Check out this home in Lehi. Listed by Cory Salisbury.', 'social').ok).toBe(true);
    expect(checkCompliance('New home for sale in Lehi!', 'social').ok).toBe(false);
  });
  it('bans wiring instructions in writing and wrong tenure', () => {
    expect(checkCompliance(clean + ' Wire instructions attached.', 'email').ok).toBe(false);
    expect(checkCompliance(clean + ' Helping families since 2012.', 'email').ok).toBe(false);
  });
});
