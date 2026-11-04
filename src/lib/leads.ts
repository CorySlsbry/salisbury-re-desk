/**
 * Leads pipeline (Pat's automation deck, CRM-agnostic port): a new lead starts the 30-day drip (6 emails on
 * autopilot in his stack; here every step is a task with copy-ready text, weekdays only), pauses the instant they
 * reply (then: call within 5 minutes), and rolls into the 12-month nurture when day 30 passes without a decision.
 */
import * as repo from './repo';
import { planCadence } from './cadences';
import { addDays } from './deadlines';

export async function enroll(clientId: number, code: 'new_lead_30' | 'nurture_monthly' | 'post_close_year', startOn = repo.today()): Promise<number> {
  const cadenceId = await repo.getCadenceId(code);
  if (!cadenceId) throw new Error(`cadence ${code} not seeded`);
  const c = await repo.getClient(clientId);
  const steps = await repo.listCadenceSteps(code);
  const s = await repo.getSettings();
  const vars = { first_name: c?.first_name ?? '', city: 'Utah County', phone: s.agent_phone };
  for (const t of planCadence(steps, { start: startOn }, vars)) {
    await repo.addTask({ transaction_id: null, client_id: clientId, cadence_step_id: t.cadence_step_id, deadline_id: null, kind: t.kind, title: t.title, body: t.body, due_on: t.due_on, due_time: null, priority: t.priority });
  }
  const id = await repo.addEnrollment(clientId, cadenceId, startOn);
  await repo.updateClient(clientId, { stage: code === 'nurture_monthly' ? 'nurture' : code === 'post_close_year' ? 'past' : 'lead' });
  await repo.logEvent('lead.enrolled', 'client', clientId, { code, startOn });
  return id;
}

/** The lead replied: stop every automated step, and the human calls within 5 minutes. */
export async function markReplied(clientId: number): Promise<void> {
  const enrollments = await repo.listEnrollments(clientId);
  let removed = 0;
  for (const e of enrollments) if (!e.paused_at && !e.completed_at && !e.cancelled_at) removed += await repo.pauseEnrollment(e.id);
  const c = await repo.getClient(clientId);
  await repo.updateClient(clientId, { replied_at: new Date().toISOString(), last_touch_on: repo.today() });
  await repo.addTask({ transaction_id: null, client_id: clientId, cadence_step_id: null, deadline_id: null, kind: 'call', title: `${c?.first_name ?? 'Lead'} replied: CALL WITHIN 5 MINUTES (the drip did its job; speed converts it)`, body: null, due_on: repo.today(), due_time: null, priority: 'urgent' });
  await repo.logEvent('lead.replied', 'client', clientId, { removedTasks: removed });
}

/** Day 30 passed without a decision: hand off to the monthly nurture. Idempotent; call on Engine load. */
export async function rollDripsToNurture(): Promise<number> {
  const leads = await repo.listPeople('lead');
  let rolled = 0;
  for (const l of leads) {
    const ens = await repo.listEnrollments(l.id);
    const drip = ens.find(e => e.code === 'new_lead_30' && !e.cancelled_at && !e.paused_at);
    if (!drip || ens.some(e => e.code === 'nurture_monthly')) continue;
    if (addDays(drip.started_on, 31) > repo.today()) continue;
    await enroll(l.id, 'nurture_monthly');
    rolled++;
  }
  return rolled;
}
