/** Turn a cadence (templates/cadences.json, seeded into cadence_steps) into concrete dated tasks. Pure. */
import { addDays, dayOfWeek, isBusinessDay } from './deadlines';

export interface CadenceStep { id: number; day_offset: number; anchor: string; kind: string; title: string; body_template: string | null; weekdays_only: number }
export interface Anchors { start: string; acceptance?: string | null; due_diligence?: string | null; financing_appraisal?: string | null; settlement?: string | null; closing?: string | null; live?: string | null }
export interface PlannedTask { cadence_step_id: number; kind: string; title: string; body: string | null; due_on: string; priority: 'low' | 'normal' | 'high' | 'urgent' }

function nextWeekday(d: string): string { let x = d; while (dayOfWeek(x) === 0 || dayOfWeek(x) === 6) x = addDays(x, 1); return x; }
function nextBusinessDay(d: string): string { let x = d; while (!isBusinessDay(x)) x = addDays(x, 1); return x; }

export function fill(template: string | null, vars: Record<string, string | null | undefined>): string | null {
  if (!template) return null;
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? `[${k}]`));
}

export function planCadence(steps: CadenceStep[], anchors: Anchors, vars: Record<string, string | null | undefined> = {}): PlannedTask[] {
  const out: PlannedTask[] = [];
  for (const s of steps) {
    const base = (anchors as unknown as Record<string, string | null | undefined>)[s.anchor] ?? (s.anchor === 'start' ? anchors.start : null);
    if (!base) continue; // anchor not known yet (e.g. no settlement date): skip, re-plan when it exists
    let due = addDays(base, s.day_offset);
    if (s.weekdays_only) due = nextWeekday(due);
    const isBroker = /Simple Choice|ICA/.test(s.title);
    if (isBroker) due = nextBusinessDay(due);
    const priority: PlannedTask['priority'] = isBroker || /DECISION|deadline|5 PM/i.test(s.title) ? 'high' : s.kind === 'call' ? 'normal' : 'normal';
    out.push({ cadence_step_id: s.id, kind: s.kind, title: fill(s.title, vars) ?? s.title, body: fill(s.body_template, vars), due_on: due, priority });
  }
  return out.sort((a, b) => a.due_on.localeCompare(b.due_on));
}
