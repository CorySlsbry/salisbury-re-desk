import { describe, it, expect } from 'vitest';
import { testPicks, picksBySimilarity } from './packetAi';
import type { FormRow } from './repo';

const form = (id: number, name: string): FormRow => ({ id, name, source: 'uar', path: `C:\\Forms\\${name}.pdf`, revision: null, sha256: '', pages: null, has_fields: 0, field_map_json: null, indexed_at: '' } as unknown as FormRow);
const candidates = [form(1, 'FHA VA Loan Addendum'), form(2, 'Seller Financing Addendum'), form(3, 'Wire Fraud Alert Disclosure'), form(4, 'Backup Contract Addendum')];

describe('packet pick tests (pure)', () => {
  it('accepts picks whose form name relates to the situation and refuses the rest', () => {
    const t = testPicks([
      { form_number: 1, situation: 'FHA loan', required_when: 'if_applicable', reason: 'FHA/VA addendum for government loans' },
      { form_number: 3, situation: 'new construction', required_when: 'if_applicable', reason: 'builder warranty' },
      { form_number: 9, situation: 'short sale', required_when: 'if_applicable', reason: 'x' },
      { form_number: 1, situation: 'VA loan', required_when: 'if_applicable', reason: 'duplicate' },
    ], candidates);
    expect(t.valid.map(p => p.form_number)).toEqual([1]);
    expect(t.problems).toEqual(expect.arrayContaining(['pick-unrelated:Wire Fraud Alert Disclosure', 'pick-out-of-range:9', 'pick-duplicate:1']));
    expect(t.confidence).toBe(0.25);
  });
  it('the no-model rung picks forms whose names name a situation', () => {
    expect(picksBySimilarity(candidates).map(p => [p.form_number, p.situation])).toEqual([[1, 'fha'], [2, 'seller financing'], [4, 'backup']]);
    expect(testPicks(picksBySimilarity(candidates), candidates).confidence).toBe(1);
  });
});
