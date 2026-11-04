/**
 * In-app automations: small, deterministic "agents" that run on their own (boot, every 15 minutes, after intake)
 * without the language model. Each one reads the database, writes only tasks/deadlines/flags it owns, and logs a
 * run row for the Audit page. The local model stays for drafting text; nothing here depends on it.
 */
import * as repo from './repo';
import { addDays, addBusinessDays, isBusinessDay } from './deadlines';
import { logAutomationRun, listAutomationRuns } from './repoAuto';
import { checkCompliance } from './compliance';
import { native, appPaths } from './native';
import { REPC_VERSION } from './extract/repc';
import { googleStatus, strayLinks, removeOutOfScope, purgeAppCalendarEvents } from './google';
import { llamaHealthy } from './native';
import { askModelForFields } from './extract/aiFallback';
import canary from '../../templates/canary.json';

export type Trigger = 'boot' | 'interval' | 'intake' | 'manual';
export interface AutoResult { ok: boolean; summary: string; details?: unknown }
export interface Automation { key: string; name: string; what: string; every: Trigger[]; run: (ctx: { trigger: Trigger; txId?: number }) => Promise<AutoResult> }

const HOA_DAYS = 14;         // Utah Code 57-8a-227: the association must comply within two weeks of receiving the request
const HOA_PENALTY_BDAY = 11; // $25/day to the owner beginning the 11th business day

async function ensureTask(txId: number, clientId: number, title: string, dueOn: string, priority: 'normal' | 'high' | 'urgent', kind = 'task', body: string | null = null): Promise<boolean> {
  const open = await repo.listTasks({ transactionId: txId, includeDone: true });
  if (open.some(t => t.title === title)) return false;
  await repo.addTask({ transaction_id: txId, client_id: clientId, cadence_step_id: null, deadline_id: null, kind, title, body, due_on: dueOn, due_time: null, priority });
  return true;
}

/* ---------- 1. Broker file (ICA 6.2 clocks + Complete File readiness) ---------- */
const brokerFile: Automation = {
  key: 'broker_file', name: 'Broker File', what: 'Watches every open file against Pat\'s Exhibit B and the ICA clocks (3 business days listing, 2 binding contract, 15-day late fee) and tells you when a Complete File is ready or at risk.',
  every: ['boot', 'interval', 'intake'],
  async run() {
    const t0 = repo.today();
    const txs = await repo.listTransactions({ status: ['active', 'under_contract', 'pending', 'closed'] });
    const flags: string[] = []; let ready = 0, atRisk = 0;
    for (const tx of txs) {
      if (tx.broker_submitted_on) continue;
      const items = await repo.listPacket(tx.id);
      const missing = items.filter(i => i.status === 'missing' && (i.required_when === 'always' || (i.required_when === 'under_contract' && tx.status !== 'active')));
      const deadlines = (await repo.listDeadlines({ transactionId: tx.id })).filter(d => d.basis === 'broker' && d.status === 'pending');
      const label = `${tx.last_name}, ${tx.first_name}${tx.street ? ' - ' + tx.street : ''}`;
      if (!missing.length) { ready++; if (await ensureTask(tx.id, tx.client_id, `Complete File is ready: send it to Pat (${label})`, t0, 'high')) flags.push(`READY: ${label}`); continue; }
      for (const d of deadlines) {
        if (d.due_on <= addDays(t0, 2)) { atRisk++; flags.push(`${d.due_on <= t0 ? 'OVERDUE' : 'DUE ' + d.due_on}: ${d.label} for ${label}; still missing ${missing.map(m => m.label).slice(0, 3).join(', ')}${missing.length > 3 ? ` +${missing.length - 3}` : ''}`); }
      }
      if (tx.closed_on && addDays(tx.closed_on, 15) <= t0) flags.push(`LATE FILE FEE RISK: ${label} closed ${tx.closed_on}, file still incomplete (ICA 6.4: $25/week after 15 days)`);
    }
    return { ok: true, summary: `${txs.length} open file(s): ${ready} ready to send, ${atRisk} at risk`, details: flags };
  },
};

