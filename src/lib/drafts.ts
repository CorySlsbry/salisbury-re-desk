/**
 * Programmed drafts: Pat's scripts as fill-in templates over the report facts. No model. Every placeholder comes
 * from a computed fact, so the Monitor can prove the draft says nothing the database does not. The model may polish a
 * programmed draft later (ai.ts), never replace it.
 */
import templates from '../../templates/drafts.json';
import { checkCompliance, complianceFooter, type Kind, type Verdict } from './compliance';
import { verdictFor, type MonitorVerdict } from './monitor';
import { money } from './fmt';
import { priceOptions, type AtRiskReport, type SellerUpdateFacts, type TouchPick, type PacketGapsReport, type ContentPlan } from './reports';

type Template = { kind: Kind; subject?: string; body: string };
const T = templates as unknown as Record<string, Template | string>;

export interface ProgrammedDraft { key: string; kind: Kind; subject?: string; text: string; facts: Record<string, unknown>; sources: string[]; verdict: Verdict; monitor: MonitorVerdict }

/** Fill {placeholders}; a missing value is a bug, not a blank. */
export function render(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{([a-z_]+)\}/g, (_, k: string) => { const v = vars[k]; if (v === undefined || v === null) throw new Error(`draft placeholder {${k}} has no value`); return String(v); });
}
function finish(key: string, kind: Kind, text: string, facts: Record<string, unknown>, subject?: string): ProgrammedDraft {
  const body = kind === 'email' && !/Simple Choice Real Estate/.test(text) ? `${text}\n\n${complianceFooter()}` : text;
  const sources = [JSON.stringify(facts), body];
  return { key, kind, subject, text: body, facts, sources, verdict: checkCompliance(body, kind), monitor: verdictFor(body, sources, kind) };
}
const tpl = (key: string): Template => { const t = T[key]; if (!t || typeof t === 'string') throw new Error(`no draft template ${key}`); return t; };
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** What the REPC deadline means for the client, in plain words (used by the reminder text and the explain helper). */
export const MEANING: Record<string, string> = {
  seller_disclosure: 'The seller must deliver every seller disclosure (property condition, title commitment, HOA documents) by this date.',
  due_diligence: 'The buyer must finish inspections and either cancel in writing or resolve objections in writing by 5 PM; after that the earnest money is at risk.',
  financing_appraisal: 'The last day the buyer can cancel over financing or a low appraisal and still get the earnest money back.',
  settlement: 'Both sides sign the closing documents and deliver funds; recording and keys follow.',
  emd_to_brokerage: 'The earnest money must be delivered to the brokerage (4 calendar days after acceptance).',
  walkthrough_window_opens: 'The buyer may do the final walk-through from this date on (no earlier than 7 days before settlement).',
};

export function weeklySellerUpdate(f: SellerUpdateFacts, said: { feedback: string; marketNote: string; nextStep: string }, today: string): ProgrammedDraft {
  const t = tpl('weekly_seller_update');
  const dom = f.daysOnMarket ?? 0;
  const vars = {
    first: f.first, property: f.property, date: today, days_on_market: dom,
    feeling: dom <= 14 ? 'Two weeks in is early; most of the serious buyers are only now seeing it.' : dom <= 30 ? 'A month in is where buyers start to ask why, so this is the week we look hard at price and presentation.' : 'This long on the market means the price is the message buyers are hearing; the good news is we control that.',
    buyers_said: said.feedback.trim() ? `What buyers said: ${said.feedback.trim()}` : 'No written feedback came back this week; I am following up with every showing agent.',
    market_line: said.marketNote.trim() ? `The market: ${said.marketNote.trim()}` : 'The market: I will bring the latest competing listings to our next call.',
    showings_week: f.showingsWeek, showings_total: f.showingsTotal, benchmark: f.benchmark,
    showings_verdict: f.verdict === 'over' ? 'We are ahead of it.' : f.verdict === 'on' ? 'We are on it.' : 'We are under it, which is the honest signal to act on.',
    next_step: said.nextStep.trim() || (f.priceReviewDue ? 'This is the three-week mark with traffic under the benchmark, so I will send you three price options tomorrow.' : 'Keep the showings flowing and reassess next week.'),
    next_update_day: DAYS[1],
  };
  return finish('weekly_seller_update', t.kind, render(t.body, vars), { ...f, ...said, ...vars }, render(t.subject!, vars));
}

export function priceDropThreeOptions(f: SellerUpdateFacts): ProgrammedDraft {
  if (f.listPrice == null) throw new Error('no list price on this file');
  const t = tpl('price_drop_three_options');
  const o = priceOptions(f.listPrice);
  const vars = { first: f.first, property: f.property, days_on_market: f.daysOnMarket ?? 0, showings_total: f.showingsTotal, list_price: money(f.listPrice), option_threshold: money(o.threshold), option_decisive: money(o.decisive), decisive_pct: o.decisivePct,
    recommendation: f.verdict === 'under' ? `option 2, ${money(o.threshold)}, because traffic is under the benchmark and the threshold opens a new set of buyers.` : `option 1 for one more week, because traffic is holding.` };
  return finish('price_drop_three_options', t.kind, render(t.body, vars), { ...f, ...o, ...vars }, render(t.subject!, vars));
}

