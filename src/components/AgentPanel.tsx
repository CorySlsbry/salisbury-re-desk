import { useEffect, useRef, useState } from 'react';
import { AGENTS, runAgent, type AgentKey, type AgentReply } from '../lib/agents';
import type { ChatMessage } from '../lib/native';
import { friendlyError } from '../lib/errors';

/**
 * One panel, five specialised agents. The agent's own questions are computed from the database and shown instantly
 * ("exact"); a free-form question goes to the local model inside the confidence loop and comes back with the Monitor's
 * verdict. An answer with unverified facts must be edited before it can be copied.
 */
export default function AgentPanel({ initial = 'coordinator', compact = false, prefill }: { initial?: AgentKey; compact?: boolean; prefill?: string }) {
  const [key, setKey] = useState<AgentKey>(initial);
  const [q, setQ] = useState(prefill ?? '');
  const [out, setOut] = useState('');
  const [reply, setReply] = useState<AgentReply | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [err, setErr] = useState('');
  const [edited, setEdited] = useState(false);
  const hist = useRef<Record<string, ChatMessage[]>>({});
  const agent = AGENTS.find(a => a.key === key)!;
  useEffect(() => { if (prefill) setQ(prefill); }, [prefill]);

  async function ask(text?: string) {
    const user = (text ?? q).trim(); if (!user || busy) return;
    setBusy(true); setErr(''); setOut(''); setReply(null); setEdited(false); setStep('');
    try {
      const r = await runAgent(key, user, t => setOut(o => o + t), (hist.current[key] ?? []).slice(-6), setStep);
      hist.current[key] = [...(hist.current[key] ?? []), { role: 'user', content: user }, { role: 'assistant', content: r.text }];
      setOut(r.text); setReply(r);
    } catch (e) { setErr(friendlyError(e)); } finally { setBusy(false); setStep(''); }
  }
  const unverified = reply ? reply.monitor.grounding.ungrounded : [];
  const canCopy = !!reply && (reply.monitor.ok || edited);

  return (
    <div className={`rounded-lg border border-ink/10 bg-white ${compact ? 'p-3' : 'p-4'} text-sm space-y-3`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {AGENTS.map(a => <button key={a.key} onClick={() => { setKey(a.key); setOut(''); setReply(null); setQ(''); }} title={a.tagline} className={`rounded-md border px-2.5 py-1 text-xs ${key === a.key ? 'bg-ink text-white border-ink' : 'bg-white border-ink/15 hover:bg-ink/5'}`}>{a.name}</button>)}
        </div>
        <span className="shrink-0 text-[10px] text-ink/40">programmed first · local model only for free-form questions · nothing leaves this laptop</span>
      </div>
      <div className="text-xs text-ink/60">{agent.tagline}. Reads: {agent.tools.map(t => t.replace(/_/g, ' ')).join(', ')}.</div>
      <div className="flex flex-wrap gap-1.5">{agent.starters.map(s => <button key={s} onClick={() => { setQ(s); void ask(s); }} disabled={busy} className="rounded-full border border-ink/15 px-2.5 py-0.5 text-xs text-ink/70 hover:bg-ink/5 disabled:opacity-40">{s}</button>)}</div>
      <div className="flex gap-2">
        <textarea value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void ask(); } }} rows={2} placeholder={`Ask the ${agent.name}. Ctrl+Enter sends.`} className="flex-1 rounded-md border border-ink/15 px-3 py-2 text-sm" />
        <button onClick={() => ask()} disabled={busy || !q.trim()} className="self-end rounded-md bg-brand px-4 py-2 text-white text-sm disabled:opacity-50">{busy ? 'Working…' : 'Ask'}</button>
      </div>
      {step && <div className="text-xs text-ink/50">{step}</div>}
      {err && <div className="text-red-700 text-xs">{err}</div>}
      {(out || busy) && (
        <div>
          {reply && !reply.monitor.ok
            ? <textarea value={out} onChange={e => { setOut(e.target.value); setEdited(true); }} rows={Math.min(18, out.split('\n').length + 2)} className="w-full rounded-md border border-amber-300 bg-amber-50/40 p-3 font-sans text-sm" />
            : <pre className="whitespace-pre-wrap rounded-md border border-ink/10 bg-paper p-3 font-sans text-sm min-h-10">{out || 'Reading the file…'}</pre>}
          {reply && (
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
              <span className={reply.mode === 'computed' ? 'rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-900' : 'rounded bg-ink/5 px-1.5 py-0.5 text-ink/70'}>{reply.mode === 'computed' ? 'exact: computed from your database' : `local model · ${reply.loop?.passes ?? 1} pass${(reply.loop?.passes ?? 1) === 1 ? '' : 'es'}${reply.loop?.switched ? ', switched approach' : ''}${reply.loop && !reply.loop.ok ? ' · FAILED the accuracy bar' : ''}`}</span>
              <span className={reply.monitor.ok ? 'text-emerald-700' : 'text-amber-800'}>{reply.monitor.ok ? `Verified: ${reply.monitor.grounding.grounded.length} fact(s) grounded, compliance clean` : `${unverified.length} unverified fact(s), compliance ${reply.verdict.ok ? 'clean' : `${reply.verdict.problems.length} issue(s)`}`}</span>
              <span className="text-ink/50">{(reply.latencyMs / 1000).toFixed(1)}s{reply.toolCalls.length ? ` · looked up: ${reply.toolCalls.join(', ')}` : ''}</span>
              <button onClick={() => navigator.clipboard.writeText(out)} disabled={!canCopy} title={canCopy ? 'Copy' : 'Edit the unverified facts first, then copy'} className="rounded border border-ink/15 px-2 py-0.5 disabled:opacity-40">Copy</button>
            </div>
          )}
          {reply && unverified.length > 0 && <div className="mt-1 text-xs text-amber-900">Not in the data the agent was given (edit or delete before sending): {unverified.map(f => `${f.text} (${f.kind})`).join(' · ')}</div>}
          {reply && !reply.verdict.ok && <ul className="mt-1 list-disc pl-5 text-xs text-red-700">{reply.verdict.problems.map((p, i) => <li key={i}>{p.what}{p.match ? ` ("${p.match}")` : ''}</li>)}</ul>}
        </div>
      )}
    </div>
  );
}