/* ---------- 2. HOA records clock (Utah Code 57-8a-227) ---------- */
const hoaClock: Automation = {
  key: 'hoa_clock', name: 'HOA Clock', what: 'For every listing with an HOA: makes sure the records request goes out the day the listing is signed, then runs the two-week statutory clock (57-8a-227) with a reminder at day 10 and the $25/day language for the follow-up.',
  every: ['boot', 'interval', 'intake'],
  async run() {
    const t0 = repo.today(); let requested = 0, clocked = 0, overdue = 0; const notes: string[] = [];
    for (const tx of await repo.listTransactions({ status: ['active', 'under_contract', 'pending'] })) {
      if (tx.side !== 'seller' || !tx.property_id) continue;
      const prop = await repo.getProperty(tx.property_id); if (!prop || prop.has_hoa !== 1) continue;
      const label = `${tx.street ?? ''} (${tx.last_name})`;
      if (!tx.hoa_request_sent_on) {
        if (await ensureTask(tx.id, tx.client_id, `Send the HOA records request for ${label} (the 14-day clock starts when the association receives it; mark it sent on the client page)`, tx.agreement_signed_on ?? t0, 'high')) requested++;
        continue;
      }
      const due = addDays(tx.hoa_request_sent_on, HOA_DAYS);
      const existing = (await repo.listDeadlines({ transactionId: tx.id })).find(d => d.type === 'hoa_records_due');
      if (!existing) {
        await repo.addDeadline({ transaction_id: tx.id, type: 'hoa_records_due', label: `HOA records due (57-8a-227: 2 weeks from ${tx.hoa_request_sent_on})`, due_on: due, due_time: '17:00', basis: 'compliance', source_document_id: null, source_page: null, confidence: null, status: 'pending', reminder_on: addDays(tx.hoa_request_sent_on, 10), notes: `Utah Code 57-8a-227: the association must comply within two weeks; $25 per day to the owner from the ${HOA_PENALTY_BDAY}th business day (${addBusinessDays(tx.hoa_request_sent_on, HOA_PENALTY_BDAY - 1)}).` });
        clocked++;
      } else if (existing.status === 'pending' && existing.due_on < t0) {
        overdue++;
        if (await ensureTask(tx.id, tx.client_id, `HOA is past the two-week deadline for ${label}: send the follow-up citing 57-8a-227 and the $25/day penalty`, t0, 'urgent')) notes.push(label);
      }
    }
    return { ok: true, summary: `${requested} request task(s) created, ${clocked} clock(s) started, ${overdue} overdue`, details: notes };
  },
};

/* ---------- 3. Compliance scan over stored text ---------- */
const complianceScan: Automation = {
  key: 'compliance_scan', name: 'Compliance Critic', what: 'Runs the brokerage / Fair Housing / mortgage-language gate over every cadence email body and every open task body once a day, so a bad template never reaches a client.',
  every: ['boot'],
  async run() {
    const problems: string[] = [];
    for (const code of ['new_lead_30', 'nurture_monthly', 'listing_launch', 'listing_weekly', 'under_contract_chase', 'post_close_year', 'buyer_onboarding']) {
      for (const s of await repo.listCadenceSteps(code)) {
        if (!s.body_template) continue;
        const v = checkCompliance(s.body_template, s.kind === 'text' ? 'text' : 'email');
        for (const p of v.problems) problems.push(`${code} / ${s.title.slice(0, 40)}: ${p.what}${p.match ? ` ("${p.match}")` : ''}`);
      }
    }
    for (const t of await repo.listTasks({ dueThrough: addDays(repo.today(), 60) })) {
      if (!t.body || !t.cadence_step_id) continue; // only client-facing template bodies; app-written notes (showing digest) are internal
      const v = checkCompliance(t.body, t.kind === 'text' ? 'text' : 'email');
      for (const p of v.problems) problems.push(`task ${t.id} (${t.title.slice(0, 40)}): ${p.what}`);
    }
    return { ok: problems.length === 0, summary: problems.length ? `${problems.length} compliance problem(s) in templates/tasks` : 'templates and task bodies are clean', details: problems };
  },
};

