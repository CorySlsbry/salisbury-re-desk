/**
 * Google Calendar + Gmail on Cory's own account, OAuth 2.0 "Desktop app" client with PKCE and a loopback redirect.
 * Cory pastes his client id (settings table) and client secret once. The client secret and the tokens are stored
 * DPAPI-encrypted under %USERPROFILE%\.salisbury-re\secrets, outside the Drive-synced data folder, never in SQLite.
 * Scopes: calendar.events (push deadlines, tasks, open houses), gmail.compose (create drafts, never send),
 * drive.file (upload + share only the files this app created) and contacts (save clients to Google Contacts).
 */
import { open } from '@tauri-apps/plugin-shell';
import { readFile, readTextFile } from '@tauri-apps/plugin-fs';
import { native } from './native';
import * as repo from './repo';
import { addDays } from './deadlines';

const SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/contacts'];
/** Exactly what each scope lets the app do. Shown in Settings before Cory clicks connect, and on the Google consent screen. */
export const GOOGLE_PERMISSIONS: Array<{ scope: string; name: string; does: string }> = [
  { scope: SCOPES[0], name: 'Calendar', does: 'Create and update the calendar events it made (REPC deadlines by default; open houses and key tasks only if you turn them on in Settings), and remove its own events that fall outside that choice or are duplicate copies. It never touches events it did not create.' },
  { scope: SCOPES[1], name: 'Gmail drafts', does: 'Create drafts in your Gmail for you to review and send. It never sends and never reads mail.' },
  { scope: SCOPES[2], name: 'Drive', does: 'Upload the files you pick into a "Salisbury RE Desk" folder in your Drive and share them by link (the Complete File to Pat, disclosures to a client). It cannot see any other Drive file.' },
  { scope: SCOPES[3], name: 'Contacts', does: 'Save a client (name, phone, email, mailing address) to Google Contacts when you click the button, so caller ID and Gmail autocomplete know them.' },
];
const PORT = 8794;
const TZ = 'America/Denver';
const SECRET = { clientSecret: 'google_client_secret', refresh: 'google_refresh_token', access: 'google_access_token' } as const;

function b64url(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function sha256(s: string): Promise<Uint8Array> { return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))); }
function hex(bytes: Uint8Array): string { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }

/** One run per key at a time: a second click while the first is still working joins that run instead of starting a twin. */
const inflight = new Map<string, Promise<unknown>>();
export function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = fn().finally(() => { inflight.delete(key); });
  inflight.set(key, p);
  return p;
}

/** One-time move of any secret that an earlier build stored in the settings table (which Drive syncs). */
async function migratePlaintext(): Promise<void> {
  const s = await repo.getSettings();
  for (const [key, name] of [['google_client_secret', SECRET.clientSecret], ['google_refresh_token', SECRET.refresh], ['google_access_token', SECRET.access]] as const) {
    if (s[key]) { if (!(await native.secretGet(name))) await native.secretSet(name, s[key]); await repo.setSetting(key, ''); }
  }
}
export async function setClientSecret(v: string): Promise<void> { await native.secretSet(SECRET.clientSecret, v.trim()); }

export interface GoogleStatus { configured: boolean; connected: boolean; email?: string; error?: string; missing: string[] }
export async function googleStatus(): Promise<GoogleStatus> {
  await migratePlaintext();
  const s = await repo.getSettings();
  const [secret, refresh] = await Promise.all([native.secretGet(SECRET.clientSecret), native.secretGet(SECRET.refresh)]);
  // Granted scopes are recorded at connect time; a token from a build that asked for fewer scopes lacks the new ones until Cory reconnects.
  const granted = (s.google_scopes || SCOPES.slice(0, 2).join(' ')).split(' ').filter(Boolean);
  const missing = refresh ? GOOGLE_PERMISSIONS.filter(p => !granted.includes(p.scope)).map(p => p.name) : [];
  return { configured: !!(s.google_client_id && secret), connected: !!refresh, email: s.google_email || undefined, missing };
}

/** Import the "client_secret_*.json" that the Google console offers as Download JSON: client id to settings, secret to DPAPI. */
export async function importClientJson(path: string): Promise<string> {
  let j: { installed?: { client_id?: string; client_secret?: string }; web?: { client_id?: string; client_secret?: string } };
  try { j = JSON.parse(await readTextFile(path)); } catch { throw new Error('That file is not readable as JSON. Pick the client_secret_….json that Google offered as Download JSON.'); }
  const c = j.installed ?? j.web;
  if (!c?.client_id || !c?.client_secret) throw new Error('That JSON has no "installed" client id and secret. In the Google console the client must be a Desktop app.');
  if (j.web && !j.installed) throw new Error('That client is a Web application. The app needs a Desktop app client (loopback redirect).');
  await repo.setSetting('google_client_id', String(c.client_id));
  await native.secretSet(SECRET.clientSecret, String(c.client_secret));
  await repo.logEvent('google.client_imported', undefined, undefined, { file: path.split(/[\\/]/).pop() });
  return String(c.client_id);
}

