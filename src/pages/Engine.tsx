import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { Link } from 'react-router-dom';
import * as repo from '../lib/repo';
import { today, type TxRow, type DailyLogRow, type IdeaRow, type OpenHouseRow, type Client } from '../lib/repo';
import { addDays, dayOfWeek } from '../lib/deadlines';
import { BLOCK_NOTES, FAILURE_MODES, PLATFORMS, RECOVERY, coreDone, dayMeta, engineSettings, friendAddPlan, isResetDay, itemsFor, manifestTarget, platformRoom, reelSchedule, streak, type EngineItem, type EngineSettings } from '../lib/engine';
import { rollDripsToNurture } from '../lib/leads';
import { nextOpenHouseDate, planOpenHouse, cancelOpenHouse } from '../lib/openHouses';
import { friendlyError } from '../lib/errors';
import { dayLabel, money } from '../lib/fmt';
import AgentPanel from '../components/AgentPanel';
import type { AgentKey } from '../lib/agents';

/*
 * Every sub-component in this file lives at MODULE level and receives what it needs as props. Defining components
 * inside the page function creates a new component type on every render, which makes React unmount and remount
 * the whole subtree: open dropdowns snap shut, inputs lose focus, and the page jumps to the top. That was the
 * "screen pops to the top" bug. The countdown is its own component so the 1-second tick re-renders only itself.
 */

type Log = Record<string, DailyLogRow>;
type Touches = Awaited<ReturnType<typeof repo.listTouches>>;
type Birthdays = Awaited<ReturnType<typeof repo.birthdaysWithin>>;
type PostCounts = Record<string, { posts: number; adds: number; face: number }>;
type TouchForm = { who: string; channel: string; kind: 'gratitude' | 'business'; client_id: string };
type OhForm = { txId: string; date: string; start: string; end: string };
const CHANNELS = ['text', 'call', 'facebook', 'instagram', 'email', 'dm', 'other'];