/* ---------- 4. REPC version watch ---------- */
const repcVersion: Automation = {
  key: 'repc_version', name: 'REPC Version Watch', what: `Knows which REPC editions the reader understands (${REPC_VERSION}) and warns before the 2027 form becomes mandatory on 2027-01-01.`,
  every: ['boot'],
  async run() {
    const t0 = repo.today();
    const supported = [REPC_VERSION];
    const daysLeft = Math.round((Date.UTC(2027, 0, 1) - Date.UTC(Number(t0.slice(0, 4)), Number(t0.slice(5, 7)) - 1, Number(t0.slice(8, 10)))) / 86400000);
    const warn = daysLeft <= 120 && !supported.includes('2027');
    return { ok: !warn, summary: warn ? `The 2027 REPC becomes mandatory in ${daysLeft} days and the reader only knows ${supported.join(', ')}. Drop the new state form into Forms\\State when it is published so the field map can be built.` : `REPC reader supports ${supported.join(', ')}; 2027 form due in ${daysLeft} days`, details: { supported, daysLeft } };
  },
};

/* ---------- 5. Off-Drive encrypted backup ---------- */
const offdriveBackup: Automation = {
  key: 'offdrive_backup', name: 'Off-Drive Backup', what: 'Once a day, copies the newest database backup to ~\\.salisbury-re\\backups, DPAPI-encrypted, outside Google Drive, keeping 14. A Drive sync conflict can never be the only copy.',
  every: ['boot'],
  async run() {
    const p = await appPaths();
    const files = (await native.listDir(p.backups)).filter(([f]) => /redesk-\d{4}-\d{2}-\d{2}\.db$/.test(f)).map(([f]) => f).sort();
    const latest = files[files.length - 1]; if (!latest) return { ok: false, summary: 'no daily backup file yet' };
    const r = await native.backupOffdrive(latest);
    return { ok: true, summary: `${latest.split(/[\\/]/).pop()} -> ${r.dest.split(/[\\/]/).pop()} (${r.bytes} bytes encrypted, ${r.kept} kept)` };
  },
};

/* ---------- 6. BitLocker check ---------- */
const bitlocker: Automation = {
  key: 'bitlocker', name: 'Disk Encryption Check', what: 'Asks Windows whether the system drive is BitLocker-protected. Client PII lives on this disk; Settings shows a red banner until it is on.',
  every: ['boot'],
  async run() {
    const s = await native.bitlockerStatus();
    await repo.setSetting('bitlocker_status', s.status);
    await repo.setSetting('bitlocker_checked_at', repo.today());
    return { ok: s.status === 'on', summary: s.status === 'on' ? 'BitLocker is ON for the system drive' : s.status === 'off' ? 'BitLocker is OFF: turn on Device encryption in Windows Settings' : `could not read BitLocker status (${s.detail}); check Windows Settings > Privacy & security > Device encryption` };
  },
};

/* ---------- 7. Showing digest (Monday) ---------- */
const showingDigest: Automation = {
  key: 'showing_digest', name: 'Showing Digest', what: 'Every listing week: counts last week\'s showings against Pat\'s 1-2 per week benchmark and puts the number into the Monday seller-update task so the update is written from facts.',
  every: ['boot', 'interval'],
  async run() {
    const t0 = repo.today(); let touched = 0;
    const { showingCounts } = await import('./repoAuto');
    for (const tx of await repo.listTransactions({ status: ['active'] })) {
      if (tx.side !== 'seller') continue;
      const c = await showingCounts(tx.id, addDays(t0, -7));
      const tasks = await repo.listTasks({ transactionId: tx.id });
      const upd = tasks.find(t => /Weekly seller update/i.test(t.title) && t.due_on >= t0 && t.due_on <= addDays(t0, 6));
      if (!upd) continue;
      const body = `Showings last 7 days: ${c.week} (benchmark 1-2/week${c.week < 1 ? ', UNDER' : c.week > 2 ? ', over' : ', on target'}). Total since listing: ${c.total}. Feedback on file: ${c.withFeedback}.`;
      if (upd.body?.startsWith('Showings last 7 days')) continue;
      await repo.setTaskBody(upd.id, body); touched++;
    }
    return { ok: true, summary: `${touched} seller-update task(s) refreshed with showing counts` };
  },
};

