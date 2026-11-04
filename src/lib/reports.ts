/**
 * Programmed reports: the answers the agents used to ask the model for, computed from the database instead.
 * Exact, instant, and every number traceable. Written for this app's tables; the pure selection and clock helpers are
 * unit-tested with fixture rows.
 */
import * as repo from './repo';
import { addDays, addBusinessDays, dayOfWeek } from './deadlines';
import { showingBenchmark } from './showings';
import { reelSchedule, PLATFORMS } from './engine';

/** Calendar days from a to b (ISO date strings). UTC-DAY-OK: pure date-string arithmetic, no clock involved. */
export function dayDiff(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number), [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}
export function mondayOf(date: string): string { const dow = dayOfWeek(date); return addDays(date, dow === 0 ? -6 : 1 - dow); }

/* ---------- at risk: Pat's Monday review, every day ---------- */
export interface AtRiskLine { kind: 'deadline' | 'task'; refId: number; txId: number | null; client: string; property: string | null; title: string; dueOn: string; dueTime: string | null; daysLeft: number; detail: string | null }
export interface BrokerClock { txId: number; client: string; property: string | null; clock: 'listing file' | 'contract file'; from: string; owedBy: string; daysLeft: number; late: boolean }
export interface PacketGapLine { txId: number; client: string; property: string | null; side: string; label: string; requiredWhen: string | null }
export interface AtRiskReport { today: string; days: number; overdue: AtRiskLine[]; next: AtRiskLine[]; later: number; clocks: BrokerClock[]; gaps: PacketGapLine[] }

const who = (r: { last_name: string | null; first_name: string | null }) => r.last_name ? `${r.last_name}, ${r.first_name ?? ''}`.trim() : 'no client';

/** Pure: the ICA 6.2 clocks for a file. Listing file 3 business days after signing; contract file 2 after binding. */
export function brokerClocks(tx: { id: number; side: string; agreement_signed_on: string | null; acceptance_on: string | null; broker_submitted_on?: string | null; last_name: string; first_name: string; street: string | null }, today: string): BrokerClock[] {
  if (tx.broker_submitted_on) return [];
  const out: BrokerClock[] = [];
  const mk = (clock: BrokerClock['clock'], from: string, n: number) => { const owedBy = addBusinessDays(from, n); const daysLeft = dayDiff(today, owedBy); out.push({ txId: tx.id, client: who(tx), property: tx.street, clock, from, owedBy, daysLeft, late: daysLeft < 0 }); };
  if (tx.acceptance_on) mk('contract file', tx.acceptance_on, 2);
  else if (tx.agreement_signed_on && tx.side === 'seller') mk('listing file', tx.agreement_signed_on, 3);
  return out;
}

export async function atRisk(days = 7): Promise<AtRiskReport> {
  const today = repo.today(); const horizon = addDays(today, days);
  const rows = await repo.atRiskRows();
  const lines: AtRiskLine[] = rows.map(r => ({ kind: r.kind, refId: r.ref_id, txId: r.transaction_id, client: who(r), property: r.street, title: r.title, dueOn: r.due_on, dueTime: r.due_time, daysLeft: dayDiff(today, r.due_on), detail: r.detail }));
  const overdue = lines.filter(l => l.dueOn < today);
  const next = lines.filter(l => l.dueOn >= today && l.dueOn <= horizon);
  const later = lines.filter(l => l.dueOn > horizon).length;
  const clocks: BrokerClock[] = [];
  for (const tx of await repo.listTransactions({ status: ['active', 'under_contract', 'pending'] })) clocks.push(...brokerClocks(tx, today));
  const gaps: PacketGapLine[] = (await repo.packetGapRows()).map(g => ({ txId: g.transaction_id, client: who(g), property: g.street, side: g.side, label: g.label, requiredWhen: g.required_when }));
  return { today, days, overdue, next, later, clocks, gaps };
}

