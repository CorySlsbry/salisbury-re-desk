import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { listDeadlines, listTasks, listTransactions, today, type DeadlineRow, type TaskRow } from '../lib/repo';
import { addDays, dayOfWeek } from '../lib/deadlines';

interface Item { key: string; date: string; time?: string | null; label: string; who: string; kind: 'deadline' | 'task'; basis?: string; to: string }

export default function Calendar() {
  const t0 = today();
  const [month, setMonth] = useState(t0.slice(0, 7));
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    (async () => {
      const from = `${month}-01`, to = addDays(`${month}-01`, 45);
      const txs = await listTransactions();
      const cid = (id: number | null) => txs.find(t => t.id === id)?.client_id ?? '';
      const ds = (await listDeadlines({ from: addDays(from, -7), to })).filter(d => d.status !== 'waived') as Array<DeadlineRow & { first_name: string; last_name: string; street: string | null }>;
      const ts = (await listTasks({ dueThrough: to })) as Array<TaskRow & { first_name: string | null; last_name: string | null; street: string | null }>;
      setItems([
        ...ds.map(d => ({ key: `d${d.id}`, date: d.due_on, time: d.due_time, label: d.label, who: `${d.last_name}, ${d.first_name}${d.street ? ' · ' + d.street : ''}`, kind: 'deadline' as const, basis: d.basis, to: `/clients/${cid(d.transaction_id)}` })),
        ...ts.map(t => ({ key: `t${t.id}`, date: t.due_on, time: t.due_time, label: t.title, who: t.last_name ? `${t.last_name}, ${t.first_name}` : '', kind: 'task' as const, to: `/clients/${cid(t.transaction_id)}` })),
      ]);
    })().catch(() => {});
  }, [month]);

  const grid = useMemo(() => {
    const first = `${month}-01`; const lead = dayOfWeek(first);
    const cells: string[] = [];
    for (let i = -lead; i < 42 - lead; i++) cells.push(addDays(first, i));
    return cells;
  }, [month]);
  const byDate = useMemo(() => { const m = new Map<string, Item[]>(); for (const i of items) { if (!m.has(i.date)) m.set(i.date, []); m.get(i.date)!.push(i); } return m; }, [items]);
  const shift = (n: number) => { const [y, m] = month.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); setMonth(d.toISOString().slice(0, 7)); };
  // TZ-OK: the month label is built from a fixed noon-UTC instant of a YYYY-MM string; no wall clock is involved
  const title = new Date(`${month}-01T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  return (
    <div className="p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <div className="flex gap-2 text-sm"><button onClick={() => shift(-1)} className="rounded-md border border-ink/15 bg-white px-3 py-1.5">Prev</button><button onClick={() => setMonth(t0.slice(0, 7))} className="rounded-md border border-ink/15 bg-white px-3 py-1.5">Today</button><button onClick={() => shift(1)} className="rounded-md border border-ink/15 bg-white px-3 py-1.5">Next</button></div>
      </div>
      <div className="mt-4 grid grid-cols-7 gap-px rounded-lg border border-ink/10 bg-ink/10 overflow-hidden text-xs">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => <div key={d} className="bg-paper px-2 py-1 font-medium text-ink/60">{d}</div>)}
        {grid.map(date => {
          const inMonth = date.startsWith(month); const list = byDate.get(date) ?? [];
          return (
            <div key={date} className={`min-h-24 bg-white p-1.5 ${inMonth ? '' : 'opacity-40'} ${date === t0 ? 'ring-2 ring-inset ring-brand' : ''}`}>
              <div className="text-ink/50">{Number(date.slice(8))}</div>
              <ul className="mt-1 space-y-0.5">
                {list.slice(0, 5).map(i => (
                  <li key={i.key}><Link to={i.to} title={`${i.who} ${i.time ?? ''}`} className={`block truncate rounded px-1 py-0.5 ${i.kind === 'deadline' ? (i.basis === 'contract' ? 'bg-brand/90 text-white' : 'bg-ink/80 text-white') : 'bg-amber-100 text-amber-900'} ${date < t0 ? 'opacity-60' : ''}`}>{i.time && i.kind === 'deadline' ? `${i.time} ` : ''}{i.label}</Link></li>
                ))}
                {list.length > 5 && <li className="text-ink/50">+{list.length - 5} more</li>}
              </ul>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex gap-4 text-xs text-ink/60"><span><i className="inline-block h-2.5 w-2.5 rounded bg-brand/90 align-middle mr-1" />Contract deadline (5 PM MT)</span><span><i className="inline-block h-2.5 w-2.5 rounded bg-ink/80 align-middle mr-1" />Derived / broker / compliance</span><span><i className="inline-block h-2.5 w-2.5 rounded bg-amber-200 align-middle mr-1" />Follow-up task</span></div>
    </div>
  );
}
