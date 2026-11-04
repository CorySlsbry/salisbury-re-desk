import { describe, it, expect } from 'vitest';
import { parseModelJson, salvageArrayObjects } from './modelJson';
import { ExtractionAnswers, PacketPicks, parseToolArgs } from './schemas';

describe('model JSON parsing', () => {
  it('accepts a clean answer, ignoring think blocks and fences', () => {
    const raw = '<think>hmm</think>```json\n{"answers":[{"key":"list_price","value":"$450,000","page":1,"quote":"List Price: $450,000","found":true}]}\n```';
    const r = parseModelJson(ExtractionAnswers, raw, { arrayKey: 'answers' });
    expect(r.ok).toBe(true); expect(r.data?.answers[0].value).toBe('$450,000'); expect(r.salvaged).toBe(false);
  });
  it('salvages the complete objects of a truncated array and reports it', () => {
    const raw = '{"picks":[{"form_number":3,"situation":"FHA loan","required_when":"if_applicable","reason":"FHA addendum"},{"form_number":7,"situation":"VA loan","required_when":"if_app';
    const r = parseModelJson(PacketPicks, raw, { arrayKey: 'picks' });
    expect(r.ok).toBe(true); expect(r.salvaged).toBe(true); expect(r.data?.picks).toHaveLength(1); expect(r.problems).toContain('schema:truncated');
    expect(salvageArrayObjects(raw, 'picks')).toHaveLength(1);
  });
  it('refuses the wrong shape with a named problem', () => {
    const r = parseModelJson(ExtractionAnswers, '{"answers":[{"key":"x","value":"y","page":"one","quote":"","found":"yes"}]}', { arrayKey: 'answers' });
    expect(r.ok).toBe(false); expect(r.problems.join(' ')).toMatch(/schema:answers\.0\./);
    expect(parseModelJson(ExtractionAnswers, 'no json here').problems).toEqual(['schema:no-json']);
  });
  it('validates tool arguments and refuses extras', () => {
    expect(parseToolArgs('list_deadlines', { days_ahead: '14' })).toEqual({ ok: true, args: { days_ahead: 14 } });
    expect(parseToolArgs('list_deadlines', { days_ahead: 14, drop_table: true }).ok).toBe(false);
    expect(parseToolArgs('list_leads', { stage: 'everyone' }).ok).toBe(false);
    expect(parseToolArgs('nope', {}).ok).toBe(false);
  });
});
