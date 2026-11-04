/** Windows toast reminders for deadlines whose reminder date has arrived. Runs in the main window; idempotent per day. */
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { db } from './native';
import { today } from './repo';

interface Due { id: number; label: string; due_on: string; due_time: string; reminder_on: string | null; first_name: string; last_name: string; street: string | null }

export async function runReminderSweep(): Promise<number> {
  const d = await db();
  const t0 = today();
  const rows = await d.select<Due[]>(`SELECT dl.id, dl.label, dl.due_on, dl.due_time, dl.reminder_on, c.first_name, c.last_name, p.street
     FROM deadlines dl JOIN transactions t ON t.id = dl.transaction_id JOIN clients c ON c.id = t.client_id LEFT JOIN properties p ON p.id = t.property_id
     WHERE dl.status = 'pending' AND ((dl.reminder_on IS NOT NULL AND dl.reminder_on <= $1) OR dl.due_on <= $1)
       AND NOT EXISTS (SELECT 1 FROM events e WHERE e.name = 'reminder.sent' AND e.subject_type = 'deadline' AND e.subject_id = dl.id AND substr(e.at, 1, 10) = date('now', 'localtime'))
     ORDER BY dl.due_on, dl.due_time`, [t0]);
  if (!rows.length) return 0;
  let ok = await isPermissionGranted();
  if (!ok) ok = (await requestPermission()) === 'granted';
  for (const r of rows) {
    const when = r.due_on === t0 ? `TODAY ${r.due_time}` : r.due_on < t0 ? `OVERDUE (${r.due_on})` : `${r.due_on} ${r.due_time}`;
    if (ok) sendNotification({ title: `${when} · ${r.label}`, body: `${r.last_name}, ${r.first_name}${r.street ? ' · ' + r.street : ''}` });
    await d.execute("INSERT INTO events(name, subject_type, subject_id, payload_json) VALUES ('reminder.sent', 'deadline', $1, $2)", [r.id, JSON.stringify({ when, toast: ok })]);
  }
  return rows.length;
}

/** Sweep now and every 30 minutes while the app is open. */
export function startReminderLoop(): () => void {
  let timer: number | undefined;
  const tick = () => { runReminderSweep().catch(() => {}); };
  const first = window.setTimeout(tick, 8000);
  timer = window.setInterval(tick, 30 * 60 * 1000);
  return () => { window.clearTimeout(first); if (timer) window.clearInterval(timer); };
}