/** Full connect flow: opens the browser, waits on the loopback for the code, exchanges it, stores the refresh token. */
export async function connectGoogle(onStep?: (s: string) => void): Promise<GoogleStatus> {
  await migratePlaintext();
  const s = await repo.getSettings();
  const clientSecret = await native.secretGet(SECRET.clientSecret);
  if (!s.google_client_id || !clientSecret) throw new Error('Paste the Google OAuth client id and secret first (Settings).');
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await sha256(verifier));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const redirect = `http://127.0.0.1:${PORT}/`;
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: s.google_client_id, redirect_uri: redirect, response_type: 'code', scope: SCOPES.join(' '), code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent' })}`;
  onStep?.('Waiting for you to approve in the browser');
  const listen = native.oauthListen(PORT, 300);
  await open(url);
  const query = new URLSearchParams(await listen);
  if (query.get('error')) throw new Error(`Google said: ${query.get('error')}`);
  if (query.get('state') !== state) throw new Error('OAuth state mismatch; try again.');
  onStep?.('Exchanging the code');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: s.google_client_id, client_secret: clientSecret, code: query.get('code')!, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirect }) });
  const j = await r.json();
  if (!r.ok || !j.refresh_token) throw new Error(`Token exchange failed: ${j.error_description ?? j.error ?? r.status}`);
  await native.secretSet(SECRET.refresh, j.refresh_token);
  await native.secretSet(SECRET.access, j.access_token);
  await repo.setSetting('google_token_expires_at', String(Date.now() + (j.expires_in ?? 3600) * 1000 - 60_000));
  await repo.setSetting('google_scopes', String(j.scope ?? SCOPES.join(' ')));
  try { const me = await api('https://www.googleapis.com/gmail/v1/users/me/profile'); if (me.emailAddress) await repo.setSetting('google_email', me.emailAddress); } catch { /* optional */ }
  await repo.logEvent('google.connected');
  return googleStatus();
}
export async function disconnectGoogle(): Promise<void> {
  for (const n of [SECRET.refresh, SECRET.access]) await native.secretSet(n, '');
  for (const k of ['google_token_expires_at', 'google_email', 'google_scopes']) await repo.setSetting(k, '');
  await repo.logEvent('google.disconnected');
}

