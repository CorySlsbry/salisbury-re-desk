import { useEffect, useState } from 'react';
import type { TxRow, DeadlineRow } from '../lib/repo';
import { draftWeeklySellerUpdate, draftPriceDrop, draftDeadlineReminder, draftActionsFromThread, polishDraft, type Draft } from '../lib/ai';
import { friendlyError } from '../lib/errors';

/**
 * Drafts for this file. The seller update, the three-option price drop and the deadline reminder are computed from
 * the file's facts (instant, exact). "Polish with local model" rewrites a computed draft inside the confidence loop and
 * shows the Monitor's verdict; the thread summary is a model job with every date and name checked against the thread.
 */
export default function AiPanel({ tx, deadlines }: { tx: TxRow; deadlines: DeadlineRow[] }) {
  const [mode, setMode] = useState<'update' | 'price' | 'reminder' | 'thread'>(tx.side === 'seller' ? 'update' : 'reminder');
  const [facts, setFacts] = useState({ showings: 0, feedback: '', marketNote: '', nextStep: '' });
  const [deadlineId, setDeadlineId] = useState<number | ''>(deadlines.find(d => d.status === 'pending')?.id ?? '');
  const [thread, setThread] = useState('');
  const [out, setOut] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState('');
  const [step, setStep] = useState('');
  const [err, setErr] = useState('');
  const [edited, setEdited] = useState(false);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.ctrlKey && e.key.toLowerCase() === 'd' && !busy) { e.preventDefault(); void go(); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  });

  function show(d: Draft) { setDraft(d); setOut(d.subject ? `Subject: ${d.subject}\n\n${d.text}` : d.text); setEdited(false); }
  async function go() {
    setBusy('draft'); setErr(''); setOut(''); setDraft(null); setStep('');
    try {
      if (mode === 'update') show(await draftWeeklySellerUpdate(tx, facts));
      else if (mode === 'price') show(await draftPriceDrop(tx));
      else if (mode === 'reminder') { const dl = deadlines.find(x => x.id === deadlineId); if (!dl) throw new Error('Pick a deadline'); show(await draftDeadlineReminder(tx, dl)); }
      else { const d = await draftActionsFromThread(thread, t => setOut(o => o + t), setStep); show(d); }
    } catch (e) { setErr(friendlyError(e)); } finally { setBusy(''); setStep(''); }
  }
  async function polish() {
    if (!draft || busy) return;
    setBusy('polish'); setErr(''); setStep('');
    try { const base = draft; setOut(''); const d = await polishDraft(base, setStep, t => setOut(o => o + t)); show(d); }
    catch (e) { setErr(friendlyError(e)); } finally { setBusy(''); setStep(''); }
  }
  const unverified = draft ? draft.monitor.grounding.ungrounded : [];
  const canCopy = !!draft && (draft.monitor.ok || edited);

  return (
    <div className="rounded-lg border border-ink/10 bg-white p-4 text-sm space-y-3">
      <div className="flex items-center justify-between"><div className="font-medium">Drafts for this file</div><span className="text-xs text-ink/50">computed from the file; the local model only polishes · nothing leaves this laptop</span></div>
      <div className="flex flex-wrap gap-2">
        {([['update', 'Weekly seller update'], ['price', 'Three-option price drop'], ['reminder', 'Deadline reminder text'], ['thread', 'Actions from an email thread']] as const).filter(([m]) => tx.side === 'seller' || (m !== 'update' && m !== 'price')).map(([m, l]) => (
          <button key={m} onClick={() => setMode(m)} className={`rounded-md border px-3 py-1.5 text-xs ${mode === m ? 'bg-ink text-white border-ink' : 'bg-white border-ink/15'}`}>{l}</button>
        ))}
      </div>
      {mode === 'update' && (
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-ink/60">Showings this week (used only if none were imported)<input type="number" value={facts.showings} onChange={e => setFacts({ ...facts, showings: Number(e.target.value) })} className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm" /></label>
          <label className="text-xs text-ink/60">What buyers said<input value={facts.feedback} onChange={e => setFacts({ ...facts, feedback: e.target.value })} className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm" /></label>
          <label className="text-xs text-ink/60">Market note (competing homes)<input value={facts.marketNote} onChange={e => setFacts({ ...facts, marketNote: e.target.value })} className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm" /></label>
          <label className="text-xs text-ink/60">Next step (blank = the app decides from the three-week rule)<input value={facts.nextStep} onChange={e => setFacts({ ...facts, nextStep: e.target.value })} className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm" /></label>
        </div>
      )}
      {mode === 'reminder' && (
        <select value={deadlineId} onChange={e => setDeadlineId(e.target.value ? Number(e.target.value) : '')} className="w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm">
          <option value="">Pick a deadline</option>
          {deadlines.filter(d => d.status === 'pending').map(d => <option key={d.id} value={d.id}>{d.due_on} {d.due_time} · {d.label}</option>)}
        </select>
      )}
      {mode === 'thread' && <textarea value={thread} onChange={e => setThread(e.target.value)} rows={5} placeholder="Paste the email or text thread here" className="w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm" />}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={go} disabled={!!busy} className="rounded-md bg-brand px-4 py-2 text-white text-sm disabled:opacity-50">{busy === 'draft' ? 'Working…' : mode === 'thread' ? 'Summarise with the local model' : 'Draft (instant)'}</button>
        {draft && draft.mode === 'computed' && <button onClick={polish} disabled={!!busy} className="rounded-md border border-ink/15 px-3 py-2 text-xs disabled:opacity-50">{busy === 'polish' ? 'Polishing…' : 'Polish with local model'}</button>}
        {step && <span className="text-xs text-ink/50">{step}</span>}
      </div>
      {err && <div className="text-red-700 text-xs">{err}</div>}
      {out && (
        <div>
          {draft && !draft.monitor.ok
            ? <textarea value={out} onChange={e => { setOut(e.target.value); setEdited(true); }} rows={Math.min(20, out.split('\n').length + 2)} className="w-full rounded-md border border-amber-300 bg-amber-50/40 p-3 font-sans text-sm" />
            : <pre className="whitespace-pre-wrap rounded-md border border-ink/10 bg-paper p-3 font-sans text-sm">{out}</pre>}
          {draft && (
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
              <span className={draft.mode === 'computed' ? 'rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-900' : 'rounded bg-ink/5 px-1.5 py-0.5 text-ink/70'}>{draft.mode === 'computed' ? 'exact: computed from this file' : `local model · ${draft.loop?.passes ?? 1} pass${(draft.loop?.passes ?? 1) === 1 ? '' : 'es'}${draft.loop?.switched ? ', switched approach' : ''}${draft.loop && !draft.loop.ok ? ' · FAILED the accuracy bar, showing the computed draft' : ''}`}</span>
              <span className={draft.monitor.ok ? 'text-emerald-700' : 'text-amber-800'}>{draft.monitor.ok ? `Verified: ${draft.monitor.grounding.grounded.length} fact(s) grounded, compliance clean` : `${unverified.length} unverified fact(s), compliance ${draft.verdict.ok ? 'clean' : `${draft.verdict.problems.length} issue(s)`}`}</span>
              <span className="text-ink/50">{draft.model} · {(draft.latencyMs / 1000).toFixed(1)}s</span>
              <button onClick={() => navigator.clipboard.writeText(out)} disabled={!canCopy} title={canCopy ? 'Copy' : 'Edit the unverified facts first, then copy'} className="rounded border border-ink/15 px-2 py-0.5 disabled:opacity-40">Copy</button>
            </div>
          )}
          {draft && unverified.length > 0 && <div className="mt-1 text-xs text-amber-900">Not in this file's facts (edit or delete before sending): {unverified.map(f => `${f.text} (${f.kind})`).join(' · ')}</div>}
          {draft && !draft.verdict.ok && <ul className="mt-1 list-disc pl-5 text-xs text-red-700">{draft.verdict.problems.map((p, i) => <li key={i}>{p.what}{p.match ? ` ("${p.match}")` : ''}</li>)}</ul>}
        </div>
      )}
    </div>
  );
}