export function deadlineReminder(d: { type: string; label: string; due_on: string; due_time: string; notes?: string | null }, tx: { first_name: string; street: string | null; side: string }): ProgrammedDraft {
  const t = tpl('deadline_reminder');
  const vars = { first: tx.first_name, label: d.label, property: tx.street ?? 'your home', due_on: d.due_on, due_time: d.due_time, meaning: MEANING[d.type] ?? d.notes ?? '', ask: tx.side === 'buyer' ? 'Send me anything you still need to decide before then.' : 'Let me know if anything on your side is still open.' };
  return finish('deadline_reminder', t.kind, render(t.body, vars).replace(/\s{2,}/g, ' ').trim(), { ...d, ...vars });
}

export function touchText(p: TouchPick): ProgrammedDraft {
  const t = tpl(p.kind === 'gratitude' ? 'touch_gratitude' : 'touch_business');
  const vars = { first: p.first, reason: p.reason };
  return finish(t.kind === 'text' ? 'touch' : 'touch', t.kind, render(t.body, vars), { ...p });
}

export function completeFileNag(first: string, item: string, owedBy: string): ProgrammedDraft {
  const t = tpl('complete_file_nag');
  const vars = { first, item, owed_by: owedBy };
  return finish('complete_file_nag', t.kind, render(t.body, vars), vars);
}

/* ---------- report renderers (what the Coordinator, Packet, Follow-up and Content agents now answer with) ---------- */
const line = (l: { title: string; client: string; property: string | null; dueOn: string; dueTime: string | null; daysLeft: number }) => `- ${l.dueOn}${l.dueTime ? ' ' + l.dueTime : ''} (${l.daysLeft < 0 ? `${-l.daysLeft} days overdue` : l.daysLeft === 0 ? 'today' : `in ${l.daysLeft} days`}): ${l.title}, ${l.client}${l.property ? ', ' + l.property : ''}`;
export function atRiskText(r: AtRiskReport): ProgrammedDraft {
  const t = tpl('at_risk_report');
  const vars = {
    date: r.today, days: r.days, overdue_count: r.overdue.length, overdue_lines: r.overdue.map(line).join('\n') || '- nothing overdue',
    next_count: r.next.length, next_lines: r.next.map(line).join('\n') || `- nothing due in the next ${r.days} days`,
    clock_lines: r.clocks.map(c => `- ${c.clock} for ${c.client}${c.property ? ', ' + c.property : ''}: owed by ${c.owedBy}${c.late ? ' (LATE)' : c.daysLeft === 0 ? ' (today)' : ''}`).join('\n') || '- every open file is submitted',
    gap_lines: r.gaps.map(g => `- ${g.client}${g.property ? ', ' + g.property : ''}: ${g.label}${g.requiredWhen ? ` (${g.requiredWhen})` : ''}`).join('\n') || '- no missing items',
  };
  return finish('at_risk_report', t.kind, render(t.body, vars), { ...r });
}
export function packetGapsText(r: PacketGapsReport): ProgrammedDraft {
  const text = r.files.length ? r.files.map(f => `${f.client}${f.property ? ', ' + f.property : ''} (${f.side}): ${f.missing.length} missing\n${f.missing.map(m => `- ${m.label}${m.requiredWhen ? ` (${m.requiredWhen})` : ''}`).join('\n')}${f.clock ? `\nChase today: ${f.clock.clock} owed by ${f.clock.owedBy}${f.clock.late ? ' (LATE)' : ''}` : ''}`).join('\n\n') : 'Every open file is complete.';
  return finish('packet_gaps', 'text', text, { ...r });
}
export function touchesText(p: { date: string; done: number; target: number; picks: TouchPick[] }): ProgrammedDraft {
  const text = `${p.date}: ${p.done} of ${p.target} touches logged.\n\n${p.picks.map((x, i) => `${i + 1}. ${x.name} (${x.channel}, ${x.kind}): ${x.reason}`).join('\n') || 'Nobody is due today; add a lead or log a touch.'}`;
  return finish('touches', 'text', text, { ...p });
}
export function contentText(c: ContentPlan): ProgrammedDraft {
  const text = `${c.date}\n\nIdeas queued (${c.ideas.length}):\n${c.ideas.map(i => `- ${i.text}${i.hook ? ` (hook: ${i.hook})` : ''}`).join('\n') || '- none captured yet'}\n\nReel slots today:\n${c.slots.map(s => `- ${s.time} ${s.platform}`).join('\n')}\n\nRoom left:\n${c.room.map(r => `- ${r.platform}: ${r.posted}/${r.cap}`).join('\n')}`;
  return finish('content_plan', 'text', text, { ...c });
}
