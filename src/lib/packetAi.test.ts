import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyForm, proposeByRules } from './packetAi';
import { parseFormFile, formCode } from './forms';
import type { FormRow } from './forms';

/** The real forms folder, as indexed by the app (names + revisions from the UAR manifest plus the 11 state forms). */
function library(): FormRow[] {
  const manifest = JSON.parse(readFileSync(resolve(__dirname, '../../tests/fixtures/uar-manifest.json'), 'utf8')) as { forms: Array<{ file: string }> };
  const state = ['real-estate-purchase-contract.pdf', 'lead-disclosure-and-acknowledgement.pdf', 'lead-based-paint-addendum.pdf', 'blank-addendum.pdf', 'fha-va-addendum.pdf'];
  let id = 1;
  const rows: FormRow[] = [];
  for (const f of manifest.forms) { const { name, revision } = parseFormFile(f.file); rows.push({ id: id++, code: formCode('uar', f.file), name, source: 'uar', path: `C:\\Forms\\UAR\\${f.file}`, sha256: '', version_label: revision, url: null, bytes: 1, pages: 1, fillable: 0, revision, missing: 0 }); }
  for (const f of state) { const { name, revision } = parseFormFile(f); rows.push({ id: id++, code: formCode('state', f), name, source: 'state', path: `C:\\Forms\\State\\${f}`, sha256: '', version_label: null, url: null, bytes: 1, pages: 1, fillable: 1, revision, missing: 0 }); }
  return rows;
}

describe('forms library naming', () => {
  it('parses the UAR file name into a title and a revision', () => {
    expect(parseFormFile('Sellers Property Condition Disclosure (rev March 3, 2026).pdf')).toEqual({ name: 'Sellers Property Condition Disclosure', revision: 'March 3, 2026' });
    expect(parseFormFile('blank-addendum.pdf')).toEqual({ name: 'blank addendum', revision: null });
    expect(formCode('uar', 'Exclusive Right to Sell Listing Agreement & Agency Disclosure (Designated Agency Brokerage) (rev November 5, 2024).pdf')).toBe('uar:exclusive_right_to_sell_listing_agreement_and_agency_disclosure_designated_agency_brokerage');
  });
});

describe('packet auto-build (rules over the real library)', () => {
  const lib = library();
  it('covers every Exhibit B listing-side line that has a form, with the newest revision', () => {
    const p = proposeByRules('seller', lib, []);
    const names = p.map(x => x.form_name);
    expect(names).toContain('Exclusive Right to Sell Listing Agreement & Agency Disclosure (Designated Agency Brokerage)');
    expect(names).toContain('Sellers Property Condition Disclosure');
    expect(names).toContain('Wire Fraud Alert Disclosure');
    expect(names).toContain('Request to HomeownerCommunity Association for Documentation');
    expect(names).toContain('Real Estate Brokerage Compensation Agreement');
    expect(names).toContain('Disclosure & Acknowledgement Regarding Lead-Based Paint');
    // two revisions of the listing addendum exist (2023, 2024): the 2024 one wins
    const addendum = p.find(x => /^Addendum to Exclusive Right to Sell Listing Agreement/.test(x.form_name))!;
    expect(lib.find(f => f.id === addendum.form_id)?.revision).toBe('June 25, 2024');
    expect(p.find(x => x.form_name.startsWith('Disclosure & Acknowledgement Regarding Lead'))?.required_when).toBe('pre1978');
    expect(p.find(x => x.form_name.startsWith('Request to Homeowner'))?.required_when).toBe('hoa');
    expect(new Set(p.map(x => x.form_id)).size).toBe(p.length); // no duplicates
  });
  it('covers the buyer side: BBA, due diligence checklist, REPC, EMD receipt, resolution addenda, wire fraud', () => {
    const names = proposeByRules('buyer', lib, []).map(x => x.form_name);
    for (const n of ['Exclusive Buyer-Broker Agreement & Agency Disclosure (Designated Agency Brokerage)', 'Buyer Due Diligence Checklist', 'Real Estate Purchase Contract', 'Confirmation of Receipt of Earnest Money', 'Resolution of Due Diligence Addendum to REPC', 'Appraisal Addendum to REPC', 'Wire Fraud Alert Disclosure']) expect(names).toContain(n);
  });
  it('links the MLS residential data sheet (Exhibit B "MLS data entry sheet") and not the lease variant', () => {
    const mls = (name: string, id: number): FormRow => ({ id, code: `custom:${id}`, name, source: 'custom', path: `C:\\Forms\\MLS\\${name}.pdf`, sha256: '', version_label: null, url: null, bytes: 1, pages: 6, fillable: 0, revision: null, missing: 0 });
    const p = proposeByRules('seller', [mls('MLS Data Input Form - Residential Lease', 1), mls('MLS Data Input Form - Residential', 2), mls('MLS Seller Notice to Classify Listing as Limited Marketing', 3)], []);
    expect(p.find(x => x.doc_kind === 'mls_input')?.form_id).toBe(2);
    expect(p.filter(x => x.doc_kind === 'mls_input').map(x => x.form_id).sort()).toEqual([2, 3]);
    expect(classifyForm('seller', mls('MLS Data Input Form - Residential', 2)).doc_kind).toBe('mls_input');
  });
  it('marks forms already in the template and classifies a manual add', () => {
    const bba = lib.find(f => f.name.startsWith('Exclusive Buyer-Broker Agreement'))!;
    const p = proposeByRules('buyer', lib, [{ id: 1, template_id: 1, position: 1, doc_kind: 'bba', label: 'x', required_when: 'always', form_code: null, note: null, form_id: bba.id, source: 'exhibit_b', reason: null }]);
    expect(p.find(x => x.form_id === bba.id)?.already).toBe(true);
    expect(classifyForm('seller', lib.find(f => f.name === 'Wire Fraud Alert Disclosure')!)).toMatchObject({ doc_kind: 'wire_fraud', required_when: 'always' });
    expect(classifyForm('seller', lib.find(f => f.name.startsWith('Utah Residential Lease'))!)).toMatchObject({ doc_kind: 'other' });
  });
});
