import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openDocument, revealDocument, fileDocument, guessKind, folderFor, KIND_LABEL } from '../lib/documents';
import AiPanel from '../components/AiPanel';
import { exportCompleteFile } from '../lib/export';
import { getClient, listTransactions, listDeadlines, listTasks, listDocuments, listPacket, completeTask, setDeadlineStatus, setPacketItem, updateClient, type Client, type TxRow, type DeadlineRow, type TaskRow, type DocumentRow, type PacketItemRow, today } from '../lib/repo';
import { enroll, markReplied } from '../lib/leads';
import AgentPanel from '../components/AgentPanel';
import CalendarCard from '../components/CalendarCard';
import { createGmailDraft, uploadToDrive, shareDriveFile, saveGoogleContact, googleStatus } from '../lib/google';
import { listDriveFiles as listDriveRows, getSettings as getAppSettings, type DriveFileRow } from '../lib/repo';
import { prefillFromTransaction } from '../lib/formfill';
import { stampTransaction, listShowings, type ShowingRow } from '../lib/repoAuto';
import { importShowings, showingBenchmark } from '../lib/showings';
import { runAutomations } from '../lib/automations';
import { completeDeadlinesOfBasis } from '../lib/repo';
import { friendlyError } from '../lib/errors';
import { money } from '../lib/fmt';
import { addDays } from '../lib/deadlines';
import { SECTIONS, listSections, saveSection, setSmsConsent, type SectionRow } from '../lib/repo';