async function accessToken(): Promise<string> {
  const s = await repo.getSettings();
  const [refresh, access, clientSecret] = await Promise.all([native.secretGet(SECRET.refresh), native.secretGet(SECRET.access), native.secretGet(SECRET.clientSecret)]);
  if (!refresh) throw new Error('Google is not connected (Settings).');
  if (access && Number(s.google_token_expires_at ?? 0) > Date.now()) return access;
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: s.google_client_id, client_secret: clientSecret ?? '', refresh_token: refresh, grant_type: 'refresh_token' }) });
  const j = await r.json();
  if (!r.ok) throw new Error(`Google token refresh failed: ${j.error_description ?? j.error}`);
  await native.secretSet(SECRET.access, j.access_token);
  await repo.setSetting('google_token_expires_at', String(Date.now() + (j.expires_in ?? 3600) * 1000 - 60_000));
  return j.access_token;
}
async function api(url: string, init: RequestInit = {}): Promise<Record<string, unknown> & { emailAddress?: string; id?: string }> {
  const tok = await accessToken();
  const r = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}), authorization: `Bearer ${tok}` } });
  const text = await r.text();
  if (!r.ok) throw new Error(`Google ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/* ---------- calendar ---------- */
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const APP_MARK = 'Salisbury RE Desk';
export type EventKind = 'deadline' | 'task' | 'open_house';
export type CalendarScope = 'deadlines' | 'deadlines_open_houses' | 'all';
export const CALENDAR_SCOPES: Array<[CalendarScope, string]> = [['deadlines', 'deadlines only'], ['deadlines_open_houses', 'deadlines + open houses'], ['all', 'deadlines + open houses + key tasks']];
/** Pure. Which kinds of event the calendar scope puts on Google Calendar. Deadlines only unless Settings says more (Cory, 2026-09-07). */
export function calendarIncludes(scope: string | undefined, kind: EventKind): boolean {
  const sc: CalendarScope = scope === 'all' || scope === 'deadlines_open_houses' ? scope : 'deadlines';
  return kind === 'deadline' || (kind === 'open_house' && sc !== 'deadlines') || (kind === 'task' && sc === 'all');
}
interface EventSpec { kind: EventKind; refId: number; txId: number; summary: string; description: string; date: string; time?: string | null; endTime?: string | null; reminderMinutes?: number[] }
function fingerprint(e: EventSpec): string { return JSON.stringify([e.summary, e.description, e.date, e.time, e.endTime]); }
function eventBody(e: EventSpec) {
  const timed = !!e.time;
  const start = timed ? { dateTime: `${e.date}T${e.time}:00`, timeZone: TZ } : { date: e.date };
  const end = timed ? { dateTime: `${e.date}T${e.endTime ?? addMinutes(e.time!, 30)}:00`, timeZone: TZ } : { date: addDays(e.date, 1) };
  return { summary: e.summary, description: e.description, start, end, reminders: { useDefault: false, overrides: (e.reminderMinutes ?? [24 * 60, 120]).map(m => ({ method: 'popup', minutes: m })) }, extendedProperties: { private: { redesk_key: `${e.kind}:${e.refId}`, redesk_tx: String(e.txId) } }, source: { title: APP_MARK, url: 'https://salisburyre.com' } };
}
function addMinutes(hhmm: string, n: number): string { const [h, m] = hhmm.split(':').map(Number); const t = h * 60 + m + n; return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; }

export interface GEvent { id: string; summary?: string; description?: string; created?: string; status?: string; iCalUID?: string; start?: { date?: string; dateTime?: string }; extendedProperties?: { private?: Record<string, string> } }
async function listEvents(params: Record<string, string>): Promise<GEvent[]> {
  const out: GEvent[] = []; let pageToken = '';
  do {
    const j = await api(`${CAL}?${new URLSearchParams({ maxResults: '250', singleEvents: 'true', showDeleted: 'false', ...params, ...(pageToken ? { pageToken } : {}) })}`);
    out.push(...((j.items as GEvent[] | undefined) ?? []));
    pageToken = String(j.nextPageToken ?? '');
  } while (pageToken);
  return out;
}
/** Only events this app made: tagged with its private key, or (older pushes) carrying its signature in the description. */
export function isAppEvent(e: GEvent): boolean { return !!e.extendedProperties?.private?.redesk_key || (e.description ?? '').includes(APP_MARK); }
function eventDay(e: GEvent): string { return (e.start?.dateTime ?? e.start?.date ?? '').slice(0, 10); }
function oldestFirst(a: GEvent, b: GEvent): number { return (a.created ?? '').localeCompare(b.created ?? ''); }
/** Ask Google whether this event already exists before creating it: first by the private tag, then (older pushes) by summary + day. */
async function findExisting(e: EventSpec): Promise<GEvent | null> {
  const tagged = (await listEvents({ privateExtendedProperty: `redesk_key=${e.kind}:${e.refId}` })).filter(x => x.status !== 'cancelled');
  if (tagged.length) return tagged.sort(oldestFirst)[0];
  // UTC-DAY-OK: the window is only a search bound; the match uses the event's own local start date.
  const legacy = await listEvents({ q: e.summary, timeMin: `${addDays(e.date, -1)}T00:00:00Z`, timeMax: `${addDays(e.date, 2)}T00:00:00Z` });
  const hit = legacy.filter(x => x.status !== 'cancelled' && isAppEvent(x) && (x.summary ?? '').trim() === e.summary.trim() && eventDay(x) === e.date);
  return hit.sort(oldestFirst)[0] ?? null;
}

async function upsertEvent(e: EventSpec): Promise<'created' | 'updated' | 'unchanged' | 'relinked'> {
  let link = await repo.getCalendarLink(e.kind, e.refId);
  const fp = fingerprint(e);
  if (link && link.fingerprint === fp) return 'unchanged';
  let relinked = false;
  if (!link) {
    // No local record (fresh or restored database, or a push from an older build): check Google before creating anything.
    const found = await findExisting(e);
    if (found) { await repo.setCalendarLink(e.kind, e.refId, found.id, 'primary', ''); link = await repo.getCalendarLink(e.kind, e.refId); relinked = true; }
  }
  if (link) {
    try {
      await api(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(link.calendar_id)}/events/${link.google_event_id}`, { method: 'PATCH', body: JSON.stringify(eventBody(e)) });
      await repo.setCalendarLink(e.kind, e.refId, link.google_event_id, link.calendar_id, fp);
      return relinked ? 'relinked' : 'updated';
    } catch (err) { if (!/404|410/.test(String(err))) throw err; }
  }
  const created = await api(CAL, { method: 'POST', body: JSON.stringify(eventBody(e)) });
  await repo.setCalendarLink(e.kind, e.refId, String(created.id), 'primary', fp);
  return 'created';
}

