/**
 * Open-house planner (Pat's Wednesday). Planning one creates the weekend event plus the two tasks he keeps
 * forgetting: Friday "post it to Marketplace" and Monday "strip the OPEN HOUSE wording from remarks and marketing".
 */
import * as repo from './repo';
import { addDays, dayOfWeek } from './deadlines';

function nextWeekday(from: string, wd: number, allowSame = true): string { let d = from; if (!allowSame) d = addDays(d, 1); while (dayOfWeek(d) !== wd) d = addDays(d, 1); return d; }
export function nextOpenHouseDate(from: string, openHouseDay: 'saturday' | 'sunday' | string): string { return nextWeekday(from, openHouseDay === 'sunday' ? 0 : 6); }

export async function planOpenHouse(tx: repo.TxRow, onDate: string, startTime = '10:00', endTime = '12:00'): Promise<number> {
  const friday = (() => { let d = onDate; while (dayOfWeek(d) !== 5) d = addDays(d, -1); return d; })();
  const monday = nextWeekday(onDate, 1, false);
  const label = `${tx.street ?? 'listing'}${tx.city ? ', ' + tx.city : ''}`;
  const marketplace = await repo.addTask({ transaction_id: tx.id, client_id: tx.client_id, cadence_step_id: null, deadline_id: null, kind: 'task', title: `Post the open house (${onDate} ${startTime}-${endTime}) for ${label} on Facebook Marketplace + social; seller-program graphic as photos 2-3`, body: null, due_on: friday < repo.today() ? repo.today() : friday, due_time: null, priority: 'normal' });
  const cleanup = await repo.addTask({ transaction_id: tx.id, client_id: tx.client_id, cadence_step_id: null, deadline_id: null, kind: 'task', title: `Strip the OPEN HOUSE wording for ${label} from MLS remarks and all marketing (weekend clean-up)`, body: null, due_on: monday, due_time: null, priority: 'normal' });
  await repo.addTask({ transaction_id: tx.id, client_id: tx.client_id, cadence_step_id: null, deadline_id: null, kind: 'task', title: `OPEN HOUSE ${startTime}-${endTime}: ${label}. Sign-in sheet, seller-program handouts, log traffic`, body: null, due_on: onDate, due_time: startTime, priority: 'high' });
  const id = await repo.addOpenHouse({ transaction_id: tx.id, on_date: onDate, start_time: startTime, end_time: endTime, marketplace_task_id: marketplace, cleanup_task_id: cleanup });
  await repo.logEvent('open_house.planned', 'transaction', tx.id, { onDate, startTime, endTime });
  return id;
}

export async function cancelOpenHouse(oh: repo.OpenHouseRow): Promise<void> {
  await repo.cancelTask(oh.marketplace_task_id); await repo.cancelTask(oh.cleanup_task_id);
  await repo.setOpenHouseStatus(oh.id, 'cancelled');
}