export default function ClientDetail() {
  const { id } = useParams();
  const cid = Number(id);
  const [client, setClient] = useState<Client | null>(null);
  const [txs, setTxs] = useState<TxRow[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [deadlines, setDeadlines] = useState<DeadlineRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [packet, setPacket] = useState<PacketItemRow[]>([]);
  const [sections, setSections] = useState<SectionRow[]>([]);
  const [showings, setShowings] = useState<ShowingRow[]>([]);
  const [bench, setBench] = useState<Awaited<ReturnType<typeof showingBenchmark>> | null>(null);
  const [showingPaste, setShowingPaste] = useState('');
  const [showingMsg, setShowingMsg] = useState('');
  const [docMsg, setDocMsg] = useState('');
  const [drive, setDrive] = useState<Record<string, DriveFileRow>>({});
  const [exportZip, setExportZip] = useState('');
  const [gBusy, setGBusy] = useState('');
  function clientFolderName(): string { return (client?.folder_path ?? '').split(/[\\/]/).filter(Boolean).pop() || `${client?.last_name ?? ''}, ${client?.first_name ?? ''}`; }
  /** Google must be connected, and the token must carry the scope this button needs (older tokens predate Drive/Contacts). */
  async function googleReady(need: 'Drive' | 'Contacts', say: (m: string) => void): Promise<boolean> {
    const st = await googleStatus();
    if (!st.connected) { say(`Connect Google in Settings first. ${need} is part of the same permission.`); return false; }
    if (st.missing.includes(need)) { say(`Google was connected before ${need} was added. In Settings click Disconnect, then connect again to grant it.`); return false; }
    return true;
  }
  /** Upload one file to Drive > Salisbury RE Desk > <client folder>, optionally share view-only with one address, copy the link. */
  async function driveLink(path: string, shareWith?: string | null) {
    if (gBusy) return; setGBusy('drive');
    try {
      if (!(await googleReady('Drive', setDocMsg))) return;
      setDocMsg('Uploading to Drive…');
      let f = await uploadToDrive(path, clientFolderName(), setDocMsg);
      const who = shareWith?.trim();
      if (who && !f.shared.includes(who)) f = await shareDriveFile(f, { email: who });
      await navigator.clipboard.writeText(f.web_view_link).catch(() => {});
      setDocMsg(`Drive link copied${who ? `, shared view-only with ${who}` : ' (only you can open it until you share it)'}:\n${f.web_view_link}`);
      setDrive(await listDriveRows());
    } catch (e) { setDocMsg(friendlyError(e)); } finally { setGBusy(''); }
  }
  /** Complete File hand-off: zip to Drive, view-only share with Pat, Gmail draft with the link. Nothing is sent. */
  async function sendToPat() {
    if (!exportZip || !client || gBusy) return; setGBusy('pat');
    try {
      const pat = ((await getAppSettings()).google_broker_email ?? '').trim();
      if (!pat) { setExportMsg("Add Pat's email in Settings (Google block) first."); return; }
      if (!(await googleReady('Drive', setExportMsg))) return;
      setExportMsg('Uploading the Complete File to Drive…');
      let f = await uploadToDrive(exportZip, clientFolderName(), setExportMsg);
      if (!f.shared.includes(pat)) f = await shareDriveFile(f, { email: pat });
      const label = clientFolderName();
      const d = await createGmailDraft(pat, `Complete File: ${label}`, `Pat,\n\nThe Complete File for ${label} is shared with you on Drive (view only):\n${f.web_view_link}\n\nIt is in Exhibit B order with an index and a sha256 manifest.\n\nCory Salisbury\nSimple Choice Real Estate`);
      setExportMsg(`Shared view-only with ${pat} on Drive. ${d.existing ? 'The Gmail draft with the link already exists in Drafts (not duplicated)' : 'A Gmail draft with the link is waiting in Drafts'}; review and send.`);
      setDrive(await listDriveRows());
    } catch (e) { setExportMsg(friendlyError(e)); } finally { setGBusy(''); }
  }
  async function saveContact() {
    if (gBusy) return; setGBusy('contact');
    try {
      if (!(await googleReady('Contacts', setDocMsg))) return;
      const r = await saveGoogleContact(cid);
      setDocMsg({ unchanged: 'Google Contact is already up to date.', created: 'Google Contact created.', updated: 'Google Contact updated.', relinked: 'This client already existed in Google Contacts; linked to that contact and updated it instead of making a second one.' }[r]);
    } catch (e) { setDocMsg(friendlyError(e)); } finally { setGBusy(''); }
  }
  const [pendingDocs, setPendingDocs] = useState<Array<{ path: string; kind: string; signed: boolean }>>([]);
  async function addDocuments() {
    const picked = await openDialog({ multiple: true, filters: [{ name: 'Documents', extensions: ['pdf', 'docx', 'doc', 'jpg', 'jpeg', 'png', 'txt', 'eml', 'msg'] }] });
    const paths = (Array.isArray(picked) ? picked : picked ? [picked] : []) as string[];
    if (!paths.length) return;
    setDocMsg('Reading the first page of each file to guess what it is…');
    const guessed = [] as Array<{ path: string; kind: string; signed: boolean }>;
    for (const path of paths) guessed.push({ path, kind: /\.pdf$/i.test(path) ? await guessKind(path) : 'other', signed: true });
    setPendingDocs(guessed); setDocMsg('');
  }
  async function fileDocuments() {
    if (!sel) return;
    const done: string[] = [];
    for (const pd of pendingDocs) { try { const r = await fileDocument(sel, pd.path, pd.kind, { signed: pd.signed }); done.push(`${r.path.split(/[\\/]/).pop()} → ${folderFor(pd.kind)}${r.packetMarked ? ' (packet item marked received)' : ''}`); } catch (e) { done.push(`${pd.path.split(/[\\/]/).pop()}: ${friendlyError(e)}`); } }
    setPendingDocs([]); setDocMsg(done.join('\n')); await load();
  }
  const [exportMsg, setExportMsg] = useState('');
  const [prefillBusy, setPrefillBusy] = useState('');
  const [prefillMsg, setPrefillMsg] = useState('');
  async function doPrefill(includeManual: boolean) {
    if (!sel) return;
    setPrefillBusy('Working…'); setPrefillMsg('');
    try {
      const r = await prefillFromTransaction(sel, { includeManual }, s => setPrefillBusy(s));
      setPrefillMsg(`${r.filled.length} form(s) prefilled into the client folder (unsigned drafts):\n${r.filled.map(f => '• ' + f.path.split(/[\\/]/).pop()).join('\n')}${r.skipped.length ? `\n\nSkipped:\n${r.skipped.map(s => '• ' + s).join('\n')}` : ''}`);
      await load();
    } catch (e) { setPrefillMsg(friendlyError(e)); } finally { setPrefillBusy(''); }
  }
  async function doExport() {
    if (!sel) return;
    try { const r = await exportCompleteFile(sel); setExportZip(r.zipPath); setExportMsg(`Exported ${r.included} file(s) to 07 Broker Submissions${r.missing.length ? `; still owed: ${r.missing.length}` : ''}`); await load(); }
    catch (e) { setExportMsg(friendlyError(e)); }
  }

  async function load() {
    const c = await getClient(cid); setClient(c);
    const t = await listTransactions({ clientId: cid }); setTxs(t);
    const s = sel ?? t[0]?.id ?? null; setSel(s);
    if (s) { setDeadlines(await listDeadlines({ transactionId: s })); setTasks(await listTasks({ transactionId: s, includeDone: true })); setDocs(await listDocuments(s)); setPacket(await listPacket(s)); setSections(await listSections(s)); setShowings(await listShowings(s)); setBench(await showingBenchmark(s, addDays(today(), -7))); setDrive(await listDriveRows()); }
  }
  useEffect(() => { load().catch(() => {}); }, [cid, sel]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.ctrlKey && e.key.toLowerCase() === 'e') { e.preventDefault(); void doExport(); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  });

  if (!client) return <div className="p-8 text-sm text-ink/60">Loading…</div>;
  const tx = txs.find(t => t.id === sel);
  const t0 = today();
  const cls = (d: string, done: boolean) => done ? 'text-ink/40 line-through' : d < t0 ? 'text-red-700 font-medium' : d <= addDays(t0, 7) ? 'text-amber-700 font-medium' : '';

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{client.last_name}, {client.first_name}{client.second_first_name ? ` & ${client.second_first_name} ${client.second_last_name ?? ''}` : ''}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink/60"><span>{[client.phone, client.email, client.source].filter(Boolean).join(' · ')}</span><button onClick={saveContact} disabled={!!gBusy} className="rounded border border-ink/15 px-1.5 py-0.5 text-[10px] disabled:opacity-50" title="Create or update this client in Google Contacts (caller ID, Gmail autocomplete)">{gBusy === 'contact' ? 'Working…' : 'Google Contact'}</button></div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <select value={client.stage} onChange={async e => { await updateClient(cid, { stage: e.target.value as Client['stage'] }); await load(); }} className="rounded border border-ink/15 bg-white px-1.5 py-0.5">{['lead', 'nurture', 'client', 'past', 'lost'].map(s => <option key={s} value={s}>{s}</option>)}</select>
            <select value={client.preferred_channel ?? ''} onChange={async e => { await updateClient(cid, { preferred_channel: e.target.value || null }); await load(); }} className="rounded border border-ink/15 bg-white px-1.5 py-0.5"><option value="">channel?</option>{['text', 'call', 'email', 'facebook', 'instagram', 'other'].map(c => <option key={c} value={c}>prefers {c}</option>)}</select>
            <select value={client.interest ?? ''} onChange={async e => { await updateClient(cid, { interest: e.target.value || null }); await load(); }} className="rounded border border-ink/15 bg-white px-1.5 py-0.5"><option value="">interest?</option><option value="seller">seller</option><option value="buyer">buyer</option><option value="both">both</option></select>
            <label className="text-ink/50">birthday <input type="date" value={client.birthday ?? ''} onChange={async e => { await updateClient(cid, { birthday: e.target.value || null }); await load(); }} className="rounded border border-ink/15 bg-white px-1.5 py-0.5" /></label>
            {client.last_touch_on && <span className="text-ink/50">last touch {client.last_touch_on}</span>}
            <label className="flex items-center gap-1 text-ink/60"><input type="checkbox" checked={!!client.sms_consent} onChange={async e => { await setSmsConsent(cid, e.target.checked); await load(); }} />text-message consent on file</label>
            {(client.stage === 'lead' || client.stage === 'nurture') && !client.replied_at && <button onClick={async () => { await markReplied(cid); await load(); }} className="rounded border border-ink/15 bg-white px-2 py-0.5">Replied (pause the drip)</button>}
            {client.stage === 'client' && !txs.length && <button onClick={async () => { await enroll(cid, 'new_lead_30'); await load(); }} className="rounded border border-ink/15 bg-white px-2 py-0.5">Start the 30-day drip</button>}
            {(client.stage === 'client' || client.stage === 'past') && <button onClick={async () => { await enroll(cid, 'post_close_year'); await load(); }} className="rounded border border-ink/15 bg-white px-2 py-0.5">Start the post-close year</button>}
          </div>
        </div>
        {client.folder_path && <button onClick={() => openDocument(client.folder_path!).catch(e => setDocMsg(friendlyError(e)))} className="rounded-md border border-ink/15 bg-white px-3 py-2 text-sm">Open folder</button>}
      </div>

      {txs.length > 1 && <div className="flex gap-2">{txs.map(t => <button key={t.id} onClick={() => setSel(t.id)} className={`rounded-md px-3 py-1.5 text-sm border ${sel === t.id ? 'bg-ink text-white border-ink' : 'bg-white border-ink/15'}`}>{t.side} · {t.street ?? 'no property'}</button>)}</div>}

      {tx && (
        <div className="grid grid-cols-3 gap-6">
          <section className="col-span-2 space-y-6">
            <div className="rounded-lg border border-ink/10 bg-white p-4 text-sm">
              <div className="flex items-center justify-between"><div className="font-medium">{tx.side === 'buyer' ? 'Buying' : 'Selling'} {tx.street}{tx.city ? `, ${tx.city}` : ''}</div><span className="rounded-full bg-ink/5 px-2 py-0.5 text-xs">{tx.status.replace('_', ' ')}</span></div>
              <div className="mt-1 text-ink/60">{tx.contract_price ? money(tx.contract_price) : tx.list_price ? `List ${money(tx.list_price)}` : ''}{tx.acceptance_on ? ` · accepted ${tx.acceptance_on}` : ''}{tx.is_cash ? ' · cash' : ''}</div>
              {tx.agreement_signed_on && <div className="mt-1 text-ink/60">{tx.side === 'seller' ? 'Listing agreement' : 'Buyer-broker agreement'} signed {tx.agreement_signed_on}{tx.agreement_expires_on ? `, ends ${tx.agreement_expires_on} 5:00 PM` : ''}{tx.commission_pct != null ? ` · fee ${tx.commission_pct}%` : ''}{tx.commission_flat ? ` + ${money(tx.commission_flat)}` : ''}</div>}
            </div>
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-ink/60">Deadlines</h2>
              <ul className="mt-2 divide-y divide-ink/5 rounded-lg border border-ink/10 bg-white">
                {deadlines.map(d => (
                  <li key={d.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                    <input type="checkbox" checked={d.status === 'done'} onChange={e => setDeadlineStatus(d.id, e.target.checked ? 'done' : 'pending').then(load)} />
                    <span className={`w-28 tabular-nums ${cls(d.due_on, d.status === 'done' || d.status === 'waived')}`}>{d.due_on}</span>
                    <span className="w-12 text-ink/50">{d.due_time}</span>
                    <span className={d.status === 'waived' ? 'text-ink/40' : ''}>{d.label}{d.status === 'waived' ? ' (waived)' : ''}</span>
                    <span className="ml-auto text-xs text-ink/40">{d.basis}</span>
                  </li>
                ))}
                {!deadlines.length && <li className="px-4 py-3 text-sm text-ink/50">No deadlines yet.</li>}
              </ul>
            </div>
            <div className="rounded-lg border border-ink/10 bg-white p-3 text-xs space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-medium text-sm">Broker file and HOA clocks</div>
                <div className="flex flex-wrap gap-2">
                  {tx.broker_submitted_on ? <span className="text-emerald-700">Complete File sent to Pat {tx.broker_submitted_on}</span> : <button onClick={async () => { await stampTransaction(tx.id, { broker_submitted_on: t0 }); await completeDeadlinesOfBasis(tx.id, 'broker'); await load(); }} className="rounded border border-ink/15 bg-white px-2 py-0.5">Mark Complete File sent to Pat</button>}
                  {tx.side === 'seller' && (tx.hoa_request_sent_on ? <span className="text-ink/60">HOA request sent {tx.hoa_request_sent_on}, records due {addDays(tx.hoa_request_sent_on, 14)} (57-8a-227)</span> : <button onClick={async () => { await stampTransaction(tx.id, { hoa_request_sent_on: t0 }); await runAutomations('manual', tx.id); await load(); }} className="rounded border border-ink/15 bg-white px-2 py-0.5">Mark HOA records request sent today</button>)}
                </div>
              </div>
              {tx.side === 'seller' && (
                <div>
                  <div className="flex items-center justify-between"><span className="font-medium">Showings <span className="font-normal text-ink/50">{showings.length} on file{bench ? ` · last 7 days: ${bench.week} (${bench.benchmark}, ${bench.verdict === 'on' ? 'on target' : bench.verdict})` : ''}</span></span></div>
                  <textarea value={showingPaste} onChange={e => setShowingPaste(e.target.value)} rows={3} placeholder="Paste the showing-service emails (Aligned Showings, ShowingTime) or your notes here: one showing per paragraph with a date. Feedback is read as written, never guessed." className="mt-1 w-full rounded border border-ink/15 px-2 py-1" />
                  <div className="mt-1 flex items-center gap-2"><button onClick={async () => { if (!showingPaste.trim()) return; const r = await importShowings(tx.id, showingPaste); setShowingMsg(`${r.added} showing(s) added, ${r.duplicates} already on file`); setShowingPaste(''); await load(); }} className="rounded bg-ink px-2 py-0.5 text-white">Import showings</button>{showingMsg && <span className="text-ink/60">{showingMsg}</span>}</div>
                  {showings.length > 0 && <ul className="mt-1 divide-y divide-ink/5">{showings.slice(0, 8).map(s => <li key={s.id} className="py-1"><span className="tabular-nums text-ink/60">{s.shown_on}{s.shown_at ? ' ' + s.shown_at : ''}</span> · {s.agent ?? 'agent?'}{s.brokerage ? ` (${s.brokerage})` : ''} · <span className={s.interest === 'hot' ? 'text-emerald-700' : s.interest === 'cold' ? 'text-red-700' : 'text-ink/60'}>{s.interest}</span>{s.feedback ? <div className="text-ink/70">{s.feedback}</div> : null}</li>)}</ul>}
                </div>
              )}
            </div>
            <CalendarCard txId={tx.id} />
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-ink/60">Intake sections</h2>
              <div className="mt-2 grid grid-cols-2 gap-3">
                {SECTIONS.map(([key, label]) => { const mine = sections.find(s => s.section === key && s.author === 'cory'); const theirs = sections.find(s => s.section === key && s.author === 'client'); return (
                  <div key={key} className="rounded-lg border border-ink/10 bg-white p-3 text-xs">
                    <div className="font-medium text-sm">{label}</div>
                    <textarea defaultValue={mine?.body_md ?? ''} onBlur={async e => { await saveSection(tx.id, key, 'cory', e.target.value); setSections(await listSections(tx.id)); }} rows={3} placeholder="Your notes" className="mt-1 w-full rounded border border-ink/15 px-2 py-1" />
                    <textarea defaultValue={theirs?.body_md ?? ''} onBlur={async e => { await saveSection(tx.id, key, 'client', e.target.value); setSections(await listSections(tx.id)); }} rows={2} placeholder="What the client said / wrote (from the questionnaire)" className="mt-1 w-full rounded border border-ink/15 bg-paper px-2 py-1" />
                  </div>); })}
              </div>
            </div>
            <AiPanel tx={tx} deadlines={deadlines} />
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-ink/60">Follow-up</h2>
              <ul className="mt-2 divide-y divide-ink/5 rounded-lg border border-ink/10 bg-white">
                {tasks.map(t => (
                  <li key={t.id} className="flex items-start gap-3 px-4 py-2 text-sm">
                    <input type="checkbox" checked={!!t.done_at} onChange={e => completeTask(t.id, e.target.checked).then(load)} className="mt-1" />
                    <span className={`w-28 tabular-nums ${cls(t.due_on, !!t.done_at)}`}>{t.due_on}</span>
                    <div className="flex-1"><div className={t.done_at ? 'text-ink/40 line-through' : ''}>{t.title}</div>{t.body && <pre className="mt-1 whitespace-pre-wrap font-sans text-xs text-ink/60">{t.body}</pre>}
                      {t.body && t.kind === 'email' && client.email && <button onClick={async () => { try { const subj = /^Subject:\s*(.*)$/m.exec(t.body!)?.[1] ?? t.title; const d = await createGmailDraft(client.email!, subj, t.body!.replace(/^Subject:.*\n+/, '')); setExportMsg(d.existing ? `That draft already exists in Gmail Drafts for ${client.email} (not duplicated). Open Gmail, Drafts, review and send.` : `Gmail draft created for ${client.email}. Open Gmail, Drafts, review and send.`); } catch (e) { setExportMsg(friendlyError(e)); } }} className="mt-1 rounded border border-ink/15 px-2 py-0.5 text-[10px]">Draft in Gmail</button>}
                      {t.kind === 'text' && !client.sms_consent && <span className="mt-1 block text-[10px] text-amber-700">No text consent on file: call instead, or get consent first.</span>}
                    </div>
                    <span className="text-xs text-ink/40">{t.kind}</span>
                  </li>
                ))}
                {!tasks.length && <li className="px-4 py-3 text-sm text-ink/50">No tasks.</li>}
              </ul>
            </div>
          </section>
          <aside className="space-y-6">
            <div>
              <div className="flex items-center justify-between"><h2 className="text-sm font-semibold uppercase tracking-wide text-ink/60">{tx.side === 'buyer' ? 'Buyer packet' : 'Seller packet'}</h2><div className="flex gap-1"><button onClick={doExport} className="rounded-md border border-ink/15 bg-white px-2 py-1 text-xs">Export Complete File</button>{exportZip && <button onClick={sendToPat} disabled={!!gBusy} className="rounded-md bg-ink px-2 py-1 text-xs text-white disabled:opacity-50" title="Upload the zip to Drive, share it view-only with Pat, and draft the email (nothing is sent)">Send to Pat via Drive</button>}</div></div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button onClick={() => doPrefill(false)} disabled={!!prefillBusy} className="rounded-md bg-brand px-3 py-1.5 text-xs text-white disabled:opacity-50">{prefillBusy || 'Prefill packet forms from this file'}</button>
                <button onClick={() => doPrefill(true)} disabled={!!prefillBusy} className="rounded-md border border-ink/15 bg-white px-2 py-1.5 text-xs" title="Also fills the situational forms: Limited Agency Consent, Brokerage Compensation Agreement">+ situational forms</button>
              </div>
              {prefillMsg && <div className="mt-1 whitespace-pre-wrap text-xs text-ink/60">{prefillMsg}</div>}
              {exportMsg && <div className="mt-1 text-xs text-ink/60">{exportMsg}</div>}
              <ul className="mt-2 divide-y divide-ink/5 rounded-lg border border-ink/10 bg-white text-sm">
                {packet.map(p => (
                  <li key={p.id} className="flex items-center gap-2 px-3 py-2">
                    <select value={p.status} onChange={e => setPacketItem(p.id, e.target.value).then(load)} className={`rounded border px-1 py-0.5 text-xs ${p.status === 'received' || p.status === 'submitted' ? 'bg-emerald-50 border-emerald-200' : p.status === 'not_applicable' ? 'bg-ink/5 border-ink/10 text-ink/50' : 'bg-amber-50 border-amber-200'}`}>
                      {['missing', 'received', 'submitted', 'not_applicable'].map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
                    </select>
                    <span className={p.status === 'not_applicable' ? 'text-ink/40' : ''}>{p.label}</span>
                    {p.form_path && <button onClick={() => openDocument(p.form_path!).catch(e => setDocMsg(friendlyError(e)))} title={`Open blank form: ${p.form_name ?? ''}`} className="ml-auto shrink-0 rounded border border-ink/15 px-1.5 py-0.5 text-[10px] text-ink/60 hover:bg-ink/5">blank form</button>}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-ink/60">Documents</h2>
                <div className="flex gap-1">
                  <button onClick={addDocuments} className="rounded-md bg-ink px-2 py-1 text-xs text-white">Add document</button>
                  {client.folder_path && <button onClick={() => openDocument(client.folder_path!).catch(e => setDocMsg(friendlyError(e)))} className="rounded-md border border-ink/15 bg-white px-2 py-1 text-xs">Open folder</button>}
                </div>
              </div>
              {client.folder_path && <div className="mt-1 truncate text-[10px] text-ink/40" title={client.folder_path}>{client.folder_path}</div>}
              {docMsg && <div className="mt-1 text-xs text-ink/70 whitespace-pre-wrap">{docMsg}</div>}
              {pendingDocs.length > 0 && (
                <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs space-y-1">
                  <div className="font-medium">File {pendingDocs.length} document(s): confirm what each one is</div>
                  {pendingDocs.map((pd, i) => (
                    <div key={pd.path} className="flex flex-wrap items-center gap-2">
                      <span className="truncate max-w-[12rem]" title={pd.path}>{pd.path.split(/[\\/]/).pop()}</span>
                      <select value={pd.kind} onChange={e => setPendingDocs(pendingDocs.map((x, j) => j === i ? { ...x, kind: e.target.value } : x))} className="rounded border border-ink/15 bg-white px-1 py-0.5">{KIND_LABEL.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                      <label className="flex items-center gap-1"><input type="checkbox" checked={pd.signed} onChange={e => setPendingDocs(pendingDocs.map((x, j) => j === i ? { ...x, signed: e.target.checked } : x))} />signed</label>
                      <span className="text-ink/40">→ {folderFor(pd.kind)}</span>
                    </div>
                  ))}
                  <div className="flex gap-2"><button onClick={fileDocuments} className="rounded bg-brand px-2 py-0.5 text-white">File them</button><button onClick={() => setPendingDocs([])} className="rounded border border-ink/15 px-2 py-0.5">Cancel</button></div>
                </div>
              )}
              <ul className="mt-2 divide-y divide-ink/5 rounded-lg border border-ink/10 bg-white text-sm">
                {docs.map(d => (
                  <li key={d.id} className="flex items-start gap-2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <button onClick={() => openDocument(d.path).catch(e => setDocMsg(friendlyError(e)))} className="text-left hover:underline" title={`Open in the default app: ${d.path}`}>{d.title ?? d.kind}</button>
                      <div className="text-xs text-ink/50">{d.draft ? <span className="rounded bg-amber-100 px-1 text-amber-900">prefilled draft, unsigned</span> : d.signed ? <span className="rounded bg-emerald-100 px-1 text-emerald-900">signed{d.signed_on ? ' ' + d.signed_on : ''}</span> : 'unsigned'} · {d.kind}{d.pages ? ` · ${d.pages} p` : ''} · {folderFor(d.kind)}{drive[d.path]?.shared.length ? ` · Drive: shared with ${drive[d.path].shared.join(', ')}` : ''}</div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button onClick={() => openDocument(d.path).catch(e => setDocMsg(friendlyError(e)))} className="rounded border border-ink/15 px-1.5 py-0.5 text-[10px]" title="Open in the default app (Acrobat, Edge, Word)">open</button>
                      <button onClick={() => revealDocument(d.path).catch(e => setDocMsg(friendlyError(e)))} className="rounded border border-ink/15 px-1.5 py-0.5 text-[10px]" title="Show in Explorer (right-click there for Open with)">folder</button>
                      <button onClick={() => driveLink(d.path)} disabled={!!gBusy} className="rounded border border-ink/15 px-1.5 py-0.5 text-[10px] disabled:opacity-50" title="Upload to your Drive (Salisbury RE Desk folder) and copy a private link">{drive[d.path] ? 'drive ✓' : 'drive'}</button>
                      {client.email && <button onClick={() => driveLink(d.path, client.email)} disabled={!!gBusy} className="rounded border border-ink/15 px-1.5 py-0.5 text-[10px] disabled:opacity-50" title={`Upload if needed, share view-only with ${client.email}, copy the link`}>{drive[d.path]?.shared.includes(client.email) ? 'shared ✓' : 'share'}</button>}
                    </div>
                  </li>
                ))}
                {!docs.length && <li className="px-3 py-3 text-ink/50">No documents filed. Add one, or intake a signed contract.</li>}
              </ul>
            </div>
          </aside>
        </div>
      )}
      {!tx && <div className="text-sm text-ink/60">No transaction yet for this client.</div>}
      {!tx && <div className="max-w-3xl"><AgentPanel initial="followup" prefill={`Draft a touch for ${client.first_name} ${client.last_name} in their preferred channel (${client.preferred_channel ?? 'text'}).`} /></div>}
    </div>
  );
}

