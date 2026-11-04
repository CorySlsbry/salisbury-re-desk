import { useEffect, useMemo, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { DEFAULT_UNITS, RULES, adjustComp, netSheet, runCma, type Attrs, type Comp, type UnitValues } from '../lib/cma';
import { money } from '../lib/fmt';
import { geocode, subjectHints, importExport, candidatePool, buildCma, saveCma, setManualLocation, type Located, type CmaRun } from '../lib/cmaFlow';
import { compStats } from '../lib/repoCma';
import { LADDER } from '../lib/compSelect';
import { openDocument } from '../lib/documents';
import { friendlyError } from '../lib/errors';

const num = (v: string) => (v === '' ? 0 : Number(v));

export default function Tools() {
  const [tab, setTab] = useState<'cma' | 'net'>('cma');
  return (
    <div className="p-8 space-y-6 max-w-6xl">
      <div><h1 className="text-2xl font-semibold">Tools</h1><p className="mt-1 text-sm text-ink/60">The CMA the way Pat does it (appraisal grid, adjust the comp toward the subject) and the seller net sheet at your fee.</p></div>
      <div className="flex gap-2">{(['cma', 'net'] as const).map(t => <button key={t} onClick={() => setTab(t)} className={`rounded-md border px-3 py-1.5 text-sm ${tab === t ? 'bg-ink text-white border-ink' : 'bg-white border-ink/15'}`}>{t === 'cma' ? 'CMA' : 'Seller net sheet'}</button>)}</div>
      {tab === 'cma' ? <Cma /> : <Net />}
    </div>
  );
}

function Cma() {
  const [subject, setSubject] = useState<Attrs>({ sqft: 2000, basementFinishedSqft: 0, beds: 3, fullBaths: 2, threeQuarterBaths: 0, halfBaths: 0, yearBuilt: 1995, garage: 2, acres: 0.2, updatingUnits: 0, style: 'two-story' });
  const [units, setUnits] = useState<UnitValues>(DEFAULT_UNITS);
  const [comps, setComps] = useState<Comp[]>([]);
  const [draft, setDraft] = useState<Comp>({ id: '', label: '', salePrice: 0, sqft: 0, basementFinishedSqft: 0, beds: 3, fullBaths: 2, threeQuarterBaths: 0, halfBaths: 0, yearBuilt: 2000, garage: 2, acres: 0.2, updatingUnits: 0, style: 'two-story', distanceMi: 0.5, status: 'sold' });
  const [address, setAddress] = useState('');
  const [located, setLocated] = useState<Located | null>(null);
  const [hint, setHint] = useState('');
  const [txId, setTxId] = useState<number | null>(null);
  const [run, setRun] = useState<CmaRun | null>(null);
  const [stats, setStats] = useState<{ total: number; sold: number; latest: string | null; located: number } | null>(null);
  const [busy, setBusy] = useState('');
  const [step, setStep] = useState('');
  const [msg, setMsg] = useState('');
  const [pdf, setPdf] = useState('');
  const [coords, setCoords] = useState('');
  const result = useMemo(() => (comps.length ? runCma(subject, comps, units) : null), [subject, comps, units]);
  const styles = ['rambler', 'two-story', 'split-entry', 'multi-level', 'townhome', 'condo'];
  useEffect(() => { compStats().then(setStats).catch(() => {}); }, []);

  async function locate() {
    if (!address.trim() || busy) return;
    setBusy('locate'); setMsg(''); setRun(null); setPdf('');
    try {
      const loc = await geocode(address);
      setLocated(loc);
      const h = await subjectHints(address);
      setTxId(h.transactionId);
      if (Object.keys(h.attrs).length) { setSubject(s => ({ ...s, ...Object.fromEntries(Object.entries(h.attrs).filter(([, v]) => v != null)) })); }
      setHint(h.source ? `Subject facts prefilled from ${h.source}; check them.` : 'No prior record of this address; type the subject facts.');
      setMsg(loc.lat != null ? `Located${loc.source ? ' via ' + ({ ugrc: 'Utah address points', census: 'the US Census geocoder', osm: 'OpenStreetMap', 'osm-street': 'OpenStreetMap (street level, approximate)', manual: 'your pasted coordinates', cache: 'a previous lookup' }[loc.source] ?? loc.source) : ''}: ${loc.matched ?? loc.address} (${loc.lat.toFixed(5)}, ${loc.lng!.toFixed(5)}).` : 'No address service knows that address yet (common on brand-new streets). Paste its coordinates from Google Maps below: right-click the house on the map and click the numbers.');
    } catch (e) { setMsg(friendlyError(e)); } finally { setBusy(''); }
  }
  async function importFile() {
    if (busy) return;
    const picked = await openDialog({ multiple: false, filters: [{ name: 'MLS export (CSV)', extensions: ['csv', 'txt'] }] });
    if (!picked) return;
    setBusy('import'); setMsg('');
    try { const r = await importExport(picked as string, setStep); setStats(await compStats()); setMsg(`Imported ${r.comps.length} listing(s): ${r.added} new, ${r.updated} updated.${r.unmapped.length ? ` Columns not used: ${r.unmapped.slice(0, 12).join(', ')}${r.unmapped.length > 12 ? '…' : ''}.` : ''}`); }
    catch (e) { setMsg(friendlyError(e)); } finally { setBusy(''); setStep(''); }
  }
  async function auto() {
    if (busy) return;
    if (!located || located.lat == null || located.lng == null) { setMsg('Locate the subject address first (or the comps cannot be measured).'); return; }
    setBusy('auto'); setMsg(''); setPdf('');
    try {
      const pool = await candidatePool({ lat: located.lat, lng: located.lng }, setStep);
      if (!pool.length) { setMsg('No comps on hand. Import an MLS export first (Sold + Active + Under Contract, the subject\'s area, last 12 months).'); return; }
      const r = buildCma(address, located, subject, pool, units);
      setRun(r);
      setComps([...r.selection.chosen, ...r.selection.context.active, ...r.selection.context.underContract].map(c => ({ ...c })));
      setMsg(`${r.selection.chosen.length} sold comp(s) chosen from ${pool.filter(c => (c.status ?? 'sold') === 'sold').length} sold listings on hand (${r.selection.rungsTried} rung(s) climbed). ${r.selection.notes.join(' ')}`);
    } catch (e) { setMsg(friendlyError(e)); } finally { setBusy(''); setStep(''); }
  }
  async function save() {
    if (!run || busy) return;
    setBusy('save');
    try { const r = await saveCma({ ...run, subject, units, result: runCma(subject, comps, units) }, txId); setPdf(r.pdfPath); setMsg(`Saved CMA #${r.id}. PDF: ${r.pdfPath}`); }
    catch (e) { setMsg(friendlyError(e)); } finally { setBusy(''); }
  }

  return (
    <div className="space-y-5 text-sm">
      <div className="rounded-lg border border-ink/10 bg-white p-4">
        <div className="flex items-center justify-between"><div className="font-medium">Start from an address</div><span className="text-xs text-ink/50">{stats ? `${stats.sold} sold / ${stats.total} listings on hand${stats.latest ? `, last import ${stats.latest.slice(0, 10)}` : ''}` : ''}</span></div>
        <div className="mt-2 flex flex-wrap gap-2">
          <input value={address} onChange={e => setAddress(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void locate(); }} placeholder="1842 W Harvest Moon Dr, Lehi, UT 84043" className="min-w-[24rem] flex-1 rounded-md border border-ink/15 px-3 py-2 text-sm" />
          <button onClick={locate} disabled={!!busy || !address.trim()} className="rounded-md bg-ink px-3 py-2 text-white text-sm disabled:opacity-50">{busy === 'locate' ? 'Locating…' : 'Locate + prefill'}</button>
          <button onClick={importFile} disabled={!!busy} className="rounded-md border border-ink/15 bg-white px-3 py-2 text-sm disabled:opacity-50" title="A CSV export from the MLS: Sold, Active and Under Contract listings around the subject, last 12 months">{busy === 'import' ? 'Importing…' : 'Import MLS export…'}</button>
          <button onClick={auto} disabled={!!busy || !located} className="rounded-md bg-brand px-3 py-2 text-white text-sm disabled:opacity-50" title="Pat's ladder: same style, 1 → 1.5 → 2 mi, 90 → 365 days, sqft band; 6 preferred, 4 minimum">{busy === 'auto' ? 'Selecting…' : 'Auto-select comps'}</button>
          {run && <button onClick={save} disabled={!!busy} className="rounded-md border border-ink/15 bg-white px-3 py-2 text-sm disabled:opacity-50">{busy === 'save' ? 'Saving…' : 'Save CMA + PDF'}</button>}
          {pdf && <button onClick={() => openDocument(pdf).catch(e => setMsg(friendlyError(e)))} className="rounded-md border border-ink/15 bg-white px-3 py-2 text-sm">Open PDF</button>}
        </div>
        {located && located.lat == null && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <input value={coords} onChange={e => setCoords(e.target.value)} placeholder="40.36512, -112.00891  (paste from Google Maps)" className="w-72 rounded-md border border-ink/15 px-2 py-1 text-sm" />
            <button onClick={async () => { const m = /(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/.exec(coords); if (!m) { setMsg('Paste two numbers like 40.36512, -112.00891.'); return; } try { const loc = await setManualLocation(address, Number(m[1]), Number(m[2])); setLocated(loc); setMsg(`Located from your coordinates (${loc.lat!.toFixed(5)}, ${loc.lng!.toFixed(5)}). Comps can be measured now.`); } catch (e) { setMsg(friendlyError(e)); } }} className="rounded-md border border-ink/15 bg-white px-2 py-1">Use these coordinates</button>
          </div>
        )}
        {step && <div className="mt-1 text-xs text-ink/50">{step}</div>}
        {hint && <div className="mt-1 text-xs text-ink/60">{hint}{txId ? ' This address is a client file: the PDF will be saved into that folder.' : ''}</div>}
        {msg && <div className="mt-1 text-xs text-ink/70 whitespace-pre-wrap">{msg}</div>}
        <div className="mt-2 text-xs text-ink/50">How to get comps: in the MLS, search the subject's area for Sold (last 12 months) plus Active and Under Contract, export to CSV, then Import. Addresses are located through Utah's statewide address points, then the US Census geocoder, then OpenStreetMap (public property addresses only, cached); turn it off in Settings with geocoder = off and paste coordinates or type distances by hand.</div>
      </div>

      <div className="rounded-lg border border-ink/10 bg-white p-4">
        <div className="font-medium">Subject property</div>
        <div className="mt-2 grid grid-cols-6 gap-2">
          <F label="Above-grade sqft" value={subject.sqft} onChange={n => setSubject({ ...subject, sqft: n })} />
          <F label="Finished basement sqft" value={subject.basementFinishedSqft} onChange={n => setSubject({ ...subject, basementFinishedSqft: n })} />
          <F label="Beds" value={subject.beds} onChange={n => setSubject({ ...subject, beds: n })} />
          <F label="Full baths" value={subject.fullBaths} onChange={n => setSubject({ ...subject, fullBaths: n })} />
          <F label="3/4 baths" value={subject.threeQuarterBaths} onChange={n => setSubject({ ...subject, threeQuarterBaths: n })} />
          <F label="Half baths" value={subject.halfBaths} onChange={n => setSubject({ ...subject, halfBaths: n })} />
          <F label="Year built" value={subject.yearBuilt} onChange={n => setSubject({ ...subject, yearBuilt: n })} />
          <F label="Garage bays" value={subject.garage} onChange={n => setSubject({ ...subject, garage: n })} />
          <F label="Acres" value={subject.acres} step={0.01} onChange={n => setSubject({ ...subject, acres: n })} />
          <F label="Updating units (0-3)" value={subject.updatingUnits} onChange={n => setSubject({ ...subject, updatingUnits: n })} />
          <label className="text-xs text-ink/60">Style<select value={subject.style} onChange={e => setSubject({ ...subject, style: e.target.value })} className="mt-0.5 w-full rounded border border-ink/15 px-2 py-1 text-sm">{styles.map(s => <option key={s}>{s}</option>)}</select></label>
        </div>
        <div className="mt-2 text-xs text-ink/50">Rules: {RULES.radiusMi.join(' → ')} mi radius (stop at 2.0), {RULES.soldsMin}-{RULES.soldsPreferred} sold comps, style-to-style is absolute, {LADDER.windowDays.join(' → ')} days, sqft band {RULES.sqftBand[0]}x-{RULES.sqftBand[1]}x, net ≤ {RULES.netMax * 100}% / gross ≤ {RULES.grossMax * 100}%, outliers ±{RULES.outlier * 100}% from the median.</div>
      </div>

      {run && (
        <details className="rounded-lg border border-ink/10 bg-white p-4 text-xs" open>
          <summary className="cursor-pointer font-medium text-sm">Why these comps ({run.selection.chosen.length} chosen, {run.selection.considered.length} considered and not used)</summary>
          <div className="mt-2 text-ink/70">Rung: same style, {run.selection.rung.radiusMi} mi, {run.selection.rung.windowDays} days, {Math.round(run.selection.rung.band[0] * 100)}-{Math.round(run.selection.rung.band[1] * 100)}% sqft{run.selection.rung.adjacentStyle ? ', adjacent style borrowed' : ''}. {run.selection.notes.join(' ')}</div>
          <ul className="mt-2 max-h-56 overflow-auto divide-y divide-ink/5">{run.selection.considered.map(c => <li key={c.comp.id} className="flex justify-between gap-3 py-0.5"><span className="truncate">{c.comp.label}</span><span className="shrink-0 text-ink/50">{c.reason}</span></li>)}</ul>
        </details>
      )}

      <div className="rounded-lg border border-ink/10 bg-white p-4">
        <div className="font-medium">Add a comp by hand <span className="text-xs font-normal text-ink/50">(sold = used in the math; active / under contract = context only)</span></div>
        <div className="mt-2 grid grid-cols-8 gap-2">
          <label className="text-xs text-ink/60 col-span-2">Label / address<input value={draft.label} onChange={e => setDraft({ ...draft, label: e.target.value })} className="mt-0.5 w-full rounded border border-ink/15 px-2 py-1 text-sm" /></label>
          <F label="Sale price" value={draft.salePrice} onChange={n => setDraft({ ...draft, salePrice: n })} />
          <F label="Sqft" value={draft.sqft} onChange={n => setDraft({ ...draft, sqft: n })} />
          <F label="Bsmt fin sqft" value={draft.basementFinishedSqft} onChange={n => setDraft({ ...draft, basementFinishedSqft: n })} />
          <F label="Beds" value={draft.beds} onChange={n => setDraft({ ...draft, beds: n })} />
          <F label="Full baths" value={draft.fullBaths} onChange={n => setDraft({ ...draft, fullBaths: n })} />
          <F label="3/4 baths" value={draft.threeQuarterBaths} onChange={n => setDraft({ ...draft, threeQuarterBaths: n })} />
          <F label="Half baths" value={draft.halfBaths} onChange={n => setDraft({ ...draft, halfBaths: n })} />
          <F label="Year built" value={draft.yearBuilt} onChange={n => setDraft({ ...draft, yearBuilt: n })} />
          <F label="Garage" value={draft.garage} onChange={n => setDraft({ ...draft, garage: n })} />
          <F label="Acres" value={draft.acres} step={0.01} onChange={n => setDraft({ ...draft, acres: n })} />
          <F label="Updating units" value={draft.updatingUnits} onChange={n => setDraft({ ...draft, updatingUnits: n })} />
          <F label="Miles away" value={draft.distanceMi} step={0.1} onChange={n => setDraft({ ...draft, distanceMi: n })} />
          <label className="text-xs text-ink/60">Style<select value={draft.style} onChange={e => setDraft({ ...draft, style: e.target.value })} className="mt-0.5 w-full rounded border border-ink/15 px-2 py-1 text-sm">{styles.map(s => <option key={s}>{s}</option>)}</select></label>
          <label className="text-xs text-ink/60">Status<select value={draft.status} onChange={e => setDraft({ ...draft, status: e.target.value as Comp['status'] })} className="mt-0.5 w-full rounded border border-ink/15 px-2 py-1 text-sm"><option value="sold">sold</option><option value="active">active</option><option value="under_contract">under contract</option></select></label>
        </div>
        <div className="mt-2 flex gap-2">
          <button onClick={() => { if (!draft.salePrice || !draft.sqft) return; setComps([...comps, { ...draft, id: String(Date.now()), label: draft.label || `Comp ${comps.length + 1}` }]); setDraft({ ...draft, label: '', salePrice: 0 }); }} className="rounded-md bg-ink px-3 py-1.5 text-white text-sm">Add comp</button>
          {comps.length > 0 && <button onClick={() => { setComps([]); setRun(null); }} className="rounded-md border border-ink/15 px-3 py-1.5 text-sm">Clear comps</button>}
        </div>
      </div>

      {result && (
        <div className="rounded-lg border border-ink/10 bg-white p-4 space-y-3">
          <div className="grid grid-cols-4 gap-3">
            <Stat label="Indicated value (weighted)" value={result.indicated} />
            <Stat label="List / top dollar (x1.025, under the threshold)" value={result.listTop} />
            <Stat label="Realistic / quick sale" value={result.realistic} />
            <Stat label="Floor / fire sale (x0.97)" value={result.floor} />
          </div>
          <div className="text-xs"><span className={`rounded px-1.5 py-0.5 ${result.confidence === 'high' ? 'bg-emerald-100 text-emerald-800' : result.confidence === 'medium' ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-800'}`}>confidence {result.confidence}</span> <span className="text-ink/50">{result.survivors.length} survivor(s), {result.dropped.length} dropped, median of survivors {money(result.medianAdjusted)}</span></div>
          {result.warnings.map((w, i) => <div key={i} className="text-xs text-amber-800">{w}</div>)}
          <table className="w-full text-xs">
            <thead><tr className="text-left text-ink/50 border-b border-ink/10"><th className="py-1">Comp</th><th>Sale</th><th>Net adj</th><th>Gross adj</th><th>Adjusted</th><th>Weight</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {result.adjusted.map(a => { const drop = result.dropped.find(d => d.comp === a); const w = 1 / (1 + a.gross / a.comp.salePrice); return (
                <tr key={a.comp.id} className={`border-b border-ink/5 ${drop ? 'text-ink/40' : ''}`} title={a.lines.map(l => `${l.item}: ${l.diff > 0 ? '+' : ''}${l.diff} × ${l.unit} = ${money(l.adjustment)}`).join('\n')}>
                  <td className="py-1">{a.comp.label}{a.comp.distanceMi != null ? <span className="text-ink/40"> · {a.comp.distanceMi} mi</span> : null}{a.comp.soldOn ? <span className="text-ink/40"> · {a.comp.soldOn}</span> : null}</td><td>{money(a.comp.salePrice)}</td><td>{a.net >= 0 ? '+' : ''}{money(a.net)} ({(a.netPct * 100).toFixed(1)}%)</td><td>{money(a.gross)} ({(a.grossPct * 100).toFixed(1)}%)</td><td className="font-medium">{money(a.adjusted)}</td><td>{w.toFixed(2)}</td><td>{drop ? `dropped: ${drop.why}` : 'used'}</td><td><button onClick={() => setComps(comps.filter(c => c.id !== a.comp.id))} className="text-ink/40 hover:text-red-700">remove</button></td>
                </tr>); })}
              {comps.filter(c => c.status && c.status !== 'sold').map(c => <tr key={c.id} className="border-b border-ink/5 text-ink/50"><td className="py-1">{c.label}</td><td>{money(c.salePrice)}</td><td colSpan={4}>context ({c.status === 'active' ? 'your competition ceiling' : 'where the market is heading'})</td><td>{c.status}</td><td><button onClick={() => setComps(comps.filter(x => x.id !== c.id))} className="text-ink/40 hover:text-red-700">remove</button></td></tr>)}
            </tbody>
          </table>
          <div className="text-xs text-ink/50">Hover a row for the adjustment lines. Example check: a 1,900 sqft 2000-build updated comp at $545,000 against a 2,000 sqft 1995 un-updated subject adjusts to {money(adjustComp({ sqft: 2000, beds: 3, fullBaths: 2, yearBuilt: 1995, garage: 2, acres: 0.2, updatingUnits: 0 }, { id: 'x', label: 'A', salePrice: 545000, sqft: 1900, beds: 3, fullBaths: 2, yearBuilt: 2000, garage: 2, acres: 0.22, updatingUnits: 2 }).adjusted)} (Pat's worked example: $520,000).</div>
        </div>
      )}

      <details className="rounded-lg border border-ink/10 bg-white p-4 text-xs"><summary className="cursor-pointer font-medium text-sm">Adjustment values (Pat's grid; re-derive for the subject market)</summary>
        <div className="mt-2 grid grid-cols-5 gap-2">
          {(Object.keys(units) as Array<keyof UnitValues>).map(k => <F key={k} label={k} value={units[k]} onChange={n => setUnits({ ...units, [k]: n })} />)}
        </div>
      </details>
    </div>
  );
}

function Net() {
  const [i, setI] = useState({ salePrice: 600000, listingFeePct: 1.99, buyerBrokeragePct: 2.5, mortgagePayoff: 0, secondPayoff: 0, hoaTransfer: 0, sellerConcessions: 0, repairs: 0, homeWarranty: 0, annualTaxes: 0, closingOn: '' });
  const n = useMemo(() => netSheet({ ...i, closingOn: i.closingOn || undefined }), [i]);
  return (
    <div className="grid grid-cols-[1fr_380px] gap-6 text-sm">
      <div className="rounded-lg border border-ink/10 bg-white p-4 grid grid-cols-3 gap-2">
        <F label="Sale price" value={i.salePrice} step={1} onChange={n => setI({ ...i, salePrice: n })} /><F label="Listing fee %" value={i.listingFeePct} step={0.01} onChange={n => setI({ ...i, listingFeePct: n })} /><F label="Offer to buyer brokerage %" value={i.buyerBrokeragePct} step={0.1} onChange={n => setI({ ...i, buyerBrokeragePct: n })} />
        <F label="Mortgage payoff" value={i.mortgagePayoff} step={1} onChange={n => setI({ ...i, mortgagePayoff: n })} /><F label="Second loan / HELOC payoff" value={i.secondPayoff} step={1} onChange={n => setI({ ...i, secondPayoff: n })} /><F label="HOA transfer fee" value={i.hoaTransfer} step={1} onChange={n => setI({ ...i, hoaTransfer: n })} />
        <F label="Seller concessions" value={i.sellerConcessions} step={1} onChange={n => setI({ ...i, sellerConcessions: n })} /><F label="Repairs / credits" value={i.repairs} step={1} onChange={n => setI({ ...i, repairs: n })} /><F label="Home warranty" value={i.homeWarranty} step={1} onChange={n => setI({ ...i, homeWarranty: n })} />
        <F label="Annual property tax" value={i.annualTaxes} step={1} onChange={n => setI({ ...i, annualTaxes: n })} /><DateField label="Closing date (for tax proration)" value={i.closingOn} onChange={v => setI({ ...i, closingOn: v })} />
      </div>
      <div className="rounded-lg border border-ink/10 bg-white p-4">
        <div className="font-medium">Estimated seller net</div>
        <ul className="mt-2 divide-y divide-ink/5 text-xs">{n.lines.map((l, k) => <li key={k} className="flex justify-between py-1"><span>{l.label}</span><span className="tabular-nums">-{money(l.amount)}</span></li>)}</ul>
        <div className="mt-2 flex justify-between border-t border-ink/10 pt-2"><span>Total costs</span><span className="tabular-nums">-{money(n.totalCosts)}</span></div>
        <div className="mt-1 flex justify-between text-lg font-semibold"><span>Net to seller</span><span className="tabular-nums">{money(n.net)}</span></div>
        <div className="mt-3 text-xs text-ink/50">Your side: {money(n.agentGross)} gross, {money(n.agentAfterFee)} after the $495 transaction fee. Title and escrow figures are placeholders until the title company quotes them. I am not a mortgage broker; a licensed lender confirms payoff figures.</div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) { return <div className="rounded-lg border border-ink/10 bg-paper p-3"><div className="text-xs text-ink/50">{label}</div><div className="text-xl font-semibold tabular-nums">{money(value)}</div></div>; }

/* Module-level field components: inline definitions would remount on every keystroke and drop focus. */
function F({ label, value, onChange, step = 1 }: { label: string; value: number | undefined; onChange: (n: number) => void; step?: number }) {
  return <label className="text-xs text-ink/60">{label}<input type="number" step={step} value={value ?? 0} onChange={e => onChange(num(e.target.value))} className="mt-0.5 w-full rounded border border-ink/15 px-2 py-1 text-sm" /></label>;
}
function DateField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return <label className="text-xs text-ink/60">{label}<input type="date" value={value} onChange={e => onChange(e.target.value)} className="mt-0.5 w-full rounded border border-ink/15 px-2 py-1 text-sm" /></label>;
}
