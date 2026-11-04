import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useNavigate } from 'react-router-dom';
import { analyze, commitRepc, commitAgreement, draftReview, draftAgreementReview, confidenceBar, type Analysis, type ReviewedRepc, type ReviewedAgreement } from '../lib/intake';
import { doc } from '../lib/native';
import type { Extracted } from '../lib/extract/types';
import { friendlyError } from '../lib/errors';

type Stage = 'idle' | 'analyzing' | 'review' | 'committing' | 'done' | 'error';

/** Field key -> the label shown on the review screen (the two-person rule keys its "viewed" set by label). */
const REPC_LABELS: Record<string, string> = { buyer_names: 'Buyer(s)', seller_names: 'Seller(s)', property_street: 'Street', property_city: 'City', property_county: 'County', property_zip: 'ZIP', purchase_price: 'Purchase price', earnest_money: 'Earnest money', acceptance_on: 'Acceptance date (signed AND communicated)', seller_disclosure_deadline: 'Seller Disclosure Deadline (24a)', due_diligence_deadline: 'Due Diligence Deadline (24b)', financing_appraisal_deadline: 'Financing & Appraisal Deadline (24c)', settlement_deadline: 'Settlement Deadline (24d)' };
const LISTING_LABELS: Record<string, string> = { client_names: 'Seller(s)', client_signed_on: "Signed on (seller's signature date)", end_date: 'Ends at 5:00 PM on (End Date)', property_street: 'Property street', property_city: 'City', property_county: 'County', property_zip: 'ZIP', fee_pct: 'Brokerage fee %', fee_flat: 'Brokerage fee $ (flat)', coop_offer_pct: 'Offer to buyer brokerage % (2.3)', client_phone: 'Client phone', client_address: 'Client mailing address' };
const BBA_LABELS: Record<string, string> = { client_names: 'Buyer(s)', client_signed_on: "Signed on (buyer's signature date)", end_date: 'Ends at 5:00 PM on (End Date)', search_area: 'Search area (1.2 counties)', property_street: 'Specific property (1.2, optional)', property_city: 'City', property_county: 'County', property_zip: 'ZIP', fee_pct: 'Brokerage fee %', fee_flat: 'Brokerage fee $ (flat)', client_phone: 'Client phone', client_address: 'Client mailing address' };


const KIND_LABEL: Record<string, string> = {
  repc: 'Real Estate Purchase Contract', listing_agreement: 'Exclusive Right to Sell Listing Agreement', bba: 'Exclusive Buyer-Broker Agreement',
  addendum: 'Addendum / counteroffer', spcd: "Seller's Property Condition Disclosure", agency_disclosure: 'Agency disclosure', lead_paint: 'Lead-based paint disclosure', wire_fraud: 'Wire Fraud Alert', other: 'Unrecognised document',
};

