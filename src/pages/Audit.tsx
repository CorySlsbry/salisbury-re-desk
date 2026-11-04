import { useEffect, useState } from 'react';
import { db } from '../lib/native';
import { AUTOMATIONS, runAutomations } from '../lib/automations';
import { listAutomationRuns, type AutomationRun } from '../lib/repoAuto';
import { listModelRuns, listLessons, forgetLessons, type ModelRunRow, type LessonRow } from '../lib/repo';
import { friendlyError } from '../lib/errors';

interface EventRow { id: number; at: string; actor: string; name: string; subject_type: string | null; subject_id: number | null; payload_json: string | null }

/** Everything the automations, the local model and the Monitor did, in one place. Read-only except "forget lessons". */
export default function Audit() {
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [models, setModels] = useState<ModelRunRow[]>([]);
  const [lessons, setLessons] = useState<LessonRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [busy, setBusy] = useState('');
  const [tab, setTab] = useState<'automations' | 'model' | 'lessons' | 'events'>('automations');
  async function load() {
    setRuns(await listAutomationRuns(200));
    setModels(await listModelRuns(200));
    setLessons(await listLessons());
    const d = await db();
    setEvents(await d.select<EventRow[]>('SELECT * FROM events ORDER BY id DESC LIMIT 300'));
  }
  useEffect(() => { load().catch(e => setBusy(friendlyError(e))); }, []);
  async function runNow() { setBusy('Running every automation now (the model canary takes about a minute)…'); try { const r = await runAutomations('manual'); setBusy(`${r.length} ran: ${r.filter(x => !x.ok).length} flagged something`); await load(); } catch (e) { setBusy(friendlyError(e)); } }
  const latest = (key: string) => runs.find(r => r.key === key);
  const modelStats = (() => {
    const withLoop = models.filter(m => m.passes != null);
    const failed = withLoop.filter(m => !m.ok).length;
    const avg = withLoop.length ? (withLoop.reduce((s, m) => s + (m.passes ?? 0), 0) / withLoop.length).toFixed(1) : '-';
    return { count: withLoop.length, failed, avg };
  })();
  return (
    <div className="p-8 space-y-6 max-w-6xl">
      <div className="flex items-start justify-between gap-6">
        <div><h1 className="text-2xl font-semibold">Audit</h1><p className="mt-1 text-sm text-ink/60">What the in-app automations, the local model and the Monitor did, and when. Everything here is read-only; nothing an agent does is hidden.</p></div>
        <button onClick={runNow} className="rounded-md bg-brand px-3 py-1.5 text-xs text-white">Run all automations now</button>
      </div>
      {busy && <div className="text-xs text-ink/60">{busy}</div>}
      <div className="grid grid-cols-2 gap-3">
        {AUTOMATIONS.map(a => { const l = latest(a.key); return (
          <div key={a.key} className={`rounded-lg border p-3 text-xs ${l ? (l.ok ? 'border-emerald-200 bg-emerald-50/40' : 'border-amber-300 bg-amber-50') : 'border-ink/10 bg-white'}`}>
            <div className="flex items-center justify-between"><div className="text-sm font-medium">{a.name}</div><span className="text-ink/50">{a.every.join(' · ')}</span></div>
            <div className="mt-0.5 text-ink/60">{a.what}</div>
            <div className="mt-1">{l ? <><span className="text-ink/50">{l.at} · </span>{l.summary}</> : 'has not run yet'}</div>
            {l?.details_json && l.details_json !== 'null' && (() => { try { const dj = JSON.parse(l.details_json); const arr = Array.isArray(dj) ? dj : []; return arr.length ? <ul className="mt-1 list-disc pl-4 text-ink/70">{arr.slice(0, 8).map((x: string, i: number) => <li key={i}>{String(x)}</li>)}</ul> : null; } catch { return null; } })()}
          </div>); })}
      </div>
      <div className="rounded-lg border border-ink/10 bg-white p-3 text-xs">
        <div className="text-sm font-medium">Monitor</div>
        <div className="mt-1 text-ink/60">Every model output is graded by code: the JSON shape, the compliance gate, and grounding (each date, amount, name, address and phone must appear in the data the model was given). Jobs loop up to five passes to clear the accuracy bar and switch approach from pass three; the lessons tab shows what the loop learned.</div>
        <div className="mt-2 flex flex-wrap gap-4 text-ink/70"><span>Loop runs: <b>{modelStats.count}</b></span><span>Failed the bar: <b className={modelStats.failed ? 'text-amber-800' : ''}>{modelStats.failed}</b></span><span>Average passes: <b>{modelStats.avg}</b></span><span>Lessons remembered: <b>{lessons.length}</b></span></div>
      </div>
      <div className="flex gap-2">{(['automations', 'model', 'lessons', 'events'] as const).map(t => <button key={t} onClick={() => setTab(t)} className={`rounded-md border px-3 py-1 text-xs ${tab === t ? 'bg-ink text-white border-ink' : 'bg-white border-ink/15'}`}>{t === 'automations' ? `Automation runs (${runs.length})` : t === 'model' ? `Model runs (${models.length})` : t === 'lessons' ? `Lessons (${lessons.length})` : `Events (${events.length})`}</button>)}</div>
      <div className="rounded-lg border border-ink/10 bg-white text-xs">
        {tab === 'automations' && <table className="w-full"><thead><tr className="text-left text-ink/50 border-b border-ink/10"><th className="px-3 py-1.5">When</th><th>Automation</th><th>Trigger</th><th>Result</th><th>ms</th></tr></thead><tbody>{runs.map(r => <tr key={r.id} className="border-b border-ink/5"><td className="px-3 py-1 tabular-nums text-ink/60">{r.at}</td><td>{r.key}</td><td>{r.trigger}</td><td className={r.ok ? '' : 'text-amber-800'}>{r.summary}</td><td className="tabular-nums text-ink/50">{r.duration_ms ?? ''}</td></tr>)}</tbody></table>}
        {tab === 'model' && <table className="w-full"><thead><tr className="text-left text-ink/50 border-b border-ink/10"><th className="px-3 py-1.5">When</th><th>Job</th><th>Latency</th><th>Passes</th><th>Grounding</th><th>Result</th><th>Unverified</th></tr></thead><tbody>{models.map(m => { let v: { verdict?: { ok: boolean; problems: unknown[] }; toolCalls?: string[] } = {}; try { v = JSON.parse(m.output_json ?? '{}'); } catch { /* old rows */ } let un: string[] = []; try { un = JSON.parse(m.ungrounded_json ?? '[]'); } catch { /* none */ } return <tr key={m.id} className="border-b border-ink/5"><td className="px-3 py-1 tabular-nums text-ink/60">{m.at}</td><td>{m.purpose}{v.toolCalls?.length ? <span className="text-ink/40"> · {v.toolCalls.join(', ')}</span> : null}</td><td className="tabular-nums">{m.latency_ms ? `${(m.latency_ms / 1000).toFixed(1)}s` : ''}</td><td className="tabular-nums">{m.passes ?? ''}{m.strategy ? <span className="text-ink/40"> {m.strategy}</span> : null}</td><td className="tabular-nums">{m.grounding_score != null ? `${Math.round(m.grounding_score * 100)}%` : ''}</td><td className={m.ok ? 'text-emerald-700' : 'text-amber-800'}>{m.ok ? 'passed' : 'failed'}{v.verdict && !v.verdict.ok ? ` · compliance ${v.verdict.problems.length}` : ''}</td><td className="text-amber-900 max-w-xs truncate" title={un.join(' · ')}>{un.slice(0, 4).join(' · ')}</td></tr>; })}</tbody></table>}
        {tab === 'lessons' && (
          <div>
            <div className="flex items-center justify-between px-3 py-2 border-b border-ink/10"><span className="text-ink/60">What the loop learned from its own verdicts: for each job and failure kind, the approach that failed and the one that finally passed. Used to start at the working approach next time.</span><button onClick={async () => { await forgetLessons(); await load(); }} className="rounded border border-ink/15 px-2 py-0.5">Forget all lessons</button></div>
            <table className="w-full"><thead><tr className="text-left text-ink/50 border-b border-ink/10"><th className="px-3 py-1.5">Job</th><th>Failure</th><th>Failed with</th><th>Worked with</th><th>Hint</th><th>Seen</th></tr></thead><tbody>{lessons.map(l => <tr key={l.id} className="border-b border-ink/5"><td className="px-3 py-1">{l.job}</td><td>{l.failure_signature}</td><td>{l.strategy_failed}</td><td className={l.strategy_worked ? 'text-emerald-700' : 'text-amber-800'}>{l.strategy_worked ?? 'nothing yet'}</td><td className="text-ink/60">{l.hint}</td><td className="tabular-nums">{l.count}</td></tr>)}{!lessons.length && <tr><td className="px-3 py-2 text-ink/50" colSpan={6}>No lessons yet: every loop so far passed on its first approach, or the model has not been asked.</td></tr>}</tbody></table>
          </div>
        )}
        {tab === 'events' && <table className="w-full"><thead><tr className="text-left text-ink/50 border-b border-ink/10"><th className="px-3 py-1.5">When</th><th>Event</th><th>Subject</th><th>Payload</th></tr></thead><tbody>{events.map(e => <tr key={e.id} className="border-b border-ink/5"><td className="px-3 py-1 tabular-nums text-ink/60">{e.at}</td><td>{e.name}</td><td className="text-ink/60">{e.subject_type ? `${e.subject_type} ${e.subject_id ?? ''}` : ''}</td><td className="truncate max-w-md text-ink/60" title={e.payload_json ?? ''}>{(e.payload_json ?? '').slice(0, 120)}</td></tr>)}</tbody></table>}
      </div>
    </div>
  );
}