export default function Engine() {
  const t0 = today();
  const [date, setDate] = useState(t0);
  const [settings, setSettings] = useState<EngineSettings | null>(null);
  const [log, setLog] = useState<Log>({});
  const [streakInfo, setStreakInfo] = useState({ days: 0, holes: 0, broken: true });
  const [deadlines, setDeadlines] = useState<Array<repo.DeadlineRow & { first_name: string; last_name: string; street: string | null }>>([]);
  const [txs, setTxs] = useState<TxRow[]>([]);
  const [leads, setLeads] = useState<Client[]>([]);
  const [birthdays, setBirthdays] = useState<Birthdays>([]);
  const [touches, setTouches] = useState<Touches>([]);
  const [ideas, setIdeas] = useState<IdeaRow[]>([]);
  const [ohs, setOhs] = useState<OpenHouseRow[]>([]);
  const [posts, setPosts] = useState<PostCounts>({});
  const [ideaText, setIdeaText] = useState('');
  const [touch, setTouch] = useState<TouchForm>({ who: '', channel: 'text', kind: 'business', client_id: '' });
  const [agent, setAgent] = useState<{ key: AgentKey; prefill?: string } | null>(null);
  const [timerEndsAt, setTimerEndsAt] = useState<{ key: string; endsAt: number } | null>(null);
  const [ohForm, setOhForm] = useState<OhForm>({ txId: '', date: '', start: '10:00', end: '12:00' });
  const [msg, setMsg] = useState('');
  const [score, setScore] = useState<Awaited<ReturnType<typeof repo.weekScorecard>> | null>(null);

  const s = settings ?? engineSettings({});
  const items = useMemo(() => itemsFor(date, s), [date, s]);
  const logView = useMemo(() => Object.fromEntries(Object.entries(log).map(([k, v]) => [k, { done: !!v.done_at, count: v.count }])), [log]);
  const core = coreDone(items, logView);
  const meta = dayMeta(date, s);
  const reset = isResetDay(date, s);

  async function load() {
    const st = await repo.getSettings(); const es = engineSettings(st); setSettings(es);
    setLog(await repo.dailyLog(date));
    const coreKeys = itemsFor('2026-09-08', es).filter(i => i.block !== 'day').map(i => i.key);
    setStreakInfo(streak(t0, await repo.coreCompleteDates(coreKeys), es));
    setDeadlines((await repo.listDeadlines({ to: addDays(t0, 7) })).filter(d => d.status === 'pending'));
    setTxs(await repo.listTransactions({ status: ['active', 'under_contract', 'pending'] }));
    setLeads([...(await repo.listPeople('lead')), ...(await repo.listPeople('nurture'))]);
    setBirthdays(await repo.birthdaysWithin(3));
    setTouches(await repo.listTouches(date));
    setIdeas(await repo.listIdeas());
    setOhs(await repo.listOpenHouses({ from: addDays(t0, -3), to: addDays(t0, 10) }));
    setPosts(await repo.postCounts(date));
    setOhForm(f => (f.date ? f : { ...f, date: nextOpenHouseDate(t0, es.openHouseDay) }));
    { let mon = date; while (dayOfWeek(mon) !== 1) mon = addDays(mon, -1); setScore(await repo.weekScorecard(mon, addDays(mon, 6))); }
    try { const n = await rollDripsToNurture(); if (n) setMsg(`${n} lead(s) reached day 30 and rolled into the monthly nurture.`); } catch { /* not fatal */ }
  }
  useEffect(() => { load().catch(e => setMsg(friendlyError(e))); }, [date]);

  // Small, targeted writes: each one updates only the slice of state it changed, so nothing else re-renders or reloads.
  const refreshLog = async () => setLog(await repo.dailyLog(date));
  const toggle = async (key: string, done: boolean) => { await repo.setDailyItem(date, key, { done }); await refreshLog(); };
  const setCount = async (key: string, count: number, target?: number) => { await repo.setDailyItem(date, key, { count, done: target ? count >= target : undefined }); await refreshLog(); };
  const note = async (key: string, text: string) => { await repo.setDailyItem(date, key, { note: text }); };
  const captureIdea = async () => { const t = ideaText.trim(); if (!t) return; await repo.addIdea(t); setIdeaText(''); setIdeas(await repo.listIdeas()); await toggle('act', true); };
  const logTouch = async () => {
    if (!touch.who && !touch.client_id) return;
    const client = touch.client_id ? Number(touch.client_id) : null;
    const who = touch.who || leads.find(l => l.id === client)?.first_name || birthdays.find(b => b.id === client)?.name || null;
    await repo.addTouch({ client_id: client, on_date: date, channel: touch.channel, kind: touch.kind, who });
    const list = await repo.listTouches(date); setTouches(list);
    await setCount('outreach', list.length, 10);
    setTouch({ who: '', channel: touch.channel, kind: list.filter(t => t.kind === 'gratitude').length < 3 ? 'gratitude' : 'business', client_id: '' });
  };
  const removeTouch = async (id: number) => { await repo.removeTouch(id); const l = await repo.listTouches(date); setTouches(l); await setCount('outreach', l.length, 10); };
  const logPost = async (platform: string, kind: 'reel' | 'post' | 'marketplace' | 'friend_add', face = false, n = 1) => {
    await repo.addPost({ on_date: date, platform, kind, face, count: n });
    const c = await repo.postCounts(date); setPosts(c);
    const totalPosts = Object.values(c).reduce((a, b) => a + b.posts, 0);
    if (kind !== 'friend_add') await setCount('posts', totalPosts, items.find(i => i.key === 'posts')?.countTarget);
    else await setCount('friend_adds', Math.min(...friendAddPlan().map(p => Math.min(p.target, c[p.platform.key]?.adds ?? 0))), 10);
  };
  const plan = async () => {
    const tx = txs.find(t => String(t.id) === ohForm.txId); if (!tx || !ohForm.date) return;
    await planOpenHouse(tx, ohForm.date, ohForm.start, ohForm.end); setMsg(`Open house planned for ${ohForm.date}: Marketplace task on Friday, clean-up task on Monday, calendar entry on the day.`);
    setOhs(await repo.listOpenHouses({ from: addDays(t0, -3), to: addDays(t0, 10) }));
  };
  const refreshOhs = async () => setOhs(await repo.listOpenHouses({ from: addDays(t0, -3), to: addDays(t0, 10) }));
  const markIdea = async (id: number, patch: Parameters<typeof repo.updateIdea>[1]) => { await repo.updateIdea(id, patch); setIdeas(await repo.listIdeas()); };

  const clock = new Date().toLocaleTimeString('en-US', { hour12: false, timeZone: 'America/Denver' }).slice(0, 5);
  const m369 = manifestTarget(clock);
  const gratitude = touches.filter(t => t.kind === 'gratitude').length;
  const postsTotal = Object.values(posts).reduce((a, b) => a + b.posts, 0);
  const listings = txs.filter(t => t.side === 'seller' && t.status === 'active');
  const postsTarget = items.find(i => i.key === 'posts')?.countTarget ?? 3;

  const ctx: EngineCtx = { date, t0, log, items, txs, leads, birthdays, touches, ideas, ohs, posts, deadlines, postsTotal, gratitude, listings, m369Label: m369.label, ideaText, setIdeaText, touch, setTouch, ohForm, setOhForm, timerEndsAt, setTimerEndsAt, setAgent, toggle, setCount, note, captureIdea, logTouch, removeTouch, logPost, plan, refreshOhs, markIdea };

  return (
    <div className="p-8 space-y-6 max-w-6xl">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-2xl font-semibold">Daily Engine</h1>
          <p className="mt-1 text-sm text-ink/60">{dayLabel(date)} · {meta.title}. {meta.note}</p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <button onClick={() => setDate(addDays(date, -1))} className="rounded-md border border-ink/15 bg-white px-2 py-1">‹</button>
          <button onClick={() => setDate(t0)} className="rounded-md border border-ink/15 bg-white px-3 py-1">Today</button>
          <button onClick={() => setDate(addDays(date, 1))} className="rounded-md border border-ink/15 bg-white px-2 py-1">›</button>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-3 text-sm">
        <Stat label="Core today" value={`${core.done} / ${core.total}`} tone={core.complete ? 'good' : 'neutral'} sub={core.complete ? 'Done. Anything else is extra.' : `Morning block ${s.morningStart}-${s.morningEnd}`} />
        <Stat label="Streak" value={`${streakInfo.days} day${streakInfo.days === 1 ? '' : 's'}`} tone={streakInfo.days ? 'good' : 'neutral'} sub={streakInfo.holes ? `${streakInfo.holes} hole(s), allowed` : 'holes are allowed'} />
        <Stat label="Outreach" value={`${touches.length} / 10`} tone={touches.length >= 10 ? 'good' : 'neutral'} sub={`gratitude ${gratitude} / 3`} />
        <Stat label="Posted" value={`${postsTotal} / ${postsTarget}`} tone={postsTotal >= postsTarget ? 'good' : 'neutral'} sub="across platforms, under the caps" />
      </div>
      {msg && <div className="text-xs text-ink/60">{msg}</div>}
      {score && (
        <div className="rounded-lg border border-ink/10 bg-white px-4 py-2 text-xs">
          <span className="font-medium">This week:</span> {score.core_days} core days · {score.touches} touches ({score.gratitude} gratitude) · {score.posts} posts ({score.face} with your face) · {score.leads} new leads · {score.listings_taken} listings taken · {score.under_contract} under contract · {score.closed} closed · {score.price_reviews} price reviews done
        </div>
      )}

      {reset ? (
        <div className="rounded-lg border border-ink/10 bg-white p-6 text-sm">
          <div className="text-lg font-semibold">Reset day</div>
          <p className="mt-2 text-ink/70">{RECOVERY.ceiling} Today is the stop that keeps the streak alive: family, no work. Overflow moves to Monday.</p>
          <p className="mt-2 text-xs text-ink/50">Change the reset day in Settings.</p>
        </div>
      ) : (
        <div className="grid grid-cols-[1fr_380px] gap-6 items-start">
          <div className="space-y-5">
            <Block title={BLOCK_NOTES.reset.title} note={BLOCK_NOTES.reset.note}>{items.filter(i => i.block === 'reset').map(i => <Check key={i.key} it={i} c={ctx} />)}</Block>
            <Block title={BLOCK_NOTES.volume.title} note={BLOCK_NOTES.volume.note}>{items.filter(i => i.block === 'volume').map(i => <Check key={i.key} it={i} c={ctx} />)}</Block>
            <Block title={meta.title} note={core.complete ? meta.note : `Locked behind the core list: ${RECOVERY.ceiling}`} dim={!core.complete}>
              {items.filter(i => i.block === 'day').map(i => (
                <li key={i.key} className={`px-4 py-2.5 ${log[i.key]?.done_at ? 'bg-emerald-50/50' : ''}`}>
                  <div className="flex items-start gap-3">
                    <input type="checkbox" checked={!!log[i.key]?.done_at} onChange={e => toggle(i.key, e.target.checked)} className="mt-1" />
                    <div className="min-w-0 flex-1">
                      <div className={`text-sm ${log[i.key]?.done_at ? 'text-ink/50 line-through' : 'font-medium'}`}>{i.title}{i.countTarget ? <span className="ml-2 text-xs font-normal text-ink/50">{log[i.key]?.count ?? 0} / {i.countTarget}</span> : null}</div>
                      <DayData it={i} c={ctx} />
                    </div>
                  </div>
                </li>
              ))}
            </Block>
            {date < t0 && !core.complete && <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">{RECOVERY.missed_today} {RECOVERY.missed_weekday_task} {RECOVERY.week_collapsed}</div>}
          </div>
          <aside className="space-y-4">
            <AgentPanel initial={agent?.key ?? 'coordinator'} prefill={agent?.prefill} compact />
            <div className="rounded-lg border border-ink/10 bg-white p-3 text-xs text-ink/60">
              <div className="font-medium text-ink">When it goes sideways</div>
              <ul className="mt-1 list-disc pl-4 space-y-0.5">{FAILURE_MODES.map(f => <li key={f}>{f}</li>)}</ul>
              <div className="mt-2">{RECOVERY.ceiling}</div>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

/* ---------- everything the sub-components need, passed once ---------- */
interface EngineCtx {
  date: string; t0: string; log: Log; items: EngineItem[]; txs: TxRow[]; leads: Client[]; birthdays: Birthdays; touches: Touches; ideas: IdeaRow[]; ohs: OpenHouseRow[]; posts: PostCounts;
  deadlines: Array<repo.DeadlineRow & { first_name: string; last_name: string; street: string | null }>;
  postsTotal: number; gratitude: number; listings: TxRow[]; m369Label: string;
  ideaText: string; setIdeaText: Dispatch<SetStateAction<string>>; touch: TouchForm; setTouch: Dispatch<SetStateAction<TouchForm>>; ohForm: OhForm; setOhForm: Dispatch<SetStateAction<OhForm>>;
  timerEndsAt: { key: string; endsAt: number } | null; setTimerEndsAt: Dispatch<SetStateAction<{ key: string; endsAt: number } | null>>;
  setAgent: (a: { key: AgentKey; prefill?: string }) => void;
  toggle: (key: string, done: boolean) => Promise<void>; setCount: (key: string, count: number, target?: number) => Promise<void>; note: (key: string, text: string) => Promise<void>;
  captureIdea: () => Promise<void>; logTouch: () => Promise<void>; removeTouch: (id: number) => Promise<void>;
  logPost: (platform: string, kind: 'reel' | 'post' | 'marketplace' | 'friend_add', face?: boolean, n?: number) => Promise<void>;
  plan: () => Promise<void>; refreshOhs: () => Promise<void>; markIdea: (id: number, patch: Parameters<typeof repo.updateIdea>[1]) => Promise<void>;
}

/** The only thing that ticks. Re-renders itself once a second; the rest of the page stays put. */
function Countdown({ endsAt, onStop }: { endsAt: number; onStop: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const h = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(h); }, []);
  const remaining = Math.max(0, Math.round((endsAt - now) / 1000));
  return (
    <div className="mt-1 flex items-center gap-2 text-xs">
      <span className="tabular-nums font-medium">{Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}{remaining === 0 ? ' · done, now act on what surfaced' : ''}</span>
      <button onClick={onStop} className="rounded border border-ink/15 px-2 py-0.5">Stop</button>
    </div>
  );
}

function Check({ it, c }: { it: EngineItem; c: EngineCtx }) {
  const row = c.log[it.key]; const done = !!row?.done_at;
  return (
    <li className={`px-4 py-2.5 ${done ? 'bg-emerald-50/50' : ''}`}>
      <div className="flex items-start gap-3">
        <input type="checkbox" checked={done} onChange={e => c.toggle(it.key, e.target.checked)} className="mt-1" />
        <div className="min-w-0 flex-1">
          <div className={`text-sm ${done ? 'text-ink/50 line-through' : 'font-medium'}`}>{it.title}{it.minutes ? <span className="ml-2 text-xs font-normal text-ink/40">{it.minutes} min</span> : null}</div>
          {it.how && <div className="mt-0.5 text-xs text-ink/60">{it.how}</div>}
          {it.key === 'manifest_369' && <div className="mt-1 text-xs text-brand">{c.m369Label}</div>}
          {it.timer && (c.timerEndsAt?.key === it.key
            ? <Countdown endsAt={c.timerEndsAt.endsAt} onStop={() => c.setTimerEndsAt(null)} />
            : <div className="mt-1 text-xs"><button onClick={() => c.setTimerEndsAt({ key: it.key, endsAt: Date.now() + (it.minutes ?? 30) * 60_000 })} className="rounded border border-ink/15 px-2 py-0.5">Start {it.minutes}-minute timer</button></div>)}
          {it.capture === 'idea' && (
            <div className="mt-1 flex gap-2"><input value={c.ideaText} onChange={e => c.setIdeaText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void c.captureIdea(); }} placeholder="What surfaced? Capture it, then do it." className="flex-1 rounded border border-ink/15 px-2 py-1 text-xs" /><button onClick={c.captureIdea} className="rounded bg-ink px-2 py-1 text-xs text-white">Capture</button></div>
          )}
          {it.countTarget && !it.platforms && it.key !== 'outreach' && (
            <div className="mt-1 flex items-center gap-2 text-xs"><button onClick={() => c.setCount(it.key, Math.max(0, (row?.count ?? 0) - 1), it.countTarget)} className="rounded border border-ink/15 px-2">−</button><span className="tabular-nums">{row?.count ?? 0} / {it.countTarget}</span><button onClick={() => c.setCount(it.key, (row?.count ?? 0) + 1, it.countTarget)} className="rounded border border-ink/15 px-2">+</button></div>
          )}
          {it.note && <input defaultValue={row?.note ?? ''} onBlur={e => c.note(it.key, e.target.value)} placeholder="Today's 1%…" className="mt-1 w-full rounded border border-ink/15 px-2 py-1 text-xs" />}
          {it.key === 'posts' && <PostsPanel target={it.countTarget ?? 3} c={c} />}
          {it.key === 'friend_adds' && <AddsPanel c={c} />}
          {it.key === 'outreach' && <OutreachPanel c={c} />}
          {it.key === 'marketplace' && <div className="mt-1 text-xs"><button onClick={() => c.logPost('marketplace', 'marketplace')} className="rounded border border-ink/15 px-2 py-0.5">Log a Marketplace post</button> <span className="text-ink/50">{c.posts.marketplace?.posts ?? 0} today</span></div>}
        </div>
      </div>
    </li>
  );
}

function PostsPanel({ target, c }: { target: number; c: EngineCtx }) {
  const sched = reelSchedule(target);
  return (
    <div className="mt-2 rounded-md border border-ink/10 bg-paper p-2 text-xs">
      <div className="flex items-center justify-between"><span className="font-medium">{c.postsTotal} / {target} posted · {Object.values(c.posts).reduce((a, b) => a + b.face, 0)} with your face</span><span className="text-ink/50">{target >= 10 ? 'one per hour from 08:00' : 'spread through the day'}</span></div>
      <ol className="mt-1 grid grid-cols-2 gap-x-4">
        {sched.map(sl => <li key={sl.slot} className="flex items-center justify-between py-0.5"><span className="tabular-nums text-ink/60">{sl.time}</span><span>{sl.platform.name}</span><button onClick={() => c.logPost(sl.platform.key, 'reel', true)} className="rounded border border-ink/15 px-1.5">posted</button></li>)}
      </ol>
      <div className="mt-2 grid grid-cols-3 gap-1">
        {PLATFORMS.filter(p => p.key !== 'marketplace').map(p => { const r = platformRoom(p, c.posts[p.key]?.posts ?? 0, c.posts[p.key]?.adds ?? 0); return <div key={p.key} className={`rounded px-1.5 py-0.5 ${r.warn ? 'bg-red-100 text-red-800' : 'bg-white'}`} title={p.notes}>{p.name}: {c.posts[p.key]?.posts ?? 0}/{p.posts_per_day_max}{r.warn ? ' over' : ''}</div>; })}
      </div>
      <div className="mt-1 text-ink/50">Caps keep you under each platform's throttle (YouTube Shorts: 2, Instagram and Facebook: 3, TikTok: 6). Hover a platform for its rule.</div>
    </div>
  );
}

function AddsPanel({ c }: { c: EngineCtx }) {
  return (
    <div className="mt-2 grid grid-cols-2 gap-1 text-xs">
      {friendAddPlan().map(({ platform, target }) => { const done = c.posts[platform.key]?.adds ?? 0; const r = platformRoom(platform, 0, done); return <div key={platform.key} className={`flex items-center justify-between rounded border px-2 py-1 ${r.warn ? 'border-red-300 bg-red-50' : 'border-ink/10 bg-paper'}`}><span>{platform.name} <span className="text-ink/50">{done}/{target} (cap {platform.friend_adds_per_day_max})</span></span><span className="flex gap-1"><button onClick={() => c.logPost(platform.key, 'friend_add', false, 1)} className="rounded border border-ink/15 px-1.5">+1</button><button onClick={() => c.logPost(platform.key, 'friend_add', false, 5)} className="rounded border border-ink/15 px-1.5">+5</button></span></div>; })}
    </div>
  );
}

function OutreachPanel({ c }: { c: EngineCtx }) {
  const { touch, setTouch } = c;
  return (
    <div className="mt-2 rounded-md border border-ink/10 bg-paper p-2 text-xs space-y-2">
      <div className="flex items-center justify-between"><span className="font-medium">{c.touches.length} / 10 · gratitude {c.gratitude} / 3</span><button onClick={() => c.setAgent({ key: 'followup', prefill: 'Build today\'s 10 touches.' })} className="rounded border border-ink/15 px-2 py-0.5">Ask the Follow-up Agent to draft them</button></div>
      {c.birthdays.length > 0 && <div><span className="text-ink/60">Birthdays: </span>{c.birthdays.map(b => <button key={b.id + b.on} onClick={() => setTouch({ ...touch, client_id: String(b.id), who: b.name, channel: b.preferred_channel ?? 'text', kind: 'gratitude' })} className="mr-1 rounded-full bg-amber-100 px-2 py-0.5 text-amber-900">{b.name}{b.on !== c.date ? ` (${b.on.slice(5)})` : ''}</button>)}</div>}
      <div className="flex flex-wrap gap-1">
        <select value={touch.client_id} onChange={e => { const l = c.leads.find(x => String(x.id) === e.target.value); setTouch({ ...touch, client_id: e.target.value, who: l ? `${l.first_name} ${l.last_name}` : touch.who, channel: l?.preferred_channel ?? touch.channel }); }} className="rounded border border-ink/15 px-1 py-0.5"><option value="">pipeline…</option>{c.leads.map(l => <option key={l.id} value={l.id}>{l.first_name} {l.last_name} · {l.stage}{l.last_touch_on ? ` · last ${l.last_touch_on}` : ''}</option>)}</select>
        <input value={touch.who} onChange={e => setTouch({ ...touch, who: e.target.value })} placeholder="or a name" className="w-32 rounded border border-ink/15 px-2 py-0.5" />
        <select value={touch.channel} onChange={e => setTouch({ ...touch, channel: e.target.value })} className="rounded border border-ink/15 px-1 py-0.5">{CHANNELS.map(ch => <option key={ch}>{ch}</option>)}</select>
        <select value={touch.kind} onChange={e => setTouch({ ...touch, kind: e.target.value as 'gratitude' | 'business' })} className="rounded border border-ink/15 px-1 py-0.5"><option value="gratitude">gratitude / compliment</option><option value="business">business</option></select>
        <button onClick={c.logTouch} className="rounded bg-ink px-2 py-0.5 text-white">Log touch</button>
      </div>
      {c.touches.length > 0 && <ul className="flex flex-wrap gap-1">{c.touches.map(t => <li key={t.id} className={`rounded-full px-2 py-0.5 ${t.kind === 'gratitude' ? 'bg-amber-100 text-amber-900' : 'bg-white border border-ink/10'}`}>{t.who ?? `${t.first_name} ${t.last_name}`} · {t.channel} <button onClick={() => c.removeTouch(t.id)} className="text-ink/40">×</button></li>)}</ul>}
    </div>
  );
}

function People({ list, c }: { list: Client[]; c: EngineCtx }) {
  return <ul className="mt-1 text-xs">{list.map(l => <li key={l.id} className="flex items-center gap-2"><Link to={`/clients/${l.id}`} className="hover:underline">{l.first_name} {l.last_name}</Link><span className="text-ink/50">{l.preferred_channel ?? 'channel?'}{l.last_touch_on ? ` · last touch ${l.last_touch_on}` : ' · never touched'}</span><button onClick={() => c.setTouch({ who: `${l.first_name} ${l.last_name}`, channel: l.preferred_channel ?? 'text', kind: 'business', client_id: String(l.id) })} className="rounded border border-ink/15 px-1.5">touch</button></li>)}{!list.length && <li className="text-ink/50">Nobody in the pipeline with this interest. Add leads on the Clients page.</li>}</ul>;
}

function DayData({ it, c }: { it: EngineItem; c: EngineCtx }) {
  const { t0, date, ohForm, setOhForm } = c;
  switch (it.data) {
    case 'deadlines_7d': return <ul className="mt-1 text-xs">{c.deadlines.map(d => <li key={d.id} className={d.due_on < t0 ? 'text-red-700' : ''}><Link to={`/clients/${c.txs.find(t => t.id === d.transaction_id)?.client_id ?? ''}`} className="hover:underline">{d.due_on} {d.due_time} · {d.label} · {d.last_name}, {d.first_name} · {d.street ?? ''}</Link></li>)}{!c.deadlines.length && <li className="text-ink/50">No deadlines in the next 7 days.</li>}</ul>;
    case 'potential_listings': return <People list={c.leads.filter(l => l.interest === 'seller' || l.interest === 'both')} c={c} />;
    case 'potential_buyers': return <People list={c.leads.filter(l => l.interest === 'buyer' || l.interest === 'both')} c={c} />;
    case 'active_listings': return <ul className="mt-1 text-xs">{c.listings.map(l => <li key={l.id} className="flex items-center gap-2"><Link to={`/clients/${l.client_id}`} className="hover:underline">{l.street}{l.city ? ', ' + l.city : ''} · {l.last_name}</Link>{l.list_price ? <span className="text-ink/50">{money(l.list_price)}</span> : null}<button onClick={() => c.setAgent({ key: 'listing', prefill: `Write this week's ${it.key === 'tue_market_updates' ? 'market update with the three pricing options' : 'seller update'} for ${l.street}${l.city ? ', ' + l.city : ''} (${l.first_name} ${l.last_name}). List price ${l.list_price ? money(l.list_price) : '[list price]'}, days on market [n], showings this week [n], feedback [..].` })} className="rounded border border-ink/15 px-1.5">draft</button></li>)}{!c.listings.length && <li className="text-ink/50">No active listings.</li>}</ul>;
    case 'open_houses_held': return <ul className="mt-1 text-xs">{c.ohs.filter(o => o.on_date < t0 && o.status !== 'cleaned').map(o => <li key={o.id}>{o.on_date} · {o.street} <button onClick={async () => { await repo.setOpenHouseStatus(o.id, 'cleaned'); await c.refreshOhs(); }} className="rounded border border-ink/15 px-1.5">wording stripped</button></li>)}{!c.ohs.some(o => o.on_date < t0 && o.status !== 'cleaned') && <li className="text-ink/50">Nothing held this weekend.</li>}</ul>;
    case 'open_house_planner': return (
      <div className="mt-1 space-y-1 text-xs">
        <div className="flex flex-wrap gap-1 items-center">
          <select value={ohForm.txId} onChange={e => setOhForm({ ...ohForm, txId: e.target.value })} className="rounded border border-ink/15 px-1 py-0.5"><option value="">pick a listing…</option>{c.listings.map(l => <option key={l.id} value={l.id}>{l.street}{l.city ? ', ' + l.city : ''}</option>)}</select>
          <input type="date" value={ohForm.date} onChange={e => setOhForm({ ...ohForm, date: e.target.value })} className="rounded border border-ink/15 px-1 py-0.5" />
          <input type="time" value={ohForm.start} onChange={e => setOhForm({ ...ohForm, start: e.target.value })} className="rounded border border-ink/15 px-1 py-0.5" />
          <input type="time" value={ohForm.end} onChange={e => setOhForm({ ...ohForm, end: e.target.value })} className="rounded border border-ink/15 px-1 py-0.5" />
          <button onClick={c.plan} disabled={!ohForm.txId} className="rounded bg-ink px-2 py-0.5 text-white disabled:opacity-40">Plan it</button>
        </div>
        <ul>{c.ohs.filter(o => o.on_date >= t0).map(o => <li key={o.id} className="flex items-center gap-2">{o.on_date} {o.start_time}-{o.end_time} · {o.street} · <span className="text-ink/50">{o.status}</span><button onClick={async () => { await cancelOpenHouse(o); await c.refreshOhs(); }} className="text-ink/40">cancel</button></li>)}</ul>
        <div className="text-ink/50">Saturday is the default; verify Sunday does not outperform it in your market (Settings).</div>
      </div>);
    case 'open_houses_upcoming': case 'open_houses_today': return <ul className="mt-1 text-xs">{c.ohs.filter(o => o.on_date >= t0).map(o => <li key={o.id}>{o.on_date} {o.start_time}-{o.end_time} · {o.street} · {o.status}{it.data === 'open_houses_upcoming' && o.status === 'planned' && <button onClick={async () => { await repo.setOpenHouseStatus(o.id, 'posted'); await c.refreshOhs(); }} className="ml-2 rounded border border-ink/15 px-1.5">posted</button>}{it.data === 'open_houses_today' && o.on_date === date && <button onClick={async () => { await repo.setOpenHouseStatus(o.id, 'held'); await c.refreshOhs(); }} className="ml-2 rounded border border-ink/15 px-1.5">held</button>}</li>)}{!c.ohs.some(o => o.on_date >= t0) && <li className="text-ink/50">No open houses planned. Wednesday plans them.</li>}</ul>;
    case 'idea_queue': return (
      <div className="mt-1 text-xs space-y-1">
        <div className="flex items-center justify-between"><span>{c.ideas.filter(i => i.status === 'queued').length} queued · {c.ideas.filter(i => i.built_on === date).length} built today</span><button onClick={() => c.setAgent({ key: 'content', prefill: 'Turn my idea queue into Thursday\'s 10 reels: hook type, one-sentence hook, on-screen text, first shot, platform slot.' })} className="rounded border border-ink/15 px-2 py-0.5">Hooks from the Content Agent</button></div>
        <ul>{c.ideas.filter(i => i.status === 'queued' || i.built_on === date).map(i => <li key={i.id} className="flex items-center gap-2"><span className={i.status === 'built' ? 'text-ink/50 line-through' : ''}>{i.text}</span>{i.status === 'queued' ? <button onClick={async () => { await c.markIdea(i.id, { status: 'built', built_on: date }); await c.setCount('thu_reels', c.ideas.filter(x => x.built_on === date).length + 1, 10); }} className="rounded border border-ink/15 px-1.5">built</button> : null}<button onClick={() => c.markIdea(i.id, { status: 'dropped' })} className="text-ink/40">drop</button></li>)}</ul>
        <div className="flex gap-1"><input value={c.ideaText} onChange={e => c.setIdeaText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void c.captureIdea(); }} placeholder="Add an idea" className="flex-1 rounded border border-ink/15 px-2 py-0.5" /><button onClick={c.captureIdea} className="rounded bg-ink px-2 py-0.5 text-white">Add</button></div>
      </div>);
    case 'reel_schedule': return (
      <ol className="mt-1 grid grid-cols-2 gap-x-4 text-xs">{reelSchedule(10).map(sl => { const built = c.ideas.filter(i => i.status === 'built'); const idea = built[sl.slot - 1]; return <li key={sl.slot} className="flex items-center justify-between py-0.5"><span className="tabular-nums text-ink/60">{sl.time}</span><span className="truncate px-2">{idea?.text ?? '(any reel)'}</span><span className="text-ink/50">{sl.platform.name}</span><button onClick={async () => { if (idea) await c.markIdea(idea.id, { status: 'posted', posted_on: date, platform: sl.platform.key }); await c.logPost(sl.platform.key, 'reel', true); await c.setCount('fri_post_reels', (c.log.fri_post_reels?.count ?? 0) + 1, 10); }} className="ml-1 rounded border border-ink/15 px-1.5">posted</button></li>; })}</ol>);
    default: return null;
  }
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: 'good' | 'neutral' }) {
  return <div className={`rounded-lg border p-3 ${tone === 'good' ? 'border-emerald-200 bg-emerald-50' : 'border-ink/10 bg-white'}`}><div className="text-xs text-ink/50">{label}</div><div className="text-xl font-semibold tabular-nums">{value}</div>{sub && <div className="text-xs text-ink/50">{sub}</div>}</div>;
}
function Block({ title, note, dim, children }: { title: string; note?: string; dim?: boolean; children: React.ReactNode }) {
  return <div className={`rounded-lg border border-ink/10 bg-white ${dim ? 'opacity-60' : ''}`}><div className="border-b border-ink/5 px-4 py-2.5"><div className="font-medium">{title}</div>{note && <div className="text-xs text-ink/50">{note}</div>}</div><ol className="divide-y divide-ink/5">{children}</ol></div>;
}
