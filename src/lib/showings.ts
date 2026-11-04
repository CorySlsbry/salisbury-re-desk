/**
 * Showing feedback, deterministic: paste the showing-service emails (Aligned Showings, ShowingTime, or a text) and
 * this turns them into showing rows per listing. No model involved; a block is a showing when it has a date.
 * Interest is a keyword read on the feedback, never a guess beyond the words present.
 */
import { addShowing, showingCounts } from './repoAuto';
import { toIsoDate, toTime } from './extract/normalize';

export interface ParsedShowing { shown_on: string; shown_at: string | null; agent: string | null; brokerage: string | null; feedback: string | null; interest: 'hot' | 'warm' | 'cold' | 'no_show' | 'unknown'; fingerprint: string }

const DATE_RX = /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,\s*\d{4})?|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})/i;
const TIME_RX = /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i;

function hash(s: string): string { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(16); }

export function interestOf(feedback: string | null): ParsedShowing['interest'] {
  const f = (feedback ?? '').toLowerCase();
  if (!f) return 'unknown';
  if (/no[- ]show|did not show|cancel/.test(f)) return 'no_show';
  if (/offer|second showing|2nd showing|loved|very interested|top of (the|their) list|writing/.test(f)) return 'hot';
  if (/not interested|too small|too expensive|overpriced|passed|no interest|pass on|didn'?t like|too much work|busy road/.test(f)) return 'cold';
  if (/interested|considering|liked|nice|possib|maybe|thinking/.test(f)) return 'warm';
  return 'unknown';
}

/** Split pasted text into showing blocks and read date, time, agent, feedback out of each. */
export function parseShowings(text: string, defaultYear = new Date().getFullYear()): ParsedShowing[] {
  // A block = a blank-line-separated chunk, or a new "Showing Confirmation / Appointment" header (never a plain "Showing Agent:" line).
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n|(?=^(?:Showing (?:Confirmation|Request|Feedback)|Appointment (?:Confirmed|Confirmation)|Feedback for)\b)/im).map(b => b.trim()).filter(b => b.length > 8);
  const out: ParsedShowing[] = [];
  for (const b of blocks) {
    const dm = DATE_RX.exec(b); if (!dm) continue;
    const iso = toIsoDate(dm[1], { defaultYear }); if (!iso) continue;
    const tm = TIME_RX.exec(b);
    // Names stay on their own line: spaces only between name parts, never a newline (or "Brokerage:" would be swallowed).
    const agent = /(?:showing agent|buyer'?s agent|shown by|agent)[ \t]*[:-][ \t]*([A-Z][A-Za-z.'-]+(?:[ \t]+[A-Z][A-Za-z.'-]+){0,3})/i.exec(b)?.[1]?.trim() ?? null;
    const brokerage = /(?:brokerage|company|office)[ \t]*[:-][ \t]*([^\n]{3,60})/i.exec(b)?.[1]?.trim() ?? null;
    const fb = /(?:feedback|comments?|notes?)[:\s-]+([\s\S]{3,1200}?)(?:\n\s*\n|$)/i.exec(b)?.[1]?.replace(/\s+/g, ' ').trim() ?? null;
    out.push({ shown_on: iso, shown_at: tm ? toTime(tm[1]) : null, agent, brokerage, feedback: fb, interest: interestOf(fb), fingerprint: hash(`${iso}|${tm?.[1] ?? ''}|${agent ?? ''}|${(fb ?? '').slice(0, 80)}`) });
  }
  return out;
}

export async function importShowings(transactionId: number, text: string): Promise<{ added: number; duplicates: number; parsed: ParsedShowing[] }> {
  const parsed = parseShowings(text);
  let added = 0, duplicates = 0;
  for (const p of parsed) { const r = await addShowing({ transaction_id: transactionId, source: 'paste', ...p }); if (r === 'added') added++; else duplicates++; }
  return { added, duplicates, parsed };
}

/** Pat's benchmark: 1-2 showings per week. */
export async function showingBenchmark(transactionId: number, weekStart: string): Promise<{ week: number; total: number; verdict: 'under' | 'on' | 'over'; benchmark: string }> {
  const c = await showingCounts(transactionId, weekStart);
  return { week: c.week, total: c.total, verdict: c.week < 1 ? 'under' : c.week > 2 ? 'over' : 'on', benchmark: '1-2 per week' };
}
