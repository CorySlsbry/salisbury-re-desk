import { useEffect, useState } from 'react';
import { listInbox, type InboxRow } from '../lib/repoCrm';
import { addInboxAsClient, dismissInbox, crmStatus } from '../lib/crm';
import { friendlyError } from '../lib/errors';
import { Link, useNavigate } from 'react-router-dom';
import { listClients, listTransactions, upsertClient, updateClient, type Client, type TxRow } from '../lib/repo';
import { native } from '../lib/native';
import { setClientFolder } from '../lib/repo';
import { folderName } from '../lib/intake';
import { enroll, markReplied } from '../lib/leads';

const STAGES: Array<[Client['stage'] | 'all', string]> = [['all', 'Everyone'], ['lead', 'Leads (30-day drip)'], ['nurture', 'Nurture (monthly)'], ['client', 'Clients'], ['past', 'Past clients'], ['lost', 'Lost']];
const CHANNELS = ['text', 'call', 'email', 'facebook', 'instagram', 'other'];

export default function Clients() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [stage, setStage] = useState<Client['stage'] | 'all'>('all');
  const [rows, setRows] = useState<Client[]>([]);
  const [txs, setTxs] = useState<TxRow[]>([]);
  const [adding, setAdding] = useState<null | 'client' | 'lead'>(null);
  const [form, setForm] = useState({ first_name: '', last_name: '', phone: '', email: '', source: 'referral', preferred_channel: 'text', birthday: '', interest: 'seller' });
  const [msg, setMsg] = useState('');

  const [inbox, setInbox] = useState<InboxRow[]>([]);
  const [crmOn, setCrmOn] = useState(false);
  const [inboxMsg, setInboxMsg] = useState('');
  async function load() { setRows((await listClients(q)).filter(c => stage === 'all' || c.stage === stage)); setTxs(await listTransactions()); try { setInbox(await listInbox('new')); setCrmOn((await crmStatus()).connected); } catch { /* migration not yet applied */ } }
  async function takeInbox(id: string, action: 'add' | 'dismiss') { try { if (action === 'add') { const cid = await addInboxAsClient(id); setInboxMsg(`Added as a lead (client #${cid}); the website lead is marked worked.`); } else { await dismissInbox(id); setInboxMsg('Dismissed.'); } await load(); } catch (e) { setInboxMsg(friendlyError(e)); } }
  useEffect(() => { load().catch(() => {}); }, [q, stage]);

  async function add() {
    if (!form.first_name || !form.last_name) return;
    const isLead = adding === 'lead';
    const id = await upsertClient({ ...form, birthday: form.birthday || null, stage: isLead ? 'lead' : 'client', interest: form.interest, preferred_channel: form.preferred_channel });
    const folder = await native.createClientFolder(folderName({ clientLast: form.last_name, clientFirst: form.first_name, street: isLead ? 'Lead' : 'new', city: '' }));
    await setClientFolder(id, folder);
    if (isLead) { await enroll(id, 'new_lead_30'); setMsg(`${form.first_name} is on the 30-day drip: 6 copy-ready emails and 6 human touches, weekdays only. It pauses the moment they reply.`); }
    setAdding(null); setForm({ first_name: '', last_name: '', phone: '', email: '', source: 'referral', preferred_channel: 'text', birthday: '', interest: 'seller' });
    if (!isLead) nav(`/clients/${id}`); else await load();
  }

  const byClient = new Map<number, TxRow[]>();
  for (const t of txs) { if (!byClient.has(t.client_id)) byClient.set(t.client_id, []); byClient.get(t.client_id)!.push(t); }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between">
        <div><h1 className="text-2xl font-semibold">Clients and leads</h1><p className="mt-1 text-sm text-ink/60">{rows.length} shown</p></div>
        <div className="flex gap-2">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, phone, email" className="rounded-md border border-ink/15 bg-white px-3 py-2 text-sm w-64" />
          <button onClick={() => setAdding('lead')} className="rounded-md bg-ink px-4 py-2 text-sm text-white">New lead</button>
          <button onClick={() => setAdding('client')} className="rounded-md border border-ink/15 bg-white px-4 py-2 text-sm">New client</button>
          <Link to="/intake" className="rounded-md bg-brand px-4 py-2 text-sm text-white">Intake a contract</Link>
        </div>
      </div>
      {(inbox.length > 0 || (crmOn && inboxMsg)) && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
          <div className="flex items-center justify-between"><div className="font-medium">From salisburyre.com: {inbox.length} new lead{inbox.length === 1 ? '' : 's'} / contact{inbox.length === 1 ? '' : 's'}</div><span className="text-xs text-ink/50">Pat's rule: first touch within the hour, then the 30-day drip</span></div>
          <ul className="mt-2 divide-y divide-amber-200/60">
            {inbox.slice(0, 12).map(r => (
              <li key={r.crm_id} className="flex flex-wrap items-center gap-2 py-1.5 text-xs">
                <span className="font-medium">{r.name ?? '(no name)'}</span>
                <span className="text-ink/60">{[r.email, r.phone].filter(Boolean).join(' · ')}</span>
                <span className="text-ink/50">{r.kind === 'lead' ? `website lead${r.magnet ? ': ' + r.magnet : ''}` : `CRM contact${r.source ? ': ' + r.source : ''}`}{r.received_at ? ` · ${r.received_at.slice(0, 10)}` : ''}</span>
                <span className="ml-auto flex gap-1"><button onClick={() => takeInbox(r.crm_id, 'add')} className="rounded bg-ink px-2 py-0.5 text-white">Add as lead</button><button onClick={() => takeInbox(r.crm_id, 'dismiss')} className="rounded border border-ink/15 px-2 py-0.5">Dismiss</button></span>
              </li>
            ))}
          </ul>
          {inbox.length > 12 && <div className="mt-1 text-xs text-ink/50">{inbox.length - 12} more after these.</div>}
          {inboxMsg && <div className="mt-1 text-xs text-ink/70">{inboxMsg}</div>}
        </div>
      )}
      <div className="mt-4 flex gap-1.5">{STAGES.map(([k, l]) => <button key={k} onClick={() => setStage(k)} className={`rounded-full border px-3 py-1 text-xs ${stage === k ? 'bg-ink text-white border-ink' : 'bg-white border-ink/15'}`}>{l}</button>)}</div>
      {msg && <div className="mt-2 text-xs text-ink/60">{msg}</div>}
      {adding && (
        <div className="mt-4 rounded-lg border border-ink/10 bg-white p-4 grid grid-cols-4 gap-3 text-sm">
          <div className="col-span-4 text-xs text-ink/60">{adding === 'lead' ? 'A lead starts Pat\'s 30-day drip today. Preferred channel and birthday make "reach out to 10" a lookup instead of a decision.' : 'A client without a signed agreement yet.'}</div>
          {(['first_name', 'last_name', 'phone', 'email'] as const).map(k => <input key={k} placeholder={k.replace('_', ' ')} value={form[k]} onChange={e => setForm({ ...form, [k]: e.target.value })} className="rounded-md border border-ink/15 px-3 py-2" />)}
          <select value={form.source} onChange={e => setForm({ ...form, source: e.target.value })} className="rounded-md border border-ink/15 px-3 py-2">{['referral', 'website', 'open_house', 'fsbo', 'expired', 'sphere', 'social', 'door_hanger', 'other'].map(s => <option key={s}>{s}</option>)}</select>
          <select value={form.interest} onChange={e => setForm({ ...form, interest: e.target.value })} className="rounded-md border border-ink/15 px-3 py-2"><option value="seller">wants to sell</option><option value="buyer">wants to buy</option><option value="both">both</option><option value="unknown">unknown</option></select>
          <select value={form.preferred_channel} onChange={e => setForm({ ...form, preferred_channel: e.target.value })} className="rounded-md border border-ink/15 px-3 py-2">{CHANNELS.map(c => <option key={c} value={c}>prefers {c}</option>)}</select>
          <input type="date" value={form.birthday} onChange={e => setForm({ ...form, birthday: e.target.value })} title="Birthday" className="rounded-md border border-ink/15 px-3 py-2" />
          <div className="col-span-4 flex gap-2"><button onClick={add} className="rounded-md bg-brand px-4 py-2 text-white">{adding === 'lead' ? 'Save and start the drip' : 'Save'}</button><button onClick={() => setAdding(null)} className="rounded-md border px-4 py-2">Cancel</button></div>
        </div>
      )}
      <table className="mt-6 w-full text-sm">
        <thead><tr className="text-left text-xs uppercase tracking-wide text-ink/50 border-b border-ink/10"><th className="py-2">Name</th><th>Stage</th><th>Contact</th><th>Channel · last touch</th><th>Transactions</th><th></th></tr></thead>
        <tbody>
          {rows.map(c => (
            <tr key={c.id} className="border-b border-ink/5 hover:bg-white cursor-pointer" onClick={() => nav(`/clients/${c.id}`)}>
              <td className="py-3 font-medium">{c.last_name}, {c.first_name}{c.second_first_name ? ` & ${c.second_first_name}` : ''}</td>
              <td><span className={`rounded-full px-2 py-0.5 text-xs ${c.stage === 'lead' ? 'bg-amber-100 text-amber-900' : c.stage === 'nurture' ? 'bg-sky-100 text-sky-900' : 'bg-ink/5'}`}>{c.stage}{c.interest && c.interest !== 'unknown' ? ` · ${c.interest}` : ''}</span></td>
              <td className="text-ink/70">{[c.phone, c.email].filter(Boolean).join(' · ') || '—'}</td>
              <td className="text-ink/70">{c.preferred_channel ?? '—'}{c.last_touch_on ? ` · ${c.last_touch_on}` : ''}{c.replied_at ? ' · replied' : ''}</td>
              <td className="text-ink/70">{(byClient.get(c.id) ?? []).map(t => `${t.side} · ${t.street ?? 'no property'} · ${t.status.replace('_', ' ')}`).join('; ') || '—'}</td>
              <td onClick={e => e.stopPropagation()}>
                {(c.stage === 'lead' || c.stage === 'nurture') && !c.replied_at && <button onClick={async () => { await markReplied(c.id); setMsg(`${c.first_name} replied: drip paused, "call within 5 minutes" is on today's list.`); await load(); }} className="rounded border border-ink/15 px-2 py-0.5 text-xs">Replied</button>}
                {c.stage === 'lead' && <button onClick={async () => { await updateClient(c.id, { stage: 'lost' }); await load(); }} className="ml-1 rounded border border-ink/15 px-2 py-0.5 text-xs text-ink/50">Lost</button>}
              </td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={6} className="py-10 text-center text-ink/50">Nobody here yet. Add a lead, or intake a signed contract.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
