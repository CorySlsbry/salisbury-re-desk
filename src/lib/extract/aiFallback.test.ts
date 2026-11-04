import { describe, it, expect } from 'vitest';
import { testAnswers, windowsFor } from './aiFallback';

const pages = ['EXCLUSIVE RIGHT TO SELL LISTING AGREEMENT\nSeller: Sam R. Whitfield\nList Price: $452,000\nThe Listing Period ends March 5, 2027 at 5:00 PM.', 'Brokerage fee: 2.5% of the purchase price.'];
const asks = [{ key: 'end_date', question: 'the date the listing period ends', kind: 'date' as const }, { key: 'list_price', question: 'the list price', kind: 'money' as const }];

describe('extraction agent tests (pure)', () => {
  it('passes an answer whose quote and value are on the page and parse', () => {
    const t = testAnswers({ answers: [{ key: 'end_date', value: 'March 5, 2027', page: 1, quote: 'Listing Period ends March 5, 2027', found: true }, { key: 'list_price', value: '$452,000', page: 1, quote: 'List Price: $452,000', found: true }], problems: [] }, pages, asks);
    expect(t.confidence).toBe(1); expect(t.problems).toEqual([]); expect([...t.good]).toEqual(['end_date', 'list_price']);
  });
  it('fails a quote that is not on the page, a value not on the page, and a date that does not parse', () => {
    const t = testAnswers({ answers: [{ key: 'end_date', value: 'sometime in spring', page: 1, quote: 'Listing Period ends in spring', found: true }, { key: 'list_price', value: '$452,000', page: 2, quote: 'List Price: $452,000', found: true }], problems: [] }, pages, asks);
    expect(t.problems).toEqual(expect.arrayContaining(['quote-mismatch:end_date', 'value-not-on-page:end_date', 'date-unparsable:end_date', 'quote-mismatch:list_price']));
    expect(t.confidence).toBe(0);
  });
  it('treats "not found" as nothing claimed, a schema failure as zero, and a truncated answer as still testable', () => {
    expect(testAnswers({ answers: [{ key: 'end_date', value: '', page: 0, quote: '', found: false }], problems: [] }, pages, asks).confidence).toBe(1);
    expect(testAnswers({ answers: [], problems: ['schema:invalid-json:x'] }, pages, asks).confidence).toBe(0);
    expect(testAnswers({ answers: [{ key: 'list_price', value: '$452,000', page: 1, quote: 'List Price: $452,000', found: true }], problems: ['schema:truncated'] }, pages, asks).confidence).toBe(1);
  });
  it('narrows the page to windows around the question words', () => {
    const w = windowsFor(pages, asks[0]);
    expect(w).toContain('Listing Period ends'); expect(w.length).toBeLessThan(pages.join('').length + 60);
  });
  it('counts a known value that was missed or misread as a failure, so the loop keeps working', () => {
    const known = { end_date: '2027-03-05', list_price: '452000' };
    const missed = testAnswers({ answers: [{ key: 'list_price', value: '$452,000', page: 1, quote: 'List Price: $452,000', found: true }], problems: [] }, pages, asks, known);
    expect(missed.problems).toContain('missed:end_date'); expect(missed.confidence).toBe(0.5);
    const wrong = testAnswers({ answers: [{ key: 'list_price', value: '$0', page: 1, quote: 'Price: $0', found: true }, { key: 'end_date', value: 'March 5, 2027', page: 1, quote: 'ends March 5, 2027', found: true }], problems: [] }, ['List Price: $452,000 Price: $0 Period ends March 5, 2027'], asks, known);
    expect(wrong.problems).toContain('missed:list_price'); expect(wrong.confidence).toBe(0.5);
  });
  it('treats a run of underscores as an empty line, not a value, and narrows on anchors when given', () => {
    const t = testAnswers({ answers: [{ key: 'end_date', value: '______________', page: 1, quote: 'ends ______________', found: true }], problems: [] }, ['Listing ends ______________'], asks, { end_date: '2027-03-05' });
    expect(t.problems).toEqual(expect.arrayContaining(['blank-line:end_date', 'missed:end_date']));
    const w = windowsFor(['Fee: 2.5 % of the price. Other words here.'], { key: 'fee_pct', question: 'the brokerage fee', kind: 'text', anchors: ['fee'] });
    expect(w).toContain('2.5 %');
  });
  it('refuses a value that does not fit the field\'s pattern (a zero fee, a non-phone)', () => {
    const fee = [{ key: 'fee_pct', question: 'the fee percentage', kind: 'text' as const, pattern: '^\\$?\\s*(?!0(?:\\.0+)?\\s*%?$)\\d{1,2}(?:\\.\\d{1,2})?\\s*%?$' }];
    const page = ['Brokerage fee 2.5 % flat 0'];
    expect(testAnswers({ answers: [{ key: 'fee_pct', value: '0', page: 1, quote: 'flat 0', found: true }], problems: [] }, page, fee).problems).toContain('value-bad-format:fee_pct');
    expect(testAnswers({ answers: [{ key: 'fee_pct', value: '2.5 %', page: 1, quote: 'fee 2.5 %', found: true }], problems: [] }, page, fee).confidence).toBe(1);
  });
});