/* ---------- seller update facts (Pat: every listing, every week, even a quiet one) ---------- */
export interface SellerUpdateFacts {
  txId: number; first: string; client: string; property: string; listPrice: number | null; daysOnMarket: number | null; signedOn: string | null;
  weekStart: string; showingsWeek: number; showingsTotal: number; benchmark: string; verdict: 'under' | 'on' | 'over'; priceReviewDue: boolean;
}
export async function sellerUpdateFacts(txId: number): Promise<SellerUpdateFacts> {
  const tx = await repo.getTransaction(txId); if (!tx) throw new Error('no transaction');
  const today = repo.today(); const weekStart = mondayOf(today);
  const b = await showingBenchmark(txId, weekStart);
  const daysOnMarket = tx.agreement_signed_on ? dayDiff(tx.agreement_signed_on, today) : null;
  return {
    txId, first: tx.first_name, client: `${tx.last_name}, ${tx.first_name}`, property: tx.street ? `${tx.street}${tx.city ? ', ' + tx.city : ''}` : 'your home',
    listPrice: tx.list_price, daysOnMarket, signedOn: tx.agreement_signed_on, weekStart, showingsWeek: b.week, showingsTotal: b.total, benchmark: b.benchmark, verdict: b.verdict,
    priceReviewDue: (daysOnMarket ?? 0) >= 21 && b.verdict === 'under',
  };
}
/** Pure: Pat's three options from the list price. Threshold = just under the next round $25k search step; decisive = 3% under. */
export function priceOptions(listPrice: number): { threshold: number; decisive: number; decisivePct: number } {
  const step = 25_000;
  const below = Math.floor((listPrice - 1) / step) * step;   // the round number strictly below the price (452,000 -> 450,000; 450,000 -> 425,000)
  const threshold = below - 100;                              // land just under it so the next search band sees the home: 449,900
  const decisive = Math.round((listPrice * 0.97) / 100) * 100;
  return { threshold, decisive, decisivePct: 3 };
}

/* ---------- today's ten touches (Pat's daily rule: three gratitude, seven light business, each in their channel) ---------- */
export interface TouchPick { clientId: number | null; name: string; first: string; channel: string; kind: 'gratitude' | 'business'; reason: string; phone: string | null; email: string | null }
export interface TouchPlan { date: string; done: number; target: number; gratitudeTarget: number; picks: TouchPick[] }
interface Person { id: number; first_name: string; last_name: string; stage: string; preferred_channel: string | null; phone: string | null; email: string | null; last_touch_on: string | null; do_not_contact: number; interest?: string | null }
const channelFor = (p: Person) => p.preferred_channel || (p.phone ? 'text' : p.email ? 'email' : 'call');
/** Pure: pick the day's touches from birthdays, cadence tasks and the longest-untouched people, never anyone already touched today. */
export function pickTouches(input: { today: string; birthdays: Array<{ id: number; name: string; on: string; preferred_channel: string | null; phone: string | null; email: string | null }>; dueTasks: Array<{ client_id: number | null; title: string; first_name: string | null; last_name: string | null }>; people: Person[]; touchedToday: Set<number>; target?: number; gratitudeTarget?: number }): TouchPick[] {
  const target = input.target ?? 10, gratitudeTarget = input.gratitudeTarget ?? 3;
  const picks: TouchPick[] = []; const used = new Set<number>(input.touchedToday);
  const take = (p: TouchPick) => { if (p.clientId != null) { if (used.has(p.clientId)) return; used.add(p.clientId); } picks.push(p); };
  for (const b of input.birthdays) take({ clientId: b.id, name: b.name, first: b.name.split(' ')[0], channel: b.preferred_channel || (b.phone ? 'text' : 'email'), kind: 'gratitude', reason: b.on === input.today ? 'It is their birthday today.' : `Birthday on ${b.on}.`, phone: b.phone, email: b.email });
  for (const t of input.dueTasks) { if (t.client_id == null) continue; const p = input.people.find(x => x.id === t.client_id); if (!p || p.do_not_contact) continue; take({ clientId: p.id, name: `${p.first_name} ${p.last_name}`, first: p.first_name, channel: channelFor(p), kind: 'business', reason: t.title, phone: p.phone, email: p.email }); }
  const rest = input.people.filter(p => !p.do_not_contact && !used.has(p.id)).sort((a, b) => (a.last_touch_on ?? '0000').localeCompare(b.last_touch_on ?? '0000'));
  for (const p of rest) {
    if (picks.length >= target) break;
    const gratitude = picks.filter(x => x.kind === 'gratitude').length < gratitudeTarget && (p.stage === 'past' || p.stage === 'client');
    const since = p.last_touch_on ? `${dayDiff(p.last_touch_on, input.today)} days since your last hello.` : 'You have not been in touch yet.';
    take({ clientId: p.id, name: `${p.first_name} ${p.last_name}`, first: p.first_name, channel: channelFor(p), kind: gratitude ? 'gratitude' : 'business', reason: gratitude ? 'A thank-you for trusting me with their home.' : since, phone: p.phone, email: p.email });
  }
  return picks.slice(0, target);
}
export async function touchesPlan(): Promise<TouchPlan> {
  const today = repo.today();
  const [birthdays, dueTasks, touched, people] = await Promise.all([repo.birthdaysWithin(3), repo.listTasks({ dueThrough: today }), repo.listTouches(today), repo.listPeople()]);
  const touchedToday = new Set(touched.map(t => t.client_id).filter((x): x is number => x != null));
  const picks = pickTouches({ today, birthdays, dueTasks: dueTasks.filter(t => t.cadence_step_id != null), people, touchedToday });
  return { date: today, done: touched.length, target: 10, gratitudeTarget: 3, picks };
}

