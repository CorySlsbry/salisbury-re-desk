import { useEffect, useState } from 'react';
import { db } from '../lib/native';
import type { BootState } from '../lib/boot';
import { MODELS, modelPresent, downloadModel, type ModelSpec } from '../lib/models';
import { setSetting } from '../lib/repo';
import { open } from '@tauri-apps/plugin-shell';
import { connectGoogle, disconnectGoogle, googleStatus, setClientSecret, importClientJson, purgeAppCalendarEvents, GOOGLE_PERMISSIONS, CALENDAR_SCOPES, type GoogleStatus } from '../lib/google';
import { open as openDialog, confirm as confirmDialog } from '@tauri-apps/plugin-dialog';
import { JOBS, DEFAULT_ROUTE, claudeProbe, type AiJob, type ModelChoice } from '../lib/providers';
import { crmStatus, crmSignIn, crmSignOut, syncAll, CRM_DEFAULT_URL, type CrmStatus } from '../lib/crm';
import { friendlyError } from '../lib/errors';

export default function Settings({ boot }: { boot: BootState }) {
  const [rows, setRows] = useState<{ key: string; value: string }[]>([]);
  const [present, setPresent] = useState<Record<string, boolean>>({});
  const [prog, setProg] = useState<Record<string, string>>({});
  useEffect(() => { (async () => { const m: Record<string, boolean> = {}; for (const x of MODELS) m[x.id] = await modelPresent(x); setPresent(m); })().catch(() => {}); }, [boot.ready, prog]);
  async function fetchModel(m: ModelSpec) {
    setProg(p => ({ ...p, [m.id]: 'starting' }));
    try { await downloadModel(m, (d, t) => setProg(p => ({ ...p, [m.id]: t ? `${(d / 2 ** 30).toFixed(2)} / ${(t / 2 ** 30).toFixed(2)} GB` : `${(d / 2 ** 30).toFixed(2)} GB` }))); setProg(p => ({ ...p, [m.id]: 'done; restart the app to load it' })); }
    catch (e) { setProg(p => ({ ...p, [m.id]: `failed: ${String(e)}` })); }
  }
  useEffect(() => { db().then(d => d.select<{ key: string; value: string }[]>('SELECT key, value FROM settings ORDER BY key')).then(setRows).catch(() => {}); }, [boot.ready]);
  const eng = Object.fromEntries(rows.filter(r => r.key.startsWith('engine_') || r.key.startsWith('google_') || r.key.startsWith('bitlocker_') || r.key.startsWith('ai_') || r.key.startsWith('crm_') || r.key === 'agent_confidence_min' || r.key === 'geocoder').map(r => [r.key, r.value]));
  const [gs, setGs] = useState<GoogleStatus | null>(null);
  const [aiMsg, setAiMsg] = useState('');
  const [cs, setCs] = useState<CrmStatus | null>(null);
  const [crmEmail, setCrmEmail] = useState('');
  const [crmPw, setCrmPw] = useState('');
  const [crmMsg, setCrmMsg] = useState('');
  const [crmBusy, setCrmBusy] = useState(false);
  useEffect(() => { crmStatus().then(c => { setCs(c); if (c.email) setCrmEmail(c.email); }).catch(() => {}); }, [rows]);
  const [gmsg, setGmsg] = useState('');
  const [secretDraft, setSecretDraft] = useState('');
  useEffect(() => { googleStatus().then(setGs).catch(() => {}); }, [rows]);
  async function saveEng(key: string, value: string) { await setSetting(key, value); setRows(rows.some(r => r.key === key) ? rows.map(r => r.key === key ? { ...r, value } : r) : [...rows, { key, value }]); }
  return (
    <div className="p-8 max-w-3xl">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <p className="mt-1 text-sm text-ink/60">Brokerage identity used on every document and draft.</p>
      <table className="mt-6 w-full text-sm">
        <tbody>
          {rows.filter(r => !r.key.startsWith('engine_') && !r.key.startsWith('google_') && !r.key.startsWith('bitlocker_') && !r.key.startsWith('ai_') && !r.key.startsWith('crm_') && r.key !== 'agent_confidence_min' && r.key !== 'geocoder').map(r => (
            <tr key={r.key} className="border-b border-ink/10">
              <td className="py-2 pr-4 font-medium text-ink/70 w-56">{r.key}</td>
              <td className="py-2">{r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {eng.bitlocker_status !== 'on' && (
        <div className={`mt-6 rounded-lg border p-4 text-sm ${eng.bitlocker_status === 'off' ? 'border-red-300 bg-red-50 text-red-900' : 'border-amber-300 bg-amber-50 text-amber-900'}`}>
          <div className="font-medium">{eng.bitlocker_status === 'off' ? 'Disk encryption is OFF' : 'Disk encryption: not confirmed'}</div>
          <div className="mt-1 text-xs">Client names, contacts and signed contracts live on this drive. {eng.bitlocker_status === 'off' ? 'Turn on Device encryption (Windows Settings > Privacy & security > Device encryption) or BitLocker.' : 'Windows would not report BitLocker status to a standard user. Open Windows Settings > Privacy & security > Device encryption and confirm it is on.'}{eng.bitlocker_checked_at ? ` Last checked ${eng.bitlocker_checked_at}.` : ''}</div>
          <button onClick={() => open('ms-settings:deviceencryption')} className="mt-2 rounded border border-current px-3 py-1 text-xs">Open Windows Device encryption</button>
        </div>
      )}
      <div className="mt-8 rounded-lg border border-ink/10 bg-white p-4 text-sm">
        <div className="font-medium">Accuracy bar</div>
        <div className="mt-1 text-xs text-ink/60">Any value read off a contract below this confidence must be looked at on the page crop before the file can be built. The model's own suggestions are always below it.</div>
        <label className="mt-2 flex items-center gap-2 text-xs text-ink/60">Minimum confidence <input type="number" min={0.5} max={1} step={0.01} value={eng.agent_confidence_min ?? '0.95'} onChange={e => saveEng('agent_confidence_min', e.target.value)} className="w-24 rounded-md border border-ink/15 px-2 py-1 text-sm" /> (0.95 = 95%)</label>
      </div>
      <div className="mt-8 rounded-lg border border-ink/10 bg-white p-4 text-sm">
        <div className="font-medium">Daily Engine</div>
        <div className="mt-1 text-xs text-ink/60">Pat's numbers, yours to change. The morning block is when the 11 non-negotiables happen; the reset day shows nothing but the reset.</div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="text-xs text-ink/60">Morning block starts<input type="time" value={eng.engine_morning_start ?? '05:00'} onChange={e => saveEng('engine_morning_start', e.target.value)} className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm" /></label>
          <label className="text-xs text-ink/60">Morning block ends<input type="time" value={eng.engine_morning_end ?? '06:30'} onChange={e => saveEng('engine_morning_end', e.target.value)} className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm" /></label>
          <label className="text-xs text-ink/60">Reset day (no work)<select value={eng.engine_reset_day ?? 'sunday'} onChange={e => saveEng('engine_reset_day', e.target.value)} className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm">{['sunday', 'saturday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map(d => <option key={d} value={d}>{d}</option>)}</select></label>
          <label className="text-xs text-ink/60">Open-house day<select value={eng.engine_open_house_day ?? 'saturday'} onChange={e => saveEng('engine_open_house_day', e.target.value)} className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm"><option value="saturday">Saturday (Pat's default)</option><option value="sunday">Sunday (if it outperforms in your market)</option></select></label>
          <label className="text-xs text-ink/60 col-span-2 flex items-center gap-2"><input type="checkbox" checked={eng.engine_launch_phase === '1'} onChange={e => saveEng('engine_launch_phase', e.target.checked ? '1' : '0')} />Launch phase: 10 posts every day (hourly alarm) instead of 3 sustaining. Friday is 10 either way.</label>
        </div>
      </div>
      <div className="mt-8 rounded-lg border border-ink/10 bg-white p-4 text-sm">
        <div className="font-medium">Google Calendar, Gmail, Drive and Contacts</div>
        <div className="mt-1 text-xs text-ink/60">The app never touches Google until you connect it here or say yes on a client page. One connection covers all four, each limited to what is listed. Disconnect any time; Google also lets you revoke it at myaccount.google.com/permissions.</div>
        <ul className="mt-2 space-y-0.5 text-xs text-ink/70">
          {GOOGLE_PERMISSIONS.map(p => <li key={p.scope}><b>{p.name}:</b> {p.does}</li>)}
        </ul>
        {!gs?.configured && (
          <ol className="mt-2 list-decimal pl-5 text-xs text-ink/70 space-y-0.5">
            <li>Open <button onClick={() => open('https://console.cloud.google.com/auth/clients?project=salisbury-re-desk')} className="text-brand underline">console.cloud.google.com/auth/clients</button> in your Google account. The project <b>Salisbury RE Desk</b> already has the Calendar, Gmail, Drive and People APIs enabled.</li>
            <li>Open the OAuth client named <b>Salisbury RE Desk</b> (type Desktop app) and click <b>Download JSON</b>. If it does not exist yet: Create client, Desktop app, name it Salisbury RE Desk.</li>
            <li>Click <b>Import credentials JSON</b> below and pick the downloaded client_secret_….json. Or paste the id and secret by hand.</li>
            <li>Click <b>Ask permission and connect Google</b>. Google shows an "unverified app" notice because this is your own private app: click Advanced, then Go to Salisbury RE Desk.</li>
          </ol>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <button onClick={async () => { try { const picked = await openDialog({ multiple: false, filters: [{ name: 'Google client JSON', extensions: ['json'] }] }); if (!picked) return; const id = await importClientJson(picked as string); await saveEng('google_client_id', id); setGs(await googleStatus()); setGmsg('Client imported. The secret is stored encrypted for your Windows account. Now click Ask permission and connect Google.'); } catch (e) { setGmsg(friendlyError(e)); } }} className="rounded-md border border-ink/15 bg-white px-3 py-1">Import credentials JSON…</button>
          <span className="text-ink/50">or paste the two values:</span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="text-xs text-ink/60">OAuth client id<input value={eng.google_client_id ?? ''} onChange={e => saveEng('google_client_id', e.target.value.trim())} placeholder="xxxx.apps.googleusercontent.com" className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm" /></label>
          <label className="text-xs text-ink/60">OAuth client secret <span className="text-ink/40">(stored encrypted for your Windows account, never in the synced database)</span><input type="password" value={secretDraft} onChange={e => setSecretDraft(e.target.value)} onBlur={async () => { if (secretDraft) { await setClientSecret(secretDraft); setSecretDraft(''); setGs(await googleStatus()); setGmsg('Client secret saved (encrypted).'); } }} placeholder={gs?.configured ? '•••••••• saved' : 'paste, then click away'} className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm" /></label>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="text-xs text-ink/60">Pat's email <span className="text-ink/40">(Complete File is shared view-only with this address)</span><input value={eng.google_broker_email ?? ''} onChange={e => saveEng('google_broker_email', e.target.value.trim())} placeholder="person1@example.com" className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm" /></label>
        </div>
        {gs?.connected && gs.missing.length > 0 && <div className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900">Google was connected before {gs.missing.join(' and ')} {gs.missing.length > 1 ? 'were' : 'was'} added. Click Disconnect, then connect again to grant {gs.missing.length > 1 ? 'them' : 'it'}.</div>}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          {gs?.connected ? <><span className="text-emerald-700">Connected{gs.email ? ` as ${gs.email}` : ''}</span><button onClick={async () => { await disconnectGoogle(); setGs(await googleStatus()); }} className="rounded border border-ink/15 px-3 py-1">Disconnect</button></>
            : <button onClick={async () => { setGmsg('Approve Salisbury RE Desk in the browser tab that just opened…'); try { setGs(await connectGoogle(setGmsg)); setGmsg('Connected.'); } catch (e) { setGmsg(friendlyError(e)); } }} disabled={!gs?.configured} className="rounded bg-brand px-3 py-1 text-white disabled:opacity-50">Ask permission and connect Google</button>}
          <label className="text-ink/60">After intake:
            <select value={eng.google_calendar_auto_push ?? 'ask'} onChange={e => saveEng('google_calendar_auto_push', e.target.value)} className="ml-1 rounded border border-ink/15 px-1 py-0.5"><option value="ask">ask me on the client page</option><option value="always">always push deadlines</option><option value="never">never</option></select>
          </label>
          <label className="text-ink/60" title="Widening this adds events on the next push; narrowing it removes the app's own events of the dropped kinds automatically.">Calendar gets:
            <select value={eng.google_calendar_scope ?? 'deadlines'} onChange={e => saveEng('google_calendar_scope', e.target.value)} className="ml-1 rounded border border-ink/15 px-1 py-0.5">{CALENDAR_SCOPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
        </div>
        {gs?.connected && <div className="mt-3 text-xs"><button onClick={async () => { if (!(await confirmDialog('Remove every event this app has put on your Google Calendar, for every client file? Events you made yourself are not touched. Pushing a file again recreates its deadlines.', { title: 'Clean the calendar', kind: 'warning', okLabel: 'Remove them' }))) return; setGmsg('Cleaning the calendar…'); try { const r = await purgeAppCalendarEvents(setGmsg); setGmsg(`Removed ${r.removed} event(s) the app had made. ${r.kept} other event(s) that mention a client were left alone.`); } catch (e) { setGmsg(friendlyError(e)); } }} className="rounded border border-red-200 bg-red-50 px-3 py-1 text-red-800">Remove every event this app made from Google Calendar…</button></div>}
        {gmsg && <div className="mt-2 text-xs text-ink/70">{gmsg}</div>}
      </div>
      <div className="mt-8 rounded-lg border border-ink/10 bg-white p-4 text-sm">
        <div className="font-medium">AI: which model answers which job</div>
        <div className="mt-1 text-xs text-ink/60">Local = the Qwen model on this laptop (nothing leaves the machine). Claude = Claude Code's headless mode on your own Claude subscription: no API key, no per-token bill, counts against your plan's usage. Haiku is fast and cheap for structured reads; Sonnet is better at writing and reasoning. The programmed agents, the Monitor's grounding check and the 95% loop apply either way.</div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-1"><input type="radio" name="ai_provider" checked={(eng.ai_provider ?? 'local') === 'local'} onChange={() => saveEng('ai_provider', 'local')} />Local model only</label>
          <label className="flex items-center gap-1"><input type="radio" name="ai_provider" checked={eng.ai_provider === 'claude'} onChange={() => saveEng('ai_provider', 'claude')} />Claude on my subscription (per-job choice below)</label>
          <label className="flex items-center gap-1 text-ink/60"><input type="checkbox" checked={(eng.ai_fallback_local ?? 'on') !== 'off'} onChange={e => saveEng('ai_fallback_local', e.target.checked ? 'on' : 'off')} />fall back to the local model when Claude is unavailable</label>
          <button onClick={async () => { setAiMsg('Testing…'); const r = await claudeProbe(); setAiMsg(r.message); }} className="rounded border border-ink/15 px-2 py-1">Test Claude connection</button>
        </div>
        {eng.ai_provider === 'claude' && (
          <table className="mt-3 w-full text-xs"><tbody>
            {JOBS.map(j => (
              <tr key={j.key} className="border-t border-ink/5">
                <td className="py-1 pr-2 font-medium">{j.label}</td><td className="py-1 pr-2 text-ink/50">{j.what}</td>
                <td className="py-1"><select value={(eng[`ai_model_${j.key}`] as ModelChoice) ?? DEFAULT_ROUTE[j.key as AiJob]} onChange={e => saveEng(`ai_model_${j.key}`, e.target.value)} className="rounded border border-ink/15 px-1 py-0.5"><option value="local">Local Qwen</option><option value="haiku">Claude Haiku 4.5</option><option value="sonnet">Claude Sonnet 5</option></select></td>
              </tr>
            ))}
          </tbody></table>
        )}
        <div className="mt-2 text-xs text-ink/50">Sign in once: open a terminal, run <code>claude</code>, and log in with your Claude account. What leaves the laptop with Claude on: the text of the job (a contract page for extraction, a briefing for a draft). Set claude.ai → Settings → Privacy → "Help improve Claude" to off so client text is not used for training.</div>
        {aiMsg && <div className="mt-2 text-xs text-ink/70">{aiMsg}</div>}
      </div>
      <div className="mt-8 rounded-lg border border-ink/10 bg-white p-4 text-sm">
        <div className="font-medium">salisburyre.com CRM</div>
        <div className="mt-1 text-xs text-ink/60">Your website's CRM (the Supabase project behind salisburyre.com). The app signs in as your own CRM user, pulls website leads and contacts into an inbox on the Clients page, and pushes your clients, listings, contract deadlines and showings so the website dashboard shows the live pipeline. Nothing is deleted on either side. Tokens are stored encrypted; the password is never kept.</div>
        {cs && !cs.connected && (
          <div className="mt-3 flex flex-wrap items-end gap-2 text-xs">
            <label className="text-ink/60">CRM login email<input value={crmEmail} onChange={e => setCrmEmail(e.target.value)} className="mt-1 block w-64 rounded-md border border-ink/15 px-2 py-1.5 text-sm" placeholder="you@salisburyre.com" /></label>
            <label className="text-ink/60">Password<input type="password" value={crmPw} onChange={e => setCrmPw(e.target.value)} className="mt-1 block w-56 rounded-md border border-ink/15 px-2 py-1.5 text-sm" placeholder="used once, never stored" /></label>
            <button disabled={crmBusy || !crmEmail || !crmPw} onClick={async () => { setCrmBusy(true); setCrmMsg('Signing in…'); try { setCs(await crmSignIn(crmEmail, crmPw)); setCrmPw(''); setCrmMsg('Connected. The first sync runs now.'); const r = await syncAll(setCrmMsg); setCs(await crmStatus()); setCrmMsg(`Synced: ${r.pulled.fresh} new lead(s)/contact(s) pulled, ${r.clients.created} contact(s) created, ${r.clients.updated} updated, ${r.tx.deals} deal(s), ${r.tx.milestones} milestone(s), ${r.tx.showings} showing(s) pushed.`); } catch (e) { setCrmMsg(friendlyError(e)); } finally { setCrmBusy(false); } }} className="rounded bg-brand px-3 py-1.5 text-white disabled:opacity-50">Sign in and sync</button>
            <span className="text-ink/40">{CRM_DEFAULT_URL.replace('https://', '')}</span>
          </div>
        )}
        {cs?.connected && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-emerald-700">Connected as {cs.email}</span>
            <span className="text-ink/50">{cs.lastSync ? `last sync ${cs.lastSync.slice(0, 16).replace('T', ' ')}` : 'not synced yet'} · inbox: {cs.inbox.new} new</span>
            <label className="text-ink/60">sync <select value={eng.crm_sync_mode ?? 'auto'} onChange={e => saveEng('crm_sync_mode', e.target.value)} className="ml-1 rounded border border-ink/15 px-1 py-0.5"><option value="auto">automatically (boot + every 15 min)</option><option value="manual">only when I click</option><option value="off">off</option></select></label>
            <button disabled={crmBusy} onClick={async () => { setCrmBusy(true); setCrmMsg('Syncing…'); try { const r = await syncAll(setCrmMsg); setCs(await crmStatus()); setCrmMsg(`Synced: ${r.pulled.fresh} new pulled, ${r.clients.created} created, ${r.clients.updated} updated, ${r.clients.unchanged} unchanged; ${r.tx.deals} deal(s), ${r.tx.milestones} milestone(s), ${r.tx.showings} showing(s).`); } catch (e) { setCrmMsg(friendlyError(e)); } finally { setCrmBusy(false); } }} className="rounded border border-ink/15 px-3 py-1 disabled:opacity-50">Sync now</button>
            <button onClick={async () => { await crmSignOut(); setCs(await crmStatus()); setCrmMsg('Disconnected.'); }} className="rounded border border-ink/15 px-3 py-1">Disconnect</button>
            <button onClick={() => open('https://salisburyre.com/admin')} className="rounded border border-ink/15 px-3 py-1" title="Workflows, email templates and CRM tasks still live on the web dashboard">Open web dashboard</button>
          </div>
        )}
        <div className="mt-2 text-xs text-ink/50">Same login as the website admin (cory.salisbury@gmail.com and your password); the app does not need the authenticator code. From here the app manages clients, listings and contracts, contract deadlines, showings and website leads. Drips, email templates and CRM tasks stay on the web dashboard.</div>
        {crmMsg && <div className="mt-2 text-xs text-ink/70">{crmMsg}</div>}
      </div>
      <div className="mt-8 rounded-lg border border-ink/10 bg-white p-4 text-sm">
        <div className="font-medium">Local AI</div>
        <div className="mt-1 text-ink/70">State: {boot.modelState}{boot.backend ? ` via ${boot.backend === 'ollama' ? 'Ollama (CPU fallback)' : 'llama.cpp (Vulkan, fast path)'}` : ''}</div>
        <div className="mt-1 text-ink/60 text-xs">Model file: {boot.modelPath ?? 'unknown'}</div>
        {boot.backend === 'ollama' && <div className="mt-2 text-xs text-amber-800">Norton quarantined the fast launcher (redesk-llm.exe). Restore it from Norton quarantine and add this app folder to Norton exclusions to get the 4x faster GPU path back. Ollama works meanwhile.</div>}
        {boot.error && <div className="mt-1 text-red-700">{boot.error}</div>}
        <ul className="mt-3 divide-y divide-ink/5">
          {MODELS.map(m => (
            <li key={m.id} className="flex items-center justify-between py-2">
              <div><div className="font-medium">{m.file}</div><div className="text-xs text-ink/60">{m.purpose} · {m.sizeGb} GB</div></div>
              {present[m.id] ? <span className="text-xs text-emerald-700">on disk</span> : <div className="flex items-center gap-2 text-xs"><span className="text-ink/60">{prog[m.id] ?? 'not downloaded'}</span><button onClick={() => fetchModel(m)} disabled={!!prog[m.id] && !/failed|done/.test(prog[m.id])} className="rounded-md bg-ink px-3 py-1 text-white disabled:opacity-50">Download</button></div>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