export default function Intake() {
  const nav = useNavigate();
  const [stage, setStage] = useState<Stage>('idle');
  const [step, setStep] = useState('');
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [review, setReview] = useState<ReviewedRepc | null>(null);
  const [agree, setAgree] = useState<ReviewedAgreement | null>(null);
  const [error, setError] = useState('');
  const [crop, setCrop] = useState<{ png: string; label: string } | null>(null);

  const [pathText, setPathText] = useState('');
  async function pick(givenPath?: string) {
    const path = givenPath ?? (await open({ multiple: false, filters: [{ name: 'PDF', extensions: ['pdf'] }] }));
    if (!path) return;
    setStage('analyzing'); setError(''); setReview(null); setAgree(null); setCrop(null); setViewed(new Set());
    try {
      const a = await analyze(path as string, setStep);
      setAnalysis(a);
      if (a.kind === 'repc' && a.extraction) { setReview(draftReview(a.extraction.fields)); setStage('review'); }
      else if ((a.kind === 'listing_agreement' || a.kind === 'bba') && a.agreement) { setAgree(draftAgreementReview(a.kind, a.agreement.fields)); setStage('review'); }
      else { setError(`This looks like: ${KIND_LABEL[a.kind] ?? a.kind} (confidence ${Math.round(a.kindConfidence * 100)}%). Automatic intake reads the REPC, the listing agreement and the buyer-broker agreement. File other documents from the client's page.`); setStage('error'); }
    } catch (e) { setError(friendlyError(e)); setStage('error'); }
  }

  // Two-person rule: any value read below the accuracy bar (95% unless changed in Settings) must be looked at on the
  // page crop before the file can be built. Ctrl+Enter and the button both refuse until every one has been viewed.
  const [bar, setBar] = useState(0.95);
  const [viewed, setViewed] = useState<Set<string>>(new Set());
  useEffect(() => { confidenceBar().then(setBar).catch(() => {}); }, []);
  async function showCrop(e: Extracted<unknown> | undefined, label: string) {
    setViewed(v => new Set(v).add(label));
    if (!analysis || !e?.page || !e.bbox) { setCrop({ png: '', label: `${label}: no page location was recorded (${e?.note ?? 'not found'}). Check the document by hand.` }); return; }
    const [x0, y0, x1, y1] = e.bbox;
    const t = await doc.thumb(analysis.path, e.page, 144, [Math.max(0, x0 - 40), Math.max(0, y0 - 14), x1 + 40, y1 + 14]);
    setCrop({ png: `data:image/png;base64,${t.png_b64}`, label });
  }
  /** Labels of fields that carry a value but were read below the bar and have not been viewed yet. */
  function unverified(): string[] {
    const src = review ? (analysis?.extraction?.fields as Record<string, Extracted<unknown>> | undefined) : (analysis?.agreement?.fields as Record<string, Extracted<unknown>> | undefined);
    if (!src) return [];
    const labels = review ? REPC_LABELS : agree?.side === 'buyer' ? BBA_LABELS : LISTING_LABELS;
    return Object.entries(labels).filter(([k, label]) => { const e = src[k]; return e && e.value != null && e.confidence < bar && !viewed.has(label); }).map(([, l]) => l);
  }

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.ctrlKey && e.key === 'Enter' && stage === 'review') { e.preventDefault(); void commit(); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  });

  async function commit() {
    if (!analysis) return;
    const pending = unverified();
    if (pending.length) { setError(`Accuracy check: ${pending.length} value(s) were read below ${Math.round(bar * 100)}% confidence. Click "view" on each and compare with the page before building the file: ${pending.join(', ')}.`); return; }
    setStage('committing');
    try {
      const r = review ? await commitRepc(analysis, review, setStep) : agree ? await commitAgreement(analysis, agree, setStep) : null;
      if (!r) throw new Error('Nothing to commit');
      setStage('done');
      nav(`/clients/${r.clientId}`);
    } catch (e) { setError(friendlyError(e)); setStage('error'); }
  }

  const f = analysis?.extraction?.fields;
  const g = analysis?.agreement?.fields;
  const tier = analysis?.extraction?.tier ?? analysis?.agreement?.tier;
  const warnings = analysis?.extraction?.warnings ?? analysis?.agreement?.warnings ?? [];
  const cancel = () => { setStage('idle'); setAnalysis(null); setReview(null); setAgree(null); setCrop(null); };

  return (
    <div className="p-8 max-w-5xl">
      <h1 className="text-2xl font-semibold">Intake</h1>
      <p className="mt-1 text-sm text-ink/60">Drop a signed listing agreement, buyer-broker agreement or purchase contract. The app reads it, you confirm, and it builds the client file, folder, calendar and follow-up.</p>

      {stage === 'idle' || stage === 'error' ? (
        <div className="mt-6">
          <div className="flex items-center gap-3">
            <button onClick={() => pick()} className="rounded-lg bg-brand px-5 py-3 text-white font-medium shadow hover:bg-brand/90">Choose a PDF</button>
            <span className="text-xs text-ink/50">or paste a path</span>
            <input autoFocus aria-label="PDF path" value={pathText} onChange={e => setPathText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && pathText.trim()) pick(pathText.trim()); }} placeholder="C:\...\contract.pdf" className="w-96 rounded-md border border-ink/15 bg-white px-3 py-2 text-sm" />
          </div>
          {error && <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{error}</div>}
        </div>
      ) : null}

      {stage === 'analyzing' || stage === 'committing' ? (
        <div className="mt-6 flex items-center gap-3 text-sm"><span className="h-3 w-3 animate-pulse rounded-full bg-brand" />{step || 'Working'}</div>
      ) : null}

      {stage === 'review' && analysis && (review || agree) && (
        <div className="mt-6 grid grid-cols-[1fr_320px] gap-6">
          <div className="space-y-5">
            <div className="rounded-lg border border-ink/10 bg-white p-4 text-sm">
              <div className="font-medium">{KIND_LABEL[analysis.kind]} detected</div>
              <div className="text-ink/60 mt-1">{analysis.pages} pages · read via {tier === 1 ? 'form fields (exact)' : tier === 2 ? 'text layer' : 'OCR'}{analysis.agreement?.version ? ` · form revision ${analysis.agreement.version}` : ''} · nothing is saved until you confirm below.</div>
              {warnings.length ? <ul className="mt-2 list-disc pl-5 text-amber-800">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul> : null}
            </div>

            {review && f && (
              <div className="grid grid-cols-2 gap-4">
                <label className="block col-span-2">
                  <div className="text-xs text-ink/60 mb-1">I represent the</div>
                  <div className="flex gap-2">
                    {(['buyer', 'seller'] as const).map(s => <button key={s} type="button" onClick={() => setReview({ ...review, side: s })} className={`rounded-md px-4 py-2 text-sm border ${review.side === s ? 'bg-ink text-white border-ink' : 'bg-white border-ink/15'}`}>{s === 'buyer' ? 'Buyer' : 'Seller'}</button>)}
                  </div>
                </label>
                <Field onView={showCrop} label="Buyer(s)" ex={f.buyer_names} value={review.buyerNames} onChange={v => setReview({ ...review, buyerNames: v })} />
                <Field onView={showCrop} label="Seller(s)" ex={f.seller_names} value={review.sellerNames} onChange={v => setReview({ ...review, sellerNames: v })} />
                <Field onView={showCrop} label="Street" ex={f.property_street} value={review.street} onChange={v => setReview({ ...review, street: v })} />
                <Field onView={showCrop} label="City" ex={f.property_city} value={review.city} onChange={v => setReview({ ...review, city: v })} />
                <Field onView={showCrop} label="County" ex={f.property_county} value={review.county} onChange={v => setReview({ ...review, county: v })} />
                <Field onView={showCrop} label="ZIP" ex={f.property_zip} value={review.zip} onChange={v => setReview({ ...review, zip: v })} />
                <Field onView={showCrop} label="Purchase price" ex={f.purchase_price} value={review.purchasePrice} onChange={v => setReview({ ...review, purchasePrice: v ? Number(v) : null })} type="number" />
                <Field onView={showCrop} label="Earnest money" ex={f.earnest_money} value={review.earnestMoney} onChange={v => setReview({ ...review, earnestMoney: v ? Number(v) : null })} type="number" />
                <Field onView={showCrop} label="Acceptance date (signed AND communicated)" ex={f.acceptance_on} value={review.acceptanceOn} onChange={v => setReview({ ...review, acceptanceOn: v })} type="date" />
                <Select label="Financing" value={review.isCash ? 'cash' : 'financed'} onChange={v => setReview({ ...review, isCash: v === 'cash' })} options={[['financed', 'Financed'], ['cash', 'Cash (no F&A deadline)']]} />
                <Field onView={showCrop} label="Seller Disclosure Deadline (24a)" ex={f.seller_disclosure_deadline} value={review.sellerDisclosureOn} onChange={v => setReview({ ...review, sellerDisclosureOn: v || null })} type="date" />
                <Field onView={showCrop} label="Due Diligence Deadline (24b)" ex={f.due_diligence_deadline} value={review.dueDiligenceOn} onChange={v => setReview({ ...review, dueDiligenceOn: v || null })} type="date" />
                <Field onView={showCrop} label="Financing & Appraisal Deadline (24c)" ex={f.financing_appraisal_deadline} value={review.financingAppraisalOn} onChange={v => setReview({ ...review, financingAppraisalOn: v || null })} type="date" />
                <Field onView={showCrop} label="Settlement Deadline (24d)" ex={f.settlement_deadline} value={review.settlementOn} onChange={v => setReview({ ...review, settlementOn: v || null })} type="date" />
                <Field onView={showCrop} label="Co-op agent" value={review.coopAgent} onChange={v => setReview({ ...review, coopAgent: v })} />
                <Field onView={showCrop} label="Co-op brokerage" value={review.coopBrokerage} onChange={v => setReview({ ...review, coopBrokerage: v })} />
                <Field onView={showCrop} label="Client phone" value={review.clientPhone} onChange={v => setReview({ ...review, clientPhone: v })} />
                <Field onView={showCrop} label="Client email" value={review.clientEmail} onChange={v => setReview({ ...review, clientEmail: v })} />
                <Field onView={showCrop} label="Year built (lead paint if before 1978)" value={review.yearBuilt} onChange={v => setReview({ ...review, yearBuilt: v ? Number(v) : null })} type="number" />
                <Select label="HOA" value={review.hasHoa == null ? '' : review.hasHoa ? 'yes' : 'no'} onChange={v => setReview({ ...review, hasHoa: v === '' ? null : v === 'yes' })} options={[['', 'Unknown'], ['yes', 'Yes'], ['no', 'No']]} />
              </div>
            )}

            {agree && g && (
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2 text-xs text-ink/60">I represent the <span className="font-medium text-ink">{agree.side === 'seller' ? 'Seller' : 'Buyer'}</span> (fixed by the form). Company read as "{g.company.value ?? '?'}", agent "{g.agent.value ?? '?'}".</div>
                <Field onView={showCrop} label={agree.side === 'seller' ? 'Seller(s)' : 'Buyer(s)'} ex={g.client_names} value={agree.clientNames} onChange={v => setAgree({ ...agree, clientNames: v })} />
                <Field onView={showCrop} label={`Signed on (${agree.side === 'seller' ? "seller's" : "buyer's"} signature date)`} ex={g.client_signed_on} value={agree.signedOn} onChange={v => setAgree({ ...agree, signedOn: v })} type="date" />
                <Field onView={showCrop} label="Ends at 5:00 PM on (End Date)" ex={g.end_date} value={agree.endsOn} onChange={v => setAgree({ ...agree, endsOn: v || null })} type="date" />
                {agree.side === 'buyer' && <Field onView={showCrop} label="Search area (1.2 counties)" ex={g.search_area} value={agree.searchArea} onChange={v => setAgree({ ...agree, searchArea: v })} />}
                <Field onView={showCrop} label={agree.side === 'seller' ? 'Property street' : 'Specific property (1.2, optional)'} ex={g.property_street} value={agree.street} onChange={v => setAgree({ ...agree, street: v })} />
                <Field onView={showCrop} label="City" ex={g.property_city} value={agree.city} onChange={v => setAgree({ ...agree, city: v })} />
                <Field onView={showCrop} label="County" ex={g.property_county} value={agree.county} onChange={v => setAgree({ ...agree, county: v })} />
                <Field onView={showCrop} label="ZIP" ex={g.property_zip} value={agree.zip} onChange={v => setAgree({ ...agree, zip: v })} />
                <Field onView={showCrop} label="Brokerage fee %" ex={g.fee_pct} value={agree.feePct} onChange={v => setAgree({ ...agree, feePct: v ? Number(v) : null })} type="number" />
                <Field onView={showCrop} label="Brokerage fee $ (flat)" ex={g.fee_flat} value={agree.feeFlat} onChange={v => setAgree({ ...agree, feeFlat: v ? Number(v) : null })} type="number" />
                {agree.side === 'seller' && <Field onView={showCrop} label="Offer to buyer brokerage % (2.3)" ex={g.coop_offer_pct} value={agree.coopOfferPct} onChange={v => setAgree({ ...agree, coopOfferPct: v ? Number(v) : null })} type="number" />}
                {agree.side === 'seller' && <Field onView={showCrop} label="List price (from the Data Form)" value={agree.listPrice} onChange={v => setAgree({ ...agree, listPrice: v ? Number(v) : null })} type="number" />}
                <Field onView={showCrop} label="Client phone" ex={g.client_phone} value={agree.clientPhone} onChange={v => setAgree({ ...agree, clientPhone: v })} />
                <Field onView={showCrop} label="Client email" value={agree.clientEmail} onChange={v => setAgree({ ...agree, clientEmail: v })} />
                <Field onView={showCrop} label="Client mailing address" ex={g.client_address} value={agree.clientAddress} onChange={v => setAgree({ ...agree, clientAddress: v })} />
                {agree.side === 'seller' && <Field onView={showCrop} label="Year built (lead paint if before 1978)" value={agree.yearBuilt} onChange={v => setAgree({ ...agree, yearBuilt: v ? Number(v) : null })} type="number" />}
                {agree.side === 'seller' && <Select label="HOA" value={agree.hasHoa == null ? '' : agree.hasHoa ? 'yes' : 'no'} onChange={v => setAgree({ ...agree, hasHoa: v === '' ? null : v === 'yes' })} options={[['', 'Unknown'], ['yes', 'Yes'], ['no', 'No']]} />}
              </div>
            )}

            {error && <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{error}</div>}
            {unverified().length > 0 && <div className="text-xs text-amber-800">Accuracy bar {Math.round(bar * 100)}%: {unverified().length} value(s) still need a look at the page crop (click their "view" chips).</div>}
            <div className="flex gap-3">
              <button onClick={commit} disabled={review ? (!review.acceptanceOn || !review.street) : !agree?.signedOn || !agree?.clientNames || (agree.side === 'seller' && !agree.street)} className="rounded-lg bg-brand px-5 py-3 text-white font-medium shadow disabled:opacity-40">Confirm and build the file</button>
              <button onClick={cancel} className="rounded-lg border border-ink/15 px-5 py-3 text-sm">Cancel</button>
              <span className="self-center text-xs text-ink/40">Ctrl+Enter confirms</span>
            </div>
          </div>
          <aside className="sticky top-6 self-start">
            <div className="rounded-lg border border-ink/10 bg-white p-3 text-xs text-ink/70">
              <div className="font-medium text-ink mb-2">{crop ? crop.label : 'Click a confidence chip to see where a value was read from.'}</div>
              {crop?.png && <img src={crop.png} alt={crop.label} className="w-full rounded border border-ink/10" />}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

/* Module-level so React keeps the same component identity across renders (inline definitions remount every
   keystroke: the input loses focus and the page scrolls to the top). */
function Field({ label, ex, value, onChange, onView, type = 'text' }: { label: string; ex?: Extracted<unknown>; value: string | number | null | undefined; onChange: (v: string) => void; onView: (e: Extracted<unknown> | undefined, label: string) => void; type?: string }) {
  const conf = ex?.confidence ?? 0;
  return (
    <label className="block">
      <div className="flex items-center justify-between text-xs text-ink/60 mb-1">
        <span>{label}</span>
        {ex && <button type="button" onClick={() => onView(ex, label)} className={`rounded px-1.5 py-0.5 text-[10px] ${conf >= 0.9 ? 'bg-emerald-100 text-emerald-800' : conf >= 0.6 ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-800'}`}>
          {conf ? `tier ${ex.tier} · ${Math.round(conf * 100)}%` : 'not found'} · view
        </button>}
      </div>
      <input type={type} value={value ?? ''} onChange={e => onChange(e.target.value)} className="w-full rounded-md border border-ink/15 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40" />
    </label>
  );
}
function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Array<[string, string]> }) {
  return (
    <label className="block"><div className="text-xs text-ink/60 mb-1">{label}</div>
      <select value={value} onChange={e => onChange(e.target.value)} className="w-full rounded-md border border-ink/15 bg-white px-3 py-2 text-sm">{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
  );
}