/* ---------- complete file gaps per open file, with the owed-by clock ---------- */
export interface PacketGapsReport { today: string; files: Array<{ txId: number; client: string; first: string; property: string | null; side: string; missing: Array<{ label: string; requiredWhen: string | null }>; clock: BrokerClock | null }> }
export async function packetGaps(): Promise<PacketGapsReport> {
  const today = repo.today();
  const rows = await repo.packetGapRows();
  const txs = await repo.listTransactions({ status: ['active', 'under_contract', 'pending'] });
  const files = new Map<number, PacketGapsReport['files'][number]>();
  for (const r of rows) {
    const f = files.get(r.transaction_id) ?? { txId: r.transaction_id, client: who(r), first: r.first_name, property: r.street, side: r.side, missing: [], clock: txs.filter(t => t.id === r.transaction_id).flatMap(t => brokerClocks(t, today))[0] ?? null };
    f.missing.push({ label: r.label, requiredWhen: r.required_when });
    files.set(r.transaction_id, f);
  }
  return { today, files: [...files.values()] };
}

/* ---------- content plan: the reel slots and the idea bank ---------- */
export interface ContentPlan { date: string; ideas: Array<{ id: number; text: string; hook: string | null }>; slots: Array<{ slot: number; time: string; platform: string; cap: number }>; room: Array<{ platform: string; posted: number; cap: number }> }
export async function contentPlan(reels = 10): Promise<ContentPlan> {
  const today = repo.today();
  const [ideas, counts] = await Promise.all([repo.listIdeas('queued'), repo.postCounts(today)]);
  return {
    date: today,
    ideas: ideas.map(i => ({ id: i.id, text: i.text, hook: i.hook })),
    slots: reelSchedule(reels).map(s => ({ slot: s.slot, time: s.time, platform: s.platform.name, cap: s.platform.posts_per_day_max })),
    room: PLATFORMS.map(p => ({ platform: p.name, posted: counts[p.key]?.posts ?? 0, cap: p.posts_per_day_max })),
  };
}