/* ---------- 8. Calendar scope (Google Calendar holds only what Settings allows: deadlines by default) ---------- */
const calendarScope: Automation = {
  key: 'calendar_scope', name: 'Calendar Scope', what: 'Keeps Google Calendar to what Settings says the app may put there (deadlines only unless you add open houses or key tasks). Its own events of any other kind are removed and their links forgotten. Reads the database first and only talks to Google when something has to go.',
  every: ['boot', 'intake', 'manual'],
  async run() {
    if (!(await googleStatus()).connected) return { ok: true, summary: 'Google is not connected; nothing to keep in scope' };
    const scope = (await repo.getSettings()).google_calendar_scope;
    let removed = 0; const files: string[] = [];
    for (const tx of await repo.listTransactions()) {
      if (!(await strayLinks(tx.id, scope)).length) continue;
      removed += await removeOutOfScope(tx.id, scope); files.push(`${tx.last_name}, ${tx.first_name}`);
    }
    return { ok: true, summary: removed ? `${removed} event(s) outside the calendar scope removed from Google Calendar (${files.join('; ')})` : 'Google Calendar matches the scope in Settings', details: files };
  },
};

/* ---------- 9. Calendar purge (only when asked: clean every app-made event off Google Calendar) ---------- */
const calendarPurge: Automation = {
  key: 'calendar_purge', name: 'Calendar Purge', what: 'Acts only when a purge has been requested (the button in Settings sets the request): removes every event this app put on Google Calendar for every file, forgets the links, then clears the request. Events you made yourself are never touched.',
  every: ['boot', 'manual'],
  async run() {
    const s = await repo.getSettings();
    if (s.google_calendar_purge_requested !== '1') return { ok: true, summary: 'No purge requested' };
    if (!(await googleStatus()).connected) return { ok: false, summary: 'A purge is requested but Google is not connected' };
    const r = await purgeAppCalendarEvents();
    await repo.setSetting('google_calendar_purge_requested', '');
    return { ok: true, summary: `${r.removed} app-made event(s) removed from Google Calendar; ${r.kept} other event(s) that mention a client were left alone`, details: r.ids };
  },
};

/* ---------- 10. Model canary (drift watch: the same golden document every day, compared to known values) ---------- */
const modelCanary: Automation = {
  key: 'model_canary', name: 'Model Canary', what: 'Once a day, runs the sample listing agreement through the Extraction Agent and its confidence loop and compares three known values (expiration date, fee %, seller phone). A miss means the model, its driver or a quantization drifted; the row turns red before the model touches a real file.',
  every: ['boot', 'manual'],
  async run({ trigger }) {
    const s = await repo.getSettings();
    if (trigger === 'boot' && s.model_canary_ran_on === repo.today()) return { ok: s.model_canary_last_ok !== '0', summary: `already ran today: ${s.model_canary_last ?? ''}` };
    if (!(await llamaHealthy())) return { ok: true, summary: 'Local model not running; canary skipped' };
    const set = canary.listing; const t0 = performance.now();
    // The golden values are handed to the loop as "known": a miss is a failure it must work through (narrow window, re-ask), not a "not found".
    const r = await askModelForFields(set.pages, set.asks.map(a => ({ key: a.key, question: a.question, kind: a.kind as 'date' | 'money' | 'text' })), undefined, { known: Object.fromEntries(set.asks.map(a => [a.key, a.expect])) });
    const squash = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^0-9a-z]/g, '');
    const results = set.asks.map(a => { const got = r.fields[a.key]?.value ?? null; return { key: a.key, expect: a.expect, got, pass: squash(got) === squash(a.expect) }; });
    const passed = results.filter(x => x.pass).length;
    const summary = `${passed}/${results.length} golden fields correct in ${r.passes} pass${r.passes === 1 ? '' : 'es'} (${r.strategy}), ${Math.round((performance.now() - t0) / 1000)} s`;
    await repo.setSetting('model_canary_ran_on', repo.today()); await repo.setSetting('model_canary_last', summary); await repo.setSetting('model_canary_last_ok', passed === results.length ? '1' : '0');
    return { ok: passed === results.length, summary, details: results.map(x => `${x.key}: expected ${x.expect}, got ${x.got ?? 'nothing'}${x.pass ? '' : ' (MISS)'}`) };
  },
};

