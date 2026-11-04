import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listDeadlines, listTasks, listTransactions, completeTask, today, type DeadlineRow, type TaskRow, type TxRow } from '../lib/repo';
import { addDays } from '../lib/deadlines';
import { engineSettings, itemsFor, coreDone } from '../lib/engine';
import { getSettings, dailyLog } from '../lib/repo';
import { inboxCounts } from '../lib/repoCrm';
import { crmStatus } from '../lib/crm';

export default function Today() {
  const [deadlines, setDeadlines] = useState<Array<DeadlineRow & { first_name: string; last_name: string; street: string | null }>>([]);
  const [tasks, setTasks] = useState<Array<TaskRow & { first_name: string | null; last_name: string | null; street: string | null }>>([]);
  const [txs, setTxs] = useState<TxRow[]>([]);
  const [core, setCore] = useState<{ done: number; total: number } | null>(null);
  const [leads, setLeads] = useState<{ new: number; connected: boolean } | null>(null);
  const t0 = today();
  async function load() {
    setDeadlines((await listDeadlines({ to: addDays(t0, 7) })).filter(d => d.status === 'pending'));
    setTasks(await listTasks({ dueThrough: t0 }));
    setTxs(await listTransactions({ status: ['active', 'under_contract', 'pending'] }));
    try { const es = engineSettings(await getSettings()); const items = itemsFor(t0, es); const log = await dailyLog(t0); setCore(coreDone(items, Object.fromEntries(Object.entries(log).map(([k, v]) => [k, { done: !!v.done_at, count: v.count }])))); } catch { /* engine not configured yet */ }
    try { const c = await inboxCounts(); const st = await crmStatus(); setLeads({ new: c.new, connected: st.connected }); } catch { /* crm tables not yet migrated */ }
  }
  useEffect(() => { load().catch(() => {}); }, []);
  const overdue = deadlines.filter(d => d.due_on < t0), week = deadlines.filter(d => d.due_on >= t0);
  return (
    <div className="p-8 space-y-8">
      <div><h1 className="text-2xl font-semibold">Today</h1><p className="mt-1 text-sm text-ink/60">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Denver' })} · Mountain Time. Five minutes: clear the list, scan the week.</p></div>
      <div className="flex flex-wrap gap-3 text-sm">
        {core && <Link to="/engine" className={`rounded-lg border px-4 py-2 ${core.done >= core.total ? 'border-emerald-200 bg-emerald-50' : 'border-ink/10 bg-white'}`}><span className="font-semibold">Daily Engine</span> <span className="text-ink/60">{core.done} of {core.total} non-negotiables done{core.done >= core.total ? '. Day made.' : ''}</span></Link>}
        {leads && (leads.new > 0 ? <Link to="/clients" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2"><span className="font-semibold">{leads.new} new lead{leads.new === 1 ? '' : 's'}</span> <span className="text-ink/60">from salisburyre.com, waiting on the Clients page</span></Link> : !leads.connected ? <Link to="/settings" className="rounded-lg border border-ink/10 bg-white px-4 py-2 text-ink/60">salisburyre.com CRM not connected: sign in under Settings to receive website leads here</Link> : null)}
      </div>
      <div className="grid grid-cols-3 gap-6">
        <Card title="Overdue deadlines" tone="red" empty="Nothing overdue." items={overdue.map(d => ({ key: d.id, main: d.label, sub: `${d.last_name}, ${d.first_name} · ${d.street ?? ''} · ${d.due_on} ${d.due_time}`, to: `/clients/${clientIdFor(txs, d.transaction_id)}` }))} />
        <Card title="Deadlines in the next 7 days" tone="amber" empty="Quiet week." items={week.map(d => ({ key: d.id, main: d.label, sub: `${d.last_name}, ${d.first_name} · ${d.street ?? ''} · ${d.due_on} ${d.due_time}`, to: `/clients/${clientIdFor(txs, d.transaction_id)}` }))} />
        <div className="rounded-lg border border-ink/10 bg-white p-4">
          <div className="text-sm font-semibold">Pipeline</div>
          <ul className="mt-2 space-y-1 text-sm">
            {txs.map(t => <li key={t.id}><Link to={`/clients/${t.client_id}`} className="hover:underline">{t.last_name}, {t.first_name}</Link> <span className="text-ink/50">· {t.side} · {t.street ?? 'no property'} · {t.status.replace('_', ' ')}</span></li>)}
            {!txs.length && <li className="text-ink/50">No active transactions. <Link to="/intake" className="text-brand underline">Intake one</Link>.</li>}
          </ul>
        </div>
      </div>
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink/60">Due today and earlier</h2>
        <ul className="mt-2 divide-y divide-ink/5 rounded-lg border border-ink/10 bg-white">
          {tasks.map(t => (
            <li key={t.id} className="flex items-start gap-3 px-4 py-2 text-sm">
              <input type="checkbox" onChange={() => completeTask(t.id).then(load)} className="mt-1" />
              <span className={`w-24 tabular-nums ${t.due_on < t0 ? 'text-red-700' : ''}`}>{t.due_on}</span>
              <div className="flex-1"><div>{t.title}</div><div className="text-xs text-ink/50">{[t.last_name && `${t.last_name}, ${t.first_name}`, t.street, t.kind].filter(Boolean).join(' · ')}</div>{t.body && <details className="mt-1 text-xs text-ink/70"><summary className="cursor-pointer">Copy-ready text</summary><pre className="mt-1 whitespace-pre-wrap font-sans">{t.body}</pre></details>}</div>
            </li>
          ))}
          {!tasks.length && <li className="px-4 py-6 text-center text-sm text-ink/50">Inbox zero. Go list something.</li>}
        </ul>
      </div>
    </div>
  );
}

function clientIdFor(txs: TxRow[], txId: number): number | '' { return txs.find(t => t.id === txId)?.client_id ?? ''; }

function Card({ title, tone, empty, items }: { title: string; tone: 'red' | 'amber'; empty: string; items: Array<{ key: number; main: string; sub: string; to: string }> }) {
  const ring = tone === 'red' ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50';
  return (
    <div className={`rounded-lg border p-4 ${items.length ? ring : 'border-ink/10 bg-white'}`}>
      <div className="text-sm font-semibold">{title}</div>
      <ul className="mt-2 space-y-2 text-sm">
        {items.map(i => <li key={i.key}><Link to={i.to} className="hover:underline">{i.main}</Link><div className="text-xs text-ink/60">{i.sub}</div></li>)}
        {!items.length && <li className="text-ink/50">{empty}</li>}
      </ul>
    </div>
  );
}
