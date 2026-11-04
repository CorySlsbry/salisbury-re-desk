import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classify } from './intake';

const text = (n: string) => (JSON.parse(readFileSync(resolve(__dirname, '../../tests/fixtures', n), 'utf8')).pages as Array<{ text: string }>).map(p => p.text).join('\n');

describe('document classifier goes by the title, not the body', () => {
  it('the listing agreement mentions "real estate purchase contract" on page 2 and is still a listing agreement', () => {
    expect(classify(text('listing-filled.text.json'))).toMatchObject({ kind: 'listing_agreement', confidence: 0.95 });
  });
  it('buyer-broker agreement and REPC', () => {
    expect(classify(text('bba-filled.text.json')).kind).toBe('bba');
    expect(classify(text('repc-filled.text.json')).kind).toBe('repc');
    expect(classify(text('repc-flat.text.json')).kind).toBe('repc');
  });
  it('OCR text of a scanned listing agreement (page 1 only) still classifies', () => {
    const ocr = JSON.parse(readFileSync(resolve(__dirname, '../../tests/fixtures/listing-scan.p1.ocr.json'), 'utf8')).text as string;
    expect(classify(ocr).kind).toBe('listing_agreement');
  });
  it('an addendum wins over the contract it amends', () => {
    expect(classify('ADDENDUM NO. 1 TO REAL ESTATE PURCHASE CONTRACT ...').kind).toBe('addendum');
    expect(classify('nothing here').kind).toBe('other');
  });
});
