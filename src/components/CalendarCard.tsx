import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-shell';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { connectGoogle, googleStatus, pushTransactionToCalendar, auditCalendar, removeCalendarDuplicates, icsForTransaction, gcalTemplateUrl, type GoogleStatus, type CalendarAudit } from '../lib/google';
import { getSettings, setSetting, listDeadlines, getClient, getTransaction } from '../lib/repo';
import { friendlyError } from '../lib/errors';

/**
 * Permission-first calendar sync. Nothing touches Google until Cory says yes here; the first yes also goes through
 * Google's own consent screen. Mode: ask (every time) | always (auto after intake) | never.
 */
export default function CalendarCard({ txId }: { txId: number }) {
  const [st, setSt] = useState<GoogleStatus | null>(null);
  const [mode, setMode] = useState<'ask' | 'always' | 'never'>('ask');
  const [scope, setScope] = useState('deadlines');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState(0);
  const [audit, setAudit] = useState<CalendarAudit | null>(null);
  async function load() { setSt(await googleStatus()); const s = await getSettings(); setMode((s.google_calendar_auto_push as 'ask' | 'always' | 'never') || 'ask'); setScope(s.google_calendar_scope || 'deadlines'); setCount((await listDeadlines({ transactionId: txId })).filter(d => d.status === 'pending').length); }
  useEffect(() => { load().catch(() => {}); }, [txId]);

  async function connect() { setBusy(true); setMsg('Opening Google in your browser. Approve Salisbury RE Desk there, then come back.'); try { setSt(await connectGoogle(setMsg)); setMsg('Connected.'); } catch (e) { setMsg(friendlyError(e)); } finally { setBusy(false); } }
  async function push() { if (busy) return; setBusy(true); setAudit(null); try { const r = await pushTransactionToCalendar(txId, setMsg); setMsg(`Google Calendar: ${r.created} created, ${r.updated} updated, ${r.unchanged} already there${r.relinked ? `, ${r.relinked} found in Google and linked instead of re-created` : ''}${r.removed ? `, ${r.removed} removed because Settings keeps the calendar to ${scope === 'deadlines' ? 'deadlines only' : scope === 'deadlines_open_houses' ? 'deadlines and open houses' : 'the chosen kinds'}` : ''}.`); } catch (e) { setMsg(friendlyError(e)); } finally { setBusy(false); } }
  async function check() { if (busy) return; setBusy(true); setMsg('Reading this file\u2019s events back from Google\u2026'); try { const a = await auditCalendar(txId); setAudit(a); setMsg(`Google holds ${a.total} event(s) for this file: ${a.linked} linked to the app${a.missing ? `, ${a.missing} link(s) point at an event that is gone (a push will recreate them)` : ''}${a.duplicates.length ? `, ${a.duplicates.length} duplicate cop${a.duplicates.length === 1 ? 'y' : 'ies'}` : ', no duplicates'}.`); } catch (e) { setMsg(friendlyError(e)); } finally { setBusy(false); } }
  async function dedupe() { if (busy || !audit?.duplicates.length) return; setBusy(true); try { const n = await removeCalendarDuplicates(txId); setMsg(`Removed ${n} duplicate cop${n === 1 ? 'y' : 'ies'} the app had made. One copy of each event is kept.`); setAudit(null); } catch (e) { setMsg(friendlyError(e)); } finally { setBusy(false); } }
  async function ics() {
    const tx = await getTransaction(txId); const c = tx ? await getClient(tx.client_id) : null;
    if (!tx || !c?.folder_path) return;
    const path = `${c.folder_path}\\05 Title & Closing\\deadlines.ics`;
    await writeTextFile(path, await icsForTransaction(txId)); setMsg(`Saved ${path}. Double-click it to import into any calendar.`);
  }
  async function openFirstTemplate() {
    const tx = await getTransaction(txId); const ds = (await listDeadlines({ transactionId: txId })).filter(d => d.status === 'pending');
    if (!tx || !ds.length) return;
    const d = ds[0]; await open(gcalTemplateUrl(`${d.label} - ${tx.last_name}, ${tx.first_name}`, d.due_on, d.due_time, d.notes ?? 'Salisbury RE Desk'));
  }
  if (!st) return null;
  return (
    <div className="rounded-lg border border-ink/10 bg-white p-3 text-xs space-y-2">
      <div className="flex items-center justify-between"><div className="font-medium text-sm">Google Calendar</div><span className={st.connected ? 'text-emerald-700' : 'text-ink/50'}>{st.connected ? `connected${st.email ? ' as ' + st.email : ''}` : st.configured ? 'not connected' : 'not set up'}</span></div>
      {!st.configured && <div className="text-ink/60">Paste your Google OAuth client id and secret in Settings first (one-time, 5 minutes).</div>}
      {st.configured && !st.connected && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-amber-900">
          <div className="font-medium">May this app add this file's {count} deadline(s) and key tasks to your Google Calendar?</div>
          <div className="mt-1">It will only create and update events it made itself, on your primary calendar. You approve it once in your browser; you can disconnect any time in Settings.</div>
          <div className="mt-2 flex gap-2"><button onClick={connect} disabled={busy} className="rounded bg-brand px-3 py-1 text-white disabled:opacity-50">Yes, connect Google</button><button onClick={() => setMsg('Okay. Use the .ics file or the one-click links below instead.')} className="rounded border border-ink/15 px-3 py-1">Not now</button></div>
        </div>
      )}
      {st.connected && (
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={push} disabled={busy} className="rounded bg-brand px-3 py-1 text-white disabled:opacity-50">{busy ? 'Working…' : `Push ${count} deadline(s)${scope === 'all' ? ' + open houses + key tasks' : scope === 'deadlines_open_houses' ? ' + open houses' : ''}`}</button>
          <button onClick={check} disabled={busy} className="rounded border border-ink/15 px-2 py-1 disabled:opacity-50" title="Read this file's events back from Google and report duplicates">Check Google</button>
          {audit && audit.duplicates.length > 0 && <button onClick={dedupe} disabled={busy} className="rounded border border-red-200 bg-red-50 px-2 py-1 text-red-800 disabled:opacity-50" title="Deletes only extra copies the app made; one copy of each event stays">Remove {audit.duplicates.length} duplicate(s)</button>}
          <label className="text-ink/60">after intake:
            <select value={mode} onChange={async e => { const v = e.target.value as 'ask' | 'always' | 'never'; setMode(v); await setSetting('google_calendar_auto_push', v); }} className="ml-1 rounded border border-ink/15 px-1 py-0.5"><option value="ask">ask me</option><option value="always">always push</option><option value="never">never</option></select>
          </label>
        </div>
      )}
      <div className="flex flex-wrap gap-2 text-ink/60">
        <button onClick={ics} className="rounded border border-ink/15 px-2 py-0.5">Save .ics file (works with any calendar)</button>
        <button onClick={openFirstTemplate} className="rounded border border-ink/15 px-2 py-0.5">Add the next deadline in the browser</button>
      </div>
      {msg && <div className="text-ink/70">{msg}</div>}
    </div>
  );
}