/** Push one transaction's deadlines, dated tasks and open houses. Idempotent: unchanged events are skipped. */
export interface PushResult { created: number; updated: number; unchanged: number; relinked: number; removed: number }
export function pushTransactionToCalendar(txId: number, onStep?: (s: string) => void): Promise<PushResult> { return singleFlight(`calendar:${txId}`, () => pushNow(txId, onStep)); }
async function pushNow(txId: number, onStep?: (s: string) => void): Promise<PushResult> {
  const tx = await repo.getTransaction(txId); if (!tx) throw new Error('no transaction');
  const scope = (await repo.getSettings()).google_calendar_scope;
  const who = `${tx.last_name}, ${tx.first_name}`; const where = tx.street ? `${tx.street}${tx.city ? ', ' + tx.city : ''}` : '';
  const specs: EventSpec[] = [];
  for (const d of await repo.listDeadlines({ transactionId: txId })) {
    if (d.status === 'waived' || d.status === 'superseded') continue;
    specs.push({ kind: 'deadline', refId: d.id, txId, summary: `${d.label} - ${who}${where ? ' - ' + where : ''}`, description: `${d.basis} deadline. ${d.notes ?? ''}\nSalisbury RE Desk`, date: d.due_on, time: d.due_time, endTime: addMinutes(d.due_time, 30), reminderMinutes: d.basis === 'contract' ? [3 * 24 * 60, 24 * 60, 120] : [24 * 60, 120] });
  }
  for (const t of calendarIncludes(scope, 'task') ? await repo.listTasks({ transactionId: txId }) : []) {
    if (!/open house|seller update|market review|submit/i.test(t.title)) continue; // only the calendar-worthy tasks; the rest live in the app
    specs.push({ kind: 'task', refId: t.id, txId, summary: `${t.title.slice(0, 80)} - ${who}`, description: `${t.body ?? ''}\nSalisbury RE Desk`, date: t.due_on, time: t.due_time ?? null, reminderMinutes: [60] });
  }
  for (const oh of calendarIncludes(scope, 'open_house') ? await repo.listOpenHouses({ from: '0000', to: '9999' }) : []) {
    if (oh.transaction_id !== txId) continue;
    specs.push({ kind: 'open_house', refId: oh.id, txId, summary: `OPEN HOUSE ${where}`, description: `${who}\nSalisbury RE Desk`, date: oh.on_date, time: oh.start_time, endTime: oh.end_time, reminderMinutes: [24 * 60, 60] });
  }
  const out: PushResult = { created: 0, updated: 0, unchanged: 0, relinked: 0, removed: 0 };
  for (const [i, s] of specs.entries()) { onStep?.(`Calendar ${i + 1}/${specs.length}: ${s.summary.slice(0, 40)}`); out[await upsertEvent(s)]++; }
  out.removed = await removeOutOfScope(txId, scope, onStep);
  await repo.logEvent('google.calendar.pushed', 'transaction', txId, out);
  return out;
}
/** Links this file holds for kinds outside the calendar scope. A database read only, so callers can skip Google when there is nothing to remove. */
export async function strayLinks(txId: number, scope?: string): Promise<repo.CalendarLink[]> {
  const [tasks, openHouses, links] = await Promise.all([repo.listTasks({ transactionId: txId, includeDone: true }), repo.listOpenHouses({ from: '0000', to: '9999' }), repo.listCalendarLinks()]);
  const refs = new Map<string, EventKind>();
  for (const t of tasks) refs.set(`task:${t.id}`, 'task');
  for (const o of openHouses) if (o.transaction_id === txId) refs.set(`open_house:${o.id}`, 'open_house');
  return links.filter(l => { const k = refs.get(`${l.kind}:${l.ref_id}`); return !!k && !calendarIncludes(scope, k); });
}
/** Delete the app's own events of kinds that Settings no longer puts on the calendar (for example the weekly task events pushed before "deadlines only"), and forget their links. */
export async function removeOutOfScope(txId: number, scope?: string, onStep?: (s: string) => void): Promise<number> {
  const sc = scope ?? (await repo.getSettings()).google_calendar_scope;
  const stray = await strayLinks(txId, sc);
  let n = 0;
  for (const [i, l] of stray.entries()) {
    onStep?.(`Removing ${i + 1}/${stray.length} event(s) outside the calendar scope`);
    try { await api(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(l.calendar_id)}/events/${l.google_event_id}`, { method: 'DELETE' }); }
    catch (err) { if (!/404|410/.test(String(err))) throw err; }
    await repo.deleteCalendarLink(l.kind, l.ref_id); n++;
  }
  if (n) await repo.logEvent('google.calendar.out_of_scope_removed', 'transaction', txId, { removed: n, scope: sc || 'deadlines' });
  return n;
}

/* ---------- calendar purge: undo every event the app ever put on the calendar (clean-up after tests) ---------- */
/** Pure. An event is the app's if it carries the tag or signature, came from the app's .ics file, or has exactly a summary the app would have written. */
export function isAppMadeOrKnown(e: GEvent, summaries: Set<string>): boolean {
  return isAppEvent(e) || (e.iCalUID ?? '').endsWith('@salisbury-re-desk') || summaries.has((e.summary ?? '').trim().toLowerCase());
}
/** Every summary the app would ever have written for the files in the database, so events from the .ics file or the browser links (no tag, no signature) are recognised too. */
async function appSummaries(): Promise<{ summaries: Set<string>; names: string[] }> {
  const summaries = new Set<string>(); const names = new Set<string>();
  const openHouses = await repo.listOpenHouses({ from: '0000', to: '9999' });
  for (const tx of await repo.listTransactions()) {
    const who = `${tx.last_name}, ${tx.first_name}`; const where = tx.street ? `${tx.street}${tx.city ? ', ' + tx.city : ''}` : '';
    names.add(who);
    for (const d of await repo.listDeadlines({ transactionId: tx.id })) { summaries.add(`${d.label} - ${who}${where ? ' - ' + where : ''}`); summaries.add(`${d.label} - ${who} - ${where}`); summaries.add(`${d.label} - ${who}`); }
    for (const t of await repo.listTasks({ transactionId: tx.id, includeDone: true })) summaries.add(`${t.title.slice(0, 80)} - ${who}`);
    for (const o of openHouses) if (o.transaction_id === tx.id) summaries.add(`OPEN HOUSE ${where}`);
  }
  return { summaries: new Set([...summaries].map(x => x.trim().toLowerCase())), names: [...names] };
}
export interface PurgeResult { removed: number; kept: number; ids: string[] }
/** Remove every event this app (or its .ics / browser links) put on Google Calendar, for every file, and forget all links. Nothing the app did not write is touched. */
export function purgeAppCalendarEvents(onStep?: (s: string) => void): Promise<PurgeResult> {
  return singleFlight('calendar-purge', async () => {
    const { summaries, names } = await appSummaries();
    // UTC-DAY-OK: a wide search window only; nothing is keyed on it.
    const window = { timeMin: `${addDays(repo.today(), -400)}T00:00:00Z`, timeMax: `${addDays(repo.today(), 800)}T00:00:00Z` };
    const found = new Map<string, GEvent>();
    onStep?.('Reading the calendar');
    for (const e of await listEvents({ q: APP_MARK, ...window })) found.set(e.id, e);
    for (const who of names) for (const e of await listEvents({ q: who, ...window })) found.set(e.id, e);
    for (const tx of await repo.listTransactions()) for (const e of await listEvents({ privateExtendedProperty: `redesk_tx=${tx.id}` })) found.set(e.id, e);
    const mine = [...found.values()].filter(e => e.status !== 'cancelled' && isAppMadeOrKnown(e, summaries));
    const ids: string[] = [];
    for (const [i, e] of mine.entries()) {
      onStep?.(`Removing ${i + 1}/${mine.length}: ${(e.summary ?? '').slice(0, 40)}`);
      try { await api(`${CAL}/${e.id}`, { method: 'DELETE' }); ids.push(e.id); } catch (err) { if (!/404|410/.test(String(err))) throw err; }
    }
    await repo.clearCalendarLinks();
    const kept = [...found.values()].filter(e => e.status !== 'cancelled').length - mine.length;
    await repo.logEvent('google.calendar.purged', undefined, undefined, { removed: ids.length, kept, ids });
    return { removed: ids.length, kept, ids };
  });
}

/* ---------- calendar audit: what Google really holds for this file ---------- */
/** Pure. Group the app's events by identity (private key, else summary + day) and keep one per group: the linked one, else the oldest. */
export function calendarDuplicates(events: GEvent[], linkedIds: Set<string>): { keep: GEvent[]; remove: GEvent[] } {
  const groups = new Map<string, GEvent[]>();
  for (const e of events) {
    const id = `${(e.summary ?? '').trim().toLowerCase()}|${eventDay(e)}|${e.extendedProperties?.private?.redesk_key ?? ''}`;
    groups.set(id, [...(groups.get(id) ?? []), e]);
  }
  // An untagged copy (older push) with the same summary + day as exactly one tagged group belongs to that group.
  for (const [id, g] of [...groups.entries()]) {
    if (!id.endsWith('|')) continue;
    const tagged = [...groups.keys()].filter(k => k !== id && k.startsWith(id));
    if (tagged.length === 1) { groups.get(tagged[0])!.push(...g); groups.delete(id); }
  }
  const keep: GEvent[] = [], remove: GEvent[] = [];
  for (const g of groups.values()) {
    g.sort((a, b) => Number(linkedIds.has(b.id)) - Number(linkedIds.has(a.id)) || oldestFirst(a, b));
    keep.push(g[0]); remove.push(...g.slice(1));
  }
  return { keep, remove };
}
export interface CalendarAudit { total: number; linked: number; missing: number; duplicates: GEvent[] }
async function appEventsFor(txId: number): Promise<GEvent[]> {
  const tx = await repo.getTransaction(txId); if (!tx) throw new Error('no transaction');
  const who = `${tx.last_name}, ${tx.first_name}`;
  const tagged = await listEvents({ privateExtendedProperty: `redesk_tx=${txId}` });
  // UTC-DAY-OK: a wide search window only; nothing is keyed on it.
  const legacy = (await listEvents({ q: APP_MARK, timeMin: `${addDays(repo.today(), -400)}T00:00:00Z`, timeMax: `${addDays(repo.today(), 800)}T00:00:00Z` })).filter(x => isAppEvent(x) && (x.summary ?? '').includes(who));
  const byId = new Map<string, GEvent>(); for (const e of [...tagged, ...legacy]) byId.set(e.id, e);
  return [...byId.values()].filter(e => e.status !== 'cancelled');
}
/** Read back every event the app made for this file and report duplicates and links whose event is gone. Reads only. */
export async function auditCalendar(txId: number): Promise<CalendarAudit> {
  const events = await appEventsFor(txId);
  const [deadlines, tasks, openHouses, links] = await Promise.all([repo.listDeadlines({ transactionId: txId }), repo.listTasks({ transactionId: txId, includeDone: true }), repo.listOpenHouses({ from: '0000', to: '9999' }), repo.listCalendarLinks()]);
  const refs = new Set([...deadlines.map(d => `deadline:${d.id}`), ...tasks.map(t => `task:${t.id}`), ...openHouses.filter(o => o.transaction_id === txId).map(o => `open_house:${o.id}`)]);
  const mine = links.filter(l => refs.has(`${l.kind}:${l.ref_id}`));
  const linkedIds = new Set(mine.map(l => l.google_event_id));
  const ids = new Set(events.map(e => e.id));
  const { remove } = calendarDuplicates(events, linkedIds);
  return { total: events.length, linked: events.filter(e => linkedIds.has(e.id)).length, missing: mine.filter(l => !ids.has(l.google_event_id)).length, duplicates: remove };
}
/** Delete the duplicate copies found by auditCalendar. Only events the app made are ever deleted, and one copy of each is always kept. */
export function removeCalendarDuplicates(txId: number): Promise<number> {
  return singleFlight(`calendar-dedupe:${txId}`, async () => {
    const a = await auditCalendar(txId);
    let n = 0;
    for (const e of a.duplicates) { if (!isAppEvent(e)) continue; await api(`${CAL}/${e.id}`, { method: 'DELETE' }); n++; }
    await repo.logEvent('google.calendar.duplicates_removed', 'transaction', txId, { removed: n, ids: a.duplicates.map(e => e.id) });
    return n;
  });
}

/* ---------- ICS + template links (work without connecting Google) ---------- */
function icsDate(date: string, time?: string | null): string { return time ? `${date.replace(/-/g, '')}T${time.replace(':', '')}00` : date.replace(/-/g, ''); }
export async function icsForTransaction(txId: number): Promise<string> {
  const tx = await repo.getTransaction(txId); if (!tx) return '';
  const who = `${tx.last_name}, ${tx.first_name}`; const where = tx.street ? `${tx.street}${tx.city ? ', ' + tx.city : ''}` : '';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Salisbury RE Desk//EN', 'CALSCALE:GREGORIAN'];
  for (const d of await repo.listDeadlines({ transactionId: txId })) {
    if (d.status === 'waived') continue;
    lines.push('BEGIN:VEVENT', `UID:deadline-${d.id}@salisbury-re-desk`, `DTSTAMP:${icsDate(repo.today())}T000000Z`, `DTSTART;TZID=${TZ}:${icsDate(d.due_on, d.due_time)}`, `DTEND;TZID=${TZ}:${icsDate(d.due_on, addMinutes(d.due_time, 30))}`, `SUMMARY:${d.label} - ${who} - ${where}`, `DESCRIPTION:${(d.notes ?? '').replace(/\n/g, ' ')}`, 'BEGIN:VALARM', 'TRIGGER:-P1D', 'ACTION:DISPLAY', `DESCRIPTION:${d.label}`, 'END:VALARM', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
/** One-click "add to Google Calendar" link (opens the browser prefilled; Cory clicks Save). */
export function gcalTemplateUrl(summary: string, date: string, time: string | null, details: string): string {
  const start = time ? icsDate(date, time) : icsDate(date); const end = time ? icsDate(date, addMinutes(time, 30)) : icsDate(addDays(date, 1));
  return `https://calendar.google.com/calendar/render?${new URLSearchParams({ action: 'TEMPLATE', text: summary, dates: `${start}/${end}`, details, ctz: TZ })}`;
}

/* ---------- gmail drafts ---------- */
export interface DraftResult { id: string; existing: boolean }
/** Create a Gmail draft once per distinct message: the same to + subject + body returns the draft that already exists (if Gmail still has it). */
export function createGmailDraft(to: string, subject: string, body: string): Promise<DraftResult> {
  return singleFlight(`draft:${to}|${subject}`, async () => {
    const key = hex(await sha256(`${to.trim().toLowerCase()}\n${subject.trim()}\n${body.trim()}`));
    const prior = await repo.getGmailDraft(key);
    if (prior) {
      try { await api(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${prior.draft_id}?format=minimal`); return { id: prior.draft_id, existing: true }; }
      catch (err) { if (!/404/.test(String(err))) throw err; /* the draft was sent or deleted: make a fresh one */ }
    }
    const s = await repo.getSettings();
    const from = s.google_email ? `From: ${s.google_email}\r\n` : '';
    const raw = `${from}To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
    const enc = b64url(new TextEncoder().encode(raw));
    const j = await api('https://gmail.googleapis.com/gmail/v1/users/me/drafts', { method: 'POST', body: JSON.stringify({ message: { raw: enc } }) });
    const id = String(j.id ?? '');
    await repo.setGmailDraft(key, id, to, subject);
    await repo.logEvent('google.gmail.draft', undefined, undefined, { to, subject, reused: false });
    return { id, existing: false };
  });
}
export function gmailDraftUrl(): string { return 'https://mail.google.com/mail/u/0/#drafts'; }

/* ---------- drive (scope drive.file: the app can only see files and folders it created) ---------- */
const DRIVE = 'https://www.googleapis.com/drive/v3';
function qEsc(v: string): string { return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
function mimeFor(name: string): string {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  return ({ pdf: 'application/pdf', zip: 'application/zip', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', txt: 'text/plain', md: 'text/markdown', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword', csv: 'text/csv', ics: 'text/calendar' } as Record<string, string>)[ext] ?? 'application/octet-stream';
}
async function driveFolder(name: string, parentId?: string): Promise<string> {
  const q = `name='${qEsc(name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentId ? ` and '${parentId}' in parents` : ''}`;
  const found = await api(`${DRIVE}/files?${new URLSearchParams({ q, fields: 'files(id)', pageSize: '1' })}`);
  const hit = ((found.files as Array<{ id: string }> | undefined) ?? [])[0];
  if (hit) return hit.id;
  const made = await api(`${DRIVE}/files?fields=id`, { method: 'POST', body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: parentId ? [parentId] : undefined }) });
  return String(made.id);
}
interface DriveHit { id: string; webViewLink?: string; sha256Checksum?: string; createdTime?: string }
/** Upload one local file into Drive > Salisbury RE Desk > <client folder name>. Same bytes already there (by local record or by asking Drive) = nothing uploaded; changed bytes = a new version of the same Drive file, never a second file. */
export function uploadToDrive(localPath: string, clientFolderName: string, onStep?: (s: string) => void): Promise<repo.DriveFileRow> {
  return singleFlight(`drive:${localPath}`, async () => {
    const [sha] = await native.sha256File(localPath);
    let target = await repo.getDriveFile(localPath);
    if (target && target.sha256 === sha) return target;
    onStep?.('Drive folder');
    const root = await driveFolder('Salisbury RE Desk');
    const folder = await driveFolder(clientFolderName, root);
    const name = localPath.split(/[\\/]/).pop() ?? 'file';
    if (!target) {
      // No local record: ask Drive for a file of this name in this folder before creating one (only files this app made are visible to it).
      const j = await api(`${DRIVE}/files?${new URLSearchParams({ q: `name='${qEsc(name)}' and '${folder}' in parents and trashed=false`, fields: 'files(id,webViewLink,sha256Checksum,createdTime)', pageSize: '10' })}`);
      const hit = (((j.files as DriveHit[] | undefined) ?? []).sort((a, b) => (a.createdTime ?? '').localeCompare(b.createdTime ?? '')))[0];
      if (hit) {
        target = { path: localPath, sha256: hit.sha256Checksum ?? '', google_file_id: hit.id, web_view_link: hit.webViewLink ?? '', folder_id: folder, shared: [] };
        if (target.sha256 === sha) { await repo.setDriveFile(target); await repo.logEvent('google.drive.relinked', undefined, undefined, { path: localPath, id: hit.id }); return target; }
      }
    }
    onStep?.(`Uploading ${name}`);
    const bytes = await readFile(localPath);
    const boundary = 'redesk_' + b64url(crypto.getRandomValues(new Uint8Array(12)));
    const meta = target ? { name } : { name, parents: [folder] };
    const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mimeFor(name)}\r\n\r\n`, bytes, `\r\n--${boundary}--`]);
    const url = target ? `https://www.googleapis.com/upload/drive/v3/files/${target.google_file_id}?uploadType=multipart&fields=id,webViewLink` : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink';
    const j = await api(url, { method: target ? 'PATCH' : 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body });
    const row: repo.DriveFileRow = { path: localPath, sha256: sha, google_file_id: String(j.id), web_view_link: String(j.webViewLink ?? target?.web_view_link ?? ''), folder_id: folder, shared: target?.shared ?? [] };
    await repo.setDriveFile(row);
    await repo.logEvent('google.drive.uploaded', undefined, undefined, { path: localPath, id: row.google_file_id, sha256: sha, version: target ? 'new version' : 'new file' });
    return row;
  });
}
/** Share a Drive file with one person (reader by default, no notification email unless asked) or with anyone who has the link. Asks Drive first; an existing permission is never duplicated. */
export function shareDriveFile(file: repo.DriveFileRow, opts: { email?: string; role?: 'reader' | 'writer'; notify?: boolean }): Promise<repo.DriveFileRow> {
  const who = opts.email?.trim();
  return singleFlight(`share:${file.google_file_id}:${who ?? 'anyone'}`, async () => {
    const cur = await api(`${DRIVE}/files/${file.google_file_id}/permissions?fields=permissions(type,role,emailAddress)`);
    const perms = (cur.permissions as Array<{ type: string; role: string; emailAddress?: string }> | undefined) ?? [];
    const already = who ? perms.some(x => x.type === 'user' && (x.emailAddress ?? '').toLowerCase() === who.toLowerCase()) : perms.some(x => x.type === 'anyone');
    if (!already) {
      const perm = who ? { type: 'user', role: opts.role ?? 'reader', emailAddress: who } : { type: 'anyone', role: 'reader' };
      await api(`${DRIVE}/files/${file.google_file_id}/permissions?${new URLSearchParams({ sendNotificationEmail: String(!!(who && opts.notify)), fields: 'id' })}`, { method: 'POST', body: JSON.stringify(perm) });
    }
    const row = { ...file, shared: Array.from(new Set([...file.shared, who ?? 'anyone with the link'])) };
    await repo.setDriveFile(row);
    await repo.logEvent('google.drive.shared', undefined, undefined, { id: file.google_file_id, with: who ?? 'anyone with the link', role: opts.role ?? 'reader', reused: already });
    return row;
  });
}

/* ---------- google contacts (People API) ---------- */
const PEOPLE = 'https://people.googleapis.com/v1';
const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,addresses,biographies,clientData';
/** "123 Main St, Lehi, UT 84043" -> parts. Anything that does not fit the pattern goes whole into streetAddress. */
export function splitAddress(a: string): { streetAddress: string; city?: string; region?: string; postalCode?: string } {
  const parts = a.split(',').map(x => x.trim()).filter(Boolean);
  if (parts.length < 2) return { streetAddress: a.trim() };
  const m = /^([A-Za-z ]{2,})?\s*(\d{5}(?:-\d{4})?)?$/.exec(parts[parts.length - 1] ?? '');
  if (parts.length >= 3 && m) return { streetAddress: parts.slice(0, -2).join(', '), city: parts[parts.length - 2], region: m[1]?.trim() || undefined, postalCode: m[2] || undefined };
  return { streetAddress: parts[0], city: parts.slice(1).join(', ') };
}
function personBody(c: repo.Client) {
  const second = c.second_first_name ? ` (with ${c.second_first_name} ${c.second_last_name ?? c.last_name})` : '';
  return {
    names: [{ givenName: c.first_name, familyName: c.last_name }],
    emailAddresses: [c.email, c.email2].filter((v): v is string => !!v).map(value => ({ value, type: 'home' })),
    phoneNumbers: [c.phone, c.phone2].filter((v): v is string => !!v).map(value => ({ value, type: 'mobile' })),
    addresses: c.mailing_address ? [{ ...splitAddress(c.mailing_address), type: 'home' }] : [],
    biographies: [{ value: `Salisbury RE Desk client${second}${c.source ? ` · source: ${c.source}` : ''}`, contentType: 'TEXT_PLAIN' }],
    clientData: [{ key: 'redesk_client_id', value: String(c.id) }],
  };
}
function digits(v: string): string { return v.replace(/\D/g, '').slice(-10); }
interface GPerson { resourceName: string; names?: Array<{ givenName?: string; familyName?: string }>; emailAddresses?: Array<{ value: string }>; phoneNumbers?: Array<{ value: string }>; clientData?: Array<{ key: string; value: string }> }
/** Pure. The Google contact that is this client: tagged with the client id, or sharing an email or phone. A bare name match is only trusted when the found contact has no email or phone of its own. */
export function matchContact(c: { id: number; first_name: string; last_name: string; email: string | null; phone: string | null }, people: GPerson[]): GPerson | null {
  const tagged = people.find(pp => pp.clientData?.some(d => d.key === 'redesk_client_id' && d.value === String(c.id)));
  if (tagged) return tagged;
  const byEmail = c.email ? people.find(pp => pp.emailAddresses?.some(e => e.value.toLowerCase() === c.email!.toLowerCase())) : null;
  if (byEmail) return byEmail;
  const byPhone = c.phone ? people.find(pp => pp.phoneNumbers?.some(x => digits(x.value) === digits(c.phone!))) : null;
  if (byPhone) return byPhone;
  const sameName = people.filter(pp => pp.names?.some(n => (n.givenName ?? '').trim().toLowerCase() === c.first_name.trim().toLowerCase() && (n.familyName ?? '').trim().toLowerCase() === c.last_name.trim().toLowerCase()));
  return sameName.find(pp => !(pp.emailAddresses?.length) && !(pp.phoneNumbers?.length)) ?? null;
}
async function findGoogleContact(c: repo.Client): Promise<string | null> {
  const readMask = 'names,emailAddresses,phoneNumbers,clientData';
  try { await api(`${PEOPLE}/people:searchContacts?${new URLSearchParams({ query: '', readMask })}`); } catch { /* warm-up request; Google asks for it before a real search */ }
  const found = new Map<string, GPerson>();
  for (const q of [c.email, c.phone, `${c.first_name} ${c.last_name}`].filter((v): v is string => !!v)) {
    const j = await api(`${PEOPLE}/people:searchContacts?${new URLSearchParams({ query: q, readMask, pageSize: '10' })}`);
    for (const r of (j.results as Array<{ person: GPerson }> | undefined) ?? []) found.set(r.person.resourceName, r.person);
  }
  return matchContact(c, [...found.values()])?.resourceName ?? null;
}

/** Create or update the Google Contact for a client. Idempotent: an unchanged client is not re-sent, and without a local record the app searches Google Contacts before creating one. */
export function saveGoogleContact(clientId: number): Promise<'created' | 'updated' | 'unchanged' | 'relinked'> {
  return singleFlight(`contact:${clientId}`, async () => {
    const c = await repo.getClient(clientId); if (!c) throw new Error('client not found');
    const body = personBody(c); const fp = JSON.stringify(body);
    let link = await repo.getGoogleContact(clientId);
    if (link && link.fingerprint === fp) return 'unchanged';
    let relinked = false;
    if (!link) {
      const existing = await findGoogleContact(c);
      if (existing) { await repo.setGoogleContact(clientId, existing, ''); link = await repo.getGoogleContact(clientId); relinked = true; }
    }
    if (link) {
      try {
        const cur = await api(`${PEOPLE}/${link.resource_name}?personFields=${PERSON_FIELDS}`);
        const j = await api(`${PEOPLE}/${link.resource_name}:updateContact?updatePersonFields=${PERSON_FIELDS}`, { method: 'PATCH', body: JSON.stringify({ ...body, etag: cur.etag }) });
        await repo.setGoogleContact(clientId, String(j.resourceName ?? link.resource_name), fp);
        await repo.logEvent(relinked ? 'google.contact.relinked' : 'google.contact.updated', 'client', clientId);
        return relinked ? 'relinked' : 'updated';
      } catch (err) { if (!/404/.test(String(err))) throw err; }
    }
    const j = await api(`${PEOPLE}/people:createContact?personFields=${PERSON_FIELDS}`, { method: 'POST', body: JSON.stringify(body) });
    await repo.setGoogleContact(clientId, String(j.resourceName), fp);
    await repo.logEvent('google.contact.created', 'client', clientId);
    return 'created';
  });
}