/* ---------- 11. salisburyre.com CRM sync (pull website leads + contacts, push clients, deals, deadlines, showings) ---------- */
const crmSync: Automation = {
  key: 'crm_sync', name: 'CRM Sync', what: 'Keeps salisburyre.com in step with this app: pulls new website leads and CRM contacts into the Clients inbox, pushes your clients, listings, contract deadlines and showings to the website dashboard. Idempotent; never deletes.',
  every: ['boot', 'interval', 'manual'],
  async run({ trigger }) {
    const { crmStatus, syncAll } = await import('./crm');
    const st = await crmStatus();
    if (!st.connected) return { ok: true, summary: 'salisburyre.com CRM not connected (Settings)' };
    if (st.mode === 'off' || (st.mode === 'manual' && trigger !== 'manual')) return { ok: true, summary: `CRM sync is ${st.mode}` };
    const r = await syncAll();
    return { ok: true, summary: `${r.pulled.fresh} new lead(s)/contact(s) pulled; ${r.clients.created} contact(s) created, ${r.clients.updated} updated; ${r.tx.deals} deal(s), ${r.tx.milestones} milestone(s), ${r.tx.showings} showing(s) pushed`, details: r };
  },
};

export const AUTOMATIONS: Automation[] = [brokerFile, hoaClock, showingDigest, complianceScan, repcVersion, offdriveBackup, bitlocker, calendarScope, calendarPurge, modelCanary, crmSync];

/** Run every automation that listens to `trigger`; daily ones run once per calendar day. Never throws. */
export async function runAutomations(trigger: Trigger, txId?: number): Promise<AutoResult[]> {
  const out: AutoResult[] = [];
  const runsToday = new Set((await listAutomationRuns(300)).filter(r => r.at.slice(0, 10) === new Date().toISOString().slice(0, 10) /* UTC-DAY-OK: coarse once-a-day throttle only */).map(r => r.key));
  for (const a of AUTOMATIONS) {
    if (!a.every.includes(trigger)) continue;
    if (trigger === 'boot' && !a.every.includes('interval') && runsToday.has(a.key)) continue; // daily ones: once per day
    const t = performance.now();
    try { const r = await a.run({ trigger, txId }); out.push(r); await logAutomationRun({ key: a.key, trigger, ok: r.ok, summary: r.summary, details: r.details, durationMs: Math.round(performance.now() - t) }); }
    catch (e) { const summary = `failed: ${String(e)}`; out.push({ ok: false, summary }); await logAutomationRun({ key: a.key, trigger, ok: false, summary, durationMs: Math.round(performance.now() - t) }).catch(() => {}); }
  }
  return out;
}

/** Boot: run once after the app is ready; then every 15 minutes while it is open. */
export function startAutomationLoop(): () => void {
  const first = window.setTimeout(() => { runAutomations('boot').catch(() => {}); }, 12_000);
  const timer = window.setInterval(() => { runAutomations('interval').catch(() => {}); }, 15 * 60 * 1000);
  return () => { window.clearTimeout(first); window.clearInterval(timer); };
}

export function describeBusinessDay(d: string): string { return isBusinessDay(d) ? 'business day' : 'weekend/holiday'; }
