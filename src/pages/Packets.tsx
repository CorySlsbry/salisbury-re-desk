import { useEffect, useMemo, useState } from 'react';
import { openDocument } from '../lib/documents';
import { appPaths, native } from '../lib/native';
import packets from '../../templates/packets.json';
import exhibitB from '../../templates/exhibit-b.json';
import { listForms, syncFormsLibrary, type FormRow } from '../lib/forms';
import { listPacketTemplates, listPacketTemplateItems, addPacketTemplateItem, removePacketTemplateItem, movePacketTemplateItem, updatePacketTemplateItem, resetPacketTemplate, logEvent, type PacketTemplate, type PacketTemplateItem } from '../lib/repo';
import { proposePacket, classifyForm, linkFormsByRules, type Proposal, type PacketSide } from '../lib/packetAi';
import { friendlyError } from '../lib/errors';

const WHEN: Array<[string, string]> = [['always', 'always'], ['under_contract', 'under contract'], ['pre1978', 'pre-1978'], ['hoa', 'HOA'], ['if_applicable', 'if applicable']];
const SIDE_LABEL: Record<PacketSide, string> = { seller: 'Seller packet', buyer: 'Buyer packet', closing: 'Closing (both sides)' };

export default function Packets() {
  const [templates, setTemplates] = useState<PacketTemplate[]>([]);
  const [items, setItems] = useState<Record<number, PacketTemplateItem[]>>({});
  const [forms, setForms] = useState<FormRow[]>([]);
  const [paths, setPaths] = useState<{ forms_state: string; forms_uar: string } | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  const [showExhibit, setShowExhibit] = useState(false);
  const [proposal, setProposal] = useState<{ template: PacketTemplate; list: Proposal[]; picked: Set<number>; modelUsed: boolean; pending?: boolean } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [editing, setEditing] = useState<{ id: number; label: string } | null>(null);

  async function load() {
    const p = await appPaths(); setPaths(p);
    const ts = await listPacketTemplates(); setTemplates(ts);
    const map: Record<number, PacketTemplateItem[]> = {};
    for (const t of ts) map[t.id] = await listPacketTemplateItems(t.id);
    setItems(map);
    setForms(await listForms());
  }
  useEffect(() => {
    (async () => {
      try { setBusy('Indexing the forms folders'); const r = await syncFormsLibrary(s => setBusy(s)); setBusy(r.added || r.updated ? `Indexed ${r.added} new, ${r.updated} updated form(s)` : ''); } catch (e) { setBusy(`Forms index: ${friendlyError(e)}`); }
      // Link every Exhibit B item to its form by the rule table (idempotent), so nothing shows "no form linked" when the form exists.
      try { const fs = await listForms(); let n = 0; for (const t of await listPacketTemplates()) n += await linkFormsByRules(t.id, t.side, fs); if (n) setBusy(`Linked ${n} form(s) to packet items`); } catch { /* shown as unlinked */ }
      await load().catch(e => setBusy(String(e)));
    })();
  }, []);

  const missingState = useMemo(() => packets.state_forms.filter(sf => !forms.some(f => f.source === 'state' && f.path.toLowerCase().endsWith(sf.file.toLowerCase()))), [forms]);
  async function fetchMissingState() {
    if (!paths) return;
    for (const f of missingState) {
      setBusy(`Downloading ${f.name}`);
      try { await native.downloadFile(f.url, `${paths.forms_state}\\${f.file}`); } catch (e) { setBusy(`Failed: ${f.name}: ${String(e)}`); return; }
    }
    await syncFormsLibrary(); setBusy(''); await load();
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return forms.filter(f => !needle || f.name.toLowerCase().includes(needle) || (f.revision ?? '').toLowerCase().includes(needle));
  }, [forms, q]);

  async function addFormTo(t: PacketTemplate, f: FormRow) {
    const c = classifyForm(t.side, f);
    const existing = items[t.id] ?? [];
    // If an Exhibit B line of that kind has no form yet, link the form to it instead of adding a duplicate row.
    const slot = existing.find(i => i.doc_kind === c.doc_kind && !i.form_id && c.doc_kind !== 'other');
    if (slot) await updatePacketTemplateItem(slot.id, { form_id: f.id });
    else if (!existing.some(i => i.form_id === f.id)) await addPacketTemplateItem({ template_id: t.id, doc_kind: c.doc_kind, label: f.name, required_when: c.required_when, form_id: f.id, source: 'cory', reason: c.satisfies });
    await logEvent('packet_template.item_added', 'packet_template', t.id, { form_id: f.id, by: 'cory' });
    await load();
  }

  async function autoBuild(t: PacketTemplate) {
    setBusy('Building the packet from Exhibit B');
    const started = Date.now();
    const tick = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    setElapsed(0);
    try {
      // Rule picks show at once; the model's situational extras are appended when they arrive.
      const r = await proposePacket(t.side, forms, items[t.id] ?? [], s => setBusy(s), rules => setProposal({ template: t, list: rules, picked: new Set(rules.filter(p => !p.already).map(p => p.form_id)), modelUsed: false, pending: true }));
      setProposal({ template: t, list: r.proposals, picked: new Set(r.proposals.filter(p => !p.already).map(p => p.form_id)), modelUsed: r.modelUsed, pending: false });
      setBusy(r.error ? `Rule picks are in. The model's extras failed: ${r.error}` : r.modelUsed ? '' : 'The local model is not running, so these are the rule-based picks only.');
    } catch (e) { setBusy(`Auto-build failed: ${friendlyError(e)}`); setProposal(p => p ? { ...p, pending: false } : p); }
    finally { window.clearInterval(tick); }
  }
  async function applyProposal() {
    if (!proposal) return;
    const t = proposal.template; const existing = items[t.id] ?? [];
    let n = 0;
    for (const p of proposal.list) {
      if (!proposal.picked.has(p.form_id) || p.already) continue;
      const slot = existing.find(i => i.doc_kind === p.doc_kind && !i.form_id && p.doc_kind !== 'other');
      if (slot) await updatePacketTemplateItem(slot.id, { form_id: p.form_id, reason: p.reason });
      else await addPacketTemplateItem({ template_id: t.id, doc_kind: p.doc_kind, label: p.form_name, required_when: p.required_when, form_id: p.form_id, source: p.source === 'ai' ? 'ai' : 'cory', reason: `${p.satisfies}. ${p.reason}` });
      n++;
    }
    await logEvent('packet_template.auto_built', 'packet_template', t.id, { added: n, model: proposal.modelUsed });
    setProposal(null); setBusy(`Added ${n} form(s) to the ${SIDE_LABEL[t.side].toLowerCase()}`);
    await load();
  }

  async function reset(t: PacketTemplate) {
    const seed = (packets as unknown as Record<string, { items: Array<{ doc_kind: string; label: string; required_when?: string; form_code?: string }> }>)[t.side];
    await resetPacketTemplate(t.id, seed.items); await linkFormsByRules(t.id, t.side, forms); await load();
  }

  const badge = (s: string) => s === 'exhibit_b' ? ['Exhibit B', 'bg-ink/5 text-ink/60'] : s === 'ai' ? ['AI', 'bg-violet-100 text-violet-800'] : ['you', 'bg-sky-100 text-sky-800'];

  return (
    <div className="p-8 space-y-6 max-w-7xl">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-2xl font-semibold">Packets and forms</h1>
          <p className="mt-1 text-sm text-ink/60">Each packet is a template built from your Simple Choice agreement (Exhibit B). Add or remove forms as you like; every new client file copies the template as it stands that day.</p>
        </div>
        <button onClick={() => setShowExhibit(v => !v)} className="shrink-0 rounded-md border border-ink/15 bg-white px-3 py-1.5 text-xs">{showExhibit ? 'Hide' : 'Show'} Exhibit B</button>
      </div>
      {busy && <div className="text-xs text-ink/60">{busy}{proposal?.pending ? ` · ${elapsed}s` : ''}</div>}

      {showExhibit && (
        <div className="rounded-lg border border-ink/10 bg-white p-4 text-sm grid grid-cols-3 gap-4">
          <div className="col-span-3 text-xs text-ink/60">{exhibitB.source}. {exhibitB.rule} {exhibitB.deadlines}</div>
          {(['seller', 'buyer', 'closing'] as const).map(s => <div key={s}><div className="font-medium mb-1">{s === 'closing' ? 'Both sides, closing' : s === 'seller' ? 'Listing side' : 'Buyer side'}</div><ul className="list-disc pl-5 space-y-0.5 text-xs">{exhibitB[s].map((l, i) => <li key={i}>{l}</li>)}</ul></div>)}
        </div>
      )}

      <div className="grid grid-cols-[1fr_360px] gap-6 items-start">
        <div className="space-y-6">
          {templates.map(t => (
            <div key={t.id} className="rounded-lg border border-ink/10 bg-white">
              <div className="flex items-center justify-between border-b border-ink/5 px-4 py-3">
                <div className="font-medium">{SIDE_LABEL[t.side]} <span className="ml-2 text-xs font-normal text-ink/50">{(items[t.id] ?? []).length} items · {(items[t.id] ?? []).filter(i => i.form_id).length} linked to a form</span></div>
                <div className="flex gap-2">
                  <button onClick={() => autoBuild(t)} className="rounded-md bg-brand px-3 py-1.5 text-xs text-white">Auto-build with AI</button>
                  <button onClick={() => reset(t)} className="rounded-md border border-ink/15 px-3 py-1.5 text-xs">Reset to Exhibit B</button>
                </div>
              </div>
              {proposal && proposal.template.id === t.id && (
                <div className="border-b border-ink/5 bg-violet-50/60 px-4 py-3 text-sm">
                  <div className="flex items-center justify-between"><div className="font-medium">Proposed forms {proposal.pending ? <span className="font-normal text-ink/60">(rules are in; the local model is reading the library for situational extras… {elapsed}s, usually 30-60 s)</span> : proposal.modelUsed ? '(rules + local model)' : '(rules only)'}</div>
                    <div className="flex gap-2"><button onClick={applyProposal} className="rounded-md bg-brand px-3 py-1 text-xs text-white">Add {[...proposal.picked].filter(id => !proposal.list.find(p => p.form_id === id)?.already).length} selected</button><button onClick={() => setProposal(null)} className="rounded-md border border-ink/15 px-3 py-1 text-xs">Dismiss</button></div></div>
                  <ul className="mt-2 space-y-1">
                    {proposal.list.map(p => (
                      <li key={p.form_id} className="flex items-start gap-2 text-xs">
                        <input type="checkbox" disabled={p.already} checked={p.already || proposal.picked.has(p.form_id)} onChange={e => { const s = new Set(proposal.picked); if (e.target.checked) s.add(p.form_id); else s.delete(p.form_id); setProposal({ ...proposal, picked: s }); }} className="mt-0.5" />
                        <div className="flex-1">
                          <span className={p.already ? 'text-ink/40' : 'font-medium'}>{p.form_name}</span>
                          <span className={`ml-2 rounded px-1 py-0.5 text-[10px] ${p.source === 'ai' ? 'bg-violet-100 text-violet-800' : 'bg-ink/5 text-ink/60'}`}>{p.source === 'ai' ? 'model' : 'rule'}</span>
                          <span className="ml-2 text-ink/50">{WHEN.find(w => w[0] === p.required_when)?.[1]}</span>{p.already && <span className="ml-2 text-ink/40">already in packet</span>}
                          <div className="text-ink/60">{p.satisfies}. {p.reason}</div>
                        </div>
                      </li>
                    ))}
                    {!proposal.list.length && <li className="text-xs text-ink/50">Nothing to add.</li>}
                  </ul>
                </div>
              )}
              <ol className="divide-y divide-ink/5">
                {(items[t.id] ?? []).map((i, idx, arr) => {
                  const [bl, bc] = badge(i.source);
                  return (
                    <li key={i.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                      <span className="w-5 text-right text-xs text-ink/40 tabular-nums">{i.position}</span>
                      <div className="min-w-0 flex-1">
                        {editing?.id === i.id
                          ? <input autoFocus value={editing.label} onChange={e => setEditing({ id: i.id, label: e.target.value })} onBlur={async () => { await updatePacketTemplateItem(i.id, { label: editing.label }); setEditing(null); await load(); }} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(null); }} className="w-full rounded border border-ink/15 px-2 py-1 text-sm" />
                          : <div className="truncate" onDoubleClick={() => setEditing({ id: i.id, label: i.label })} title="Double-click to rename">{i.label}</div>}
                        <div className="mt-0.5 flex items-center gap-2 text-xs text-ink/50">
                          {i.form_path ? <button onClick={() => openDocument(i.form_path!).catch(e => setBusy(friendlyError(e)))} className="truncate text-brand hover:underline" title={i.form_path}>{i.form_name}{i.form_revision ? ` (rev ${i.form_revision})` : ''}</button> : <span className="text-amber-700">{['preapproval', 'settlement', 'cda', 'communication', 'title_commitment'].includes(i.doc_kind) ? 'no form: this comes from outside (lender, title company, brokerage)' : 'no form linked'}</span>}
                          {i.reason && <span className="truncate" title={i.reason}>· {i.reason}</span>}
                        </div>
                      </div>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] ${bc}`}>{bl}</span>
                      <select value={i.required_when ?? 'always'} onChange={async e => { await updatePacketTemplateItem(i.id, { required_when: e.target.value }); await load(); }} className="rounded border border-ink/15 bg-white px-1 py-0.5 text-xs">{WHEN.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                      <div className="flex gap-1">
                        <button disabled={idx === 0} onClick={async () => { await movePacketTemplateItem(i.id, -1); await load(); }} className="rounded border border-ink/15 px-1.5 text-xs disabled:opacity-30" title="Move up">▲</button>
                        <button disabled={idx === arr.length - 1} onClick={async () => { await movePacketTemplateItem(i.id, 1); await load(); }} className="rounded border border-ink/15 px-1.5 text-xs disabled:opacity-30" title="Move down">▼</button>
                        <button onClick={async () => { await removePacketTemplateItem(i.id); await load(); }} className="rounded border border-ink/15 px-1.5 text-xs text-red-700" title="Remove from packet">×</button>
                      </div>
                    </li>
                  );
                })}
                {!(items[t.id] ?? []).length && <li className="px-4 py-3 text-sm text-ink/50">Empty. Auto-build it or add forms from the library.</li>}
              </ol>
            </div>
          ))}
        </div>

        <aside className="sticky top-6 rounded-lg border border-ink/10 bg-white">
          <div className="border-b border-ink/5 px-4 py-3">
            <div className="flex items-center justify-between"><div className="font-medium">Forms library <span className="ml-1 text-xs font-normal text-ink/50">{forms.length}</span></div>
              <div className="flex gap-1">{paths && <button onClick={() => openDocument(paths.forms_uar).catch(e => setBusy(friendlyError(e)))} className="rounded border border-ink/15 px-2 py-1 text-[10px]">UAR folder</button>}{paths && <button onClick={() => openDocument(paths.forms_state).catch(e => setBusy(friendlyError(e)))} className="rounded border border-ink/15 px-2 py-1 text-[10px]">State folder</button>}</div></div>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search forms" className="mt-2 w-full rounded-md border border-ink/15 px-3 py-1.5 text-sm" />
            {missingState.length > 0 && <button onClick={fetchMissingState} className="mt-2 w-full rounded-md bg-brand px-3 py-1.5 text-xs text-white">Download {missingState.length} missing state form(s)</button>}
            <div className="mt-1 text-[10px] text-ink/40">Click a name to open it. S / B / C adds it to the Seller, Buyer or Closing packet.</div>
          </div>
          <ul className="max-h-[70vh] divide-y divide-ink/5 overflow-y-auto text-sm">
            {filtered.map(f => (
              <li key={f.id} className="flex items-center gap-2 px-3 py-1.5">
                <button onClick={() => openDocument(f.path).catch(e => setBusy(friendlyError(e)))} className="min-w-0 flex-1 truncate text-left hover:underline" title={f.path}>{f.name}<span className="ml-1 text-[10px] text-ink/40">{f.revision ? `rev ${f.revision}` : ''}{f.source === 'state' ? ' · state' : f.source === 'custom' ? ' · MLS' : ''}{f.fillable ? ' · fillable' : ''}</span></button>
                {templates.map(t => {
                  const inIt = (items[t.id] ?? []).some(i => i.form_id === f.id);
                  return <button key={t.id} disabled={inIt} onClick={() => addFormTo(t, f)} className={`w-6 rounded border text-[10px] ${inIt ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-ink/15 hover:bg-ink/5'}`} title={inIt ? `In the ${SIDE_LABEL[t.side]}` : `Add to ${SIDE_LABEL[t.side]}`}>{t.side[0].toUpperCase()}</button>;
                })}
              </li>
            ))}
            {!filtered.length && <li className="px-3 py-3 text-ink/50">{forms.length ? 'No match.' : 'No forms indexed yet. Put PDFs in the UAR or State folder.'}</li>}
          </ul>
        </aside>
      </div>
    </div>
  );
}
