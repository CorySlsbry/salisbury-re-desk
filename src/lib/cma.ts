/**
 * CMA + net sheet, the way Pat does it (bearded-realtor listing-system.md section 6): appraisal-style grid,
 * adjust the COMP toward the SUBJECT, reliability guardrails, outlier removal, reliability-weighted value,
 * three numbers out. Pure functions, unit-tested. Every dollar figure is a default Cory can change in the UI.
 */
export interface Attrs { sqft: number; basementFinishedSqft?: number; beds: number; fullBaths: number; threeQuarterBaths?: number; halfBaths?: number; yearBuilt: number; garage: number; acres?: number; updatingUnits?: number; style?: string }
export interface Comp extends Attrs { id: string; label: string; salePrice: number; soldOn?: string; distanceMi?: number; status?: 'sold' | 'active' | 'under_contract'; note?: string }
export interface UnitValues { bed: number; fullBath: number; threeQuarterBath: number; halfBath: number; sqft: number; basementSqft: number; year: number; garageBay: number; acre: number; updatingUnit: number }
export const DEFAULT_UNITS: UnitValues = { bed: 3000, fullBath: 6500, threeQuarterBath: 4500, halfBath: 3000, sqft: 50, basementSqft: 20, year: 1500, garageBay: 12500, acre: 125000, updatingUnit: 10000 };

export const RULES = { radiusMi: [1.0, 1.5, 2.0], soldsPreferred: 6, soldsMin: 4, windowDays: [180, 270, 365], sqftBand: [0.8, 1.3], netMax: 0.15, grossMax: 0.25, outlier: 0.15, divergence: 0.03 };

export interface AdjustedComp { comp: Comp; lines: Array<{ item: string; diff: number; unit: number; adjustment: number }>; net: number; gross: number; adjusted: number; netPct: number; grossPct: number; reliable: boolean; reasons: string[] }

/** adjustment_i = (subject_i - comp_i) * unit_i ; adjusted = sale + sum. The sign falls out: comp superior -> negative. */
export function adjustComp(subject: Attrs, comp: Comp, u: UnitValues = DEFAULT_UNITS): AdjustedComp {
  const lines: AdjustedComp['lines'] = [];
  const add = (item: string, diff: number, unit: number) => { const adjustment = Math.round(diff * unit); if (diff !== 0) lines.push({ item, diff, unit, adjustment }); };
  add('Above-grade sqft', subject.sqft - comp.sqft, u.sqft);
  add('Finished basement sqft', (subject.basementFinishedSqft ?? 0) - (comp.basementFinishedSqft ?? 0), u.basementSqft);
  add('Bedrooms', subject.beds - comp.beds, u.bed);
  add('Full baths', subject.fullBaths - comp.fullBaths, u.fullBath);
  add('3/4 baths', (subject.threeQuarterBaths ?? 0) - (comp.threeQuarterBaths ?? 0), u.threeQuarterBath);
  add('Half baths', (subject.halfBaths ?? 0) - (comp.halfBaths ?? 0), u.halfBath);
  add('Year built', subject.yearBuilt - comp.yearBuilt, u.year);
  add('Garage bays', subject.garage - comp.garage, u.garageBay);
  add('Acreage', Math.round(((subject.acres ?? 0) - (comp.acres ?? 0)) * 1000) / 1000, u.acre);
  add('Updating units', (subject.updatingUnits ?? 0) - (comp.updatingUnits ?? 0), u.updatingUnit);
  const net = lines.reduce((a, l) => a + l.adjustment, 0);
  const gross = lines.reduce((a, l) => a + Math.abs(l.adjustment), 0);
  const netPct = Math.abs(net) / comp.salePrice, grossPct = gross / comp.salePrice;
  const reasons: string[] = [];
  if (netPct > RULES.netMax) reasons.push(`net adjustment ${(netPct * 100).toFixed(1)}% > ${RULES.netMax * 100}%`);
  if (grossPct > RULES.grossMax) reasons.push(`gross adjustment ${(grossPct * 100).toFixed(1)}% > ${RULES.grossMax * 100}%`);
  if (subject.style && comp.style && subject.style !== comp.style) reasons.push(`style ${comp.style} vs subject ${subject.style} (style-to-style is absolute)`);
  if (comp.distanceMi != null && comp.distanceMi > 2.0) reasons.push('beyond 2.0 miles: low confidence');
  const band = [subject.sqft * RULES.sqftBand[0], subject.sqft * RULES.sqftBand[1]];
  if (comp.sqft < band[0] || comp.sqft > band[1]) reasons.push(`sqft outside the ${Math.round(band[0])}-${Math.round(band[1])} band`);
  return { comp, lines, net, gross, adjusted: comp.salePrice + net, netPct, grossPct, reliable: reasons.length === 0, reasons };
}

export function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

export interface CmaResult {
  adjusted: AdjustedComp[]; survivors: AdjustedComp[]; dropped: Array<{ comp: AdjustedComp; why: string }>;
  medianAdjusted: number; indicated: number; divergencePct: number; confidence: 'high' | 'medium' | 'low'; warnings: string[];
  listTop: number; realistic: number; floor: number;
}

/** Round DOWN to just under the nearest round-number search threshold ($399,900 not $400,000). */
export function underThreshold(v: number): number {
  const steps = [25000, 50000, 100000];
  for (const s of steps) { const r = Math.round(v / s) * s; if (Math.abs(r - v) <= s * 0.12 && r >= v) return r - 100; }
  return Math.floor(v / 100) * 100 - 100;
}

export function runCma(subject: Attrs, comps: Comp[], u: UnitValues = DEFAULT_UNITS): CmaResult {
  const solds = comps.filter(c => (c.status ?? 'sold') === 'sold');
  const adjusted = solds.map(c => adjustComp(subject, c, u));
  const warnings: string[] = [];
  if (solds.length < RULES.soldsMin) warnings.push(`${solds.length} sold comps; Pat's minimum is ${RULES.soldsMin} (6 preferred). Widen the window before the radius.`);
  const dropped: CmaResult['dropped'] = [];
  let pool = adjusted.filter(a => { if (!a.reliable) { dropped.push({ comp: a, why: a.reasons.join('; ') }); return false; } return true; });
  if (pool.length >= 3) {
    const med = median(pool.map(a => a.adjusted));
    const keep = pool.filter(a => Math.abs(a.adjusted - med) / med <= RULES.outlier);
    for (const a of pool) if (!keep.includes(a)) dropped.push({ comp: a, why: `${(((a.adjusted - med) / med) * 100).toFixed(1)}% from the median $${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(med)}: something is wrong with that house the data does not show` });
    pool = keep;
  }
  const survivors = pool;
  const medianAdjusted = survivors.length ? median(survivors.map(a => a.adjusted)) : 0;
  const wsum = survivors.reduce((s, a) => s + 1 / (1 + a.gross / a.comp.salePrice), 0);
  const indicated = survivors.length ? Math.round(survivors.reduce((s, a) => s + (1 / (1 + a.gross / a.comp.salePrice)) * a.adjusted, 0) / wsum) : 0;
  const divergencePct = medianAdjusted ? Math.abs(indicated - medianAdjusted) / medianAdjusted : 0;
  if (divergencePct > RULES.divergence) warnings.push(`Weighted value and median diverge ${(divergencePct * 100).toFixed(1)}% (> 3%): stop and investigate before quoting.`);
  const confidence: CmaResult['confidence'] = survivors.length >= RULES.soldsMin && divergencePct <= RULES.divergence && !adjusted.some(a => a.reasons.some(r => /2\.0 miles|style/.test(r))) ? 'high' : survivors.length >= 3 ? 'medium' : 'low';
  return { adjusted, survivors, dropped, medianAdjusted, indicated, divergencePct, confidence, warnings, listTop: underThreshold(indicated * 1.025), realistic: indicated, floor: Math.round(indicated * 0.97) };
}

/* ---------- seller net sheet ---------- */
export interface NetSheetInput {
  salePrice: number; listingFeePct: number; listingFeeFlat?: number; buyerBrokeragePct?: number; buyerBrokerageFlat?: number;
  mortgagePayoff?: number; secondPayoff?: number; hoaTransfer?: number; titleInsurance?: number; escrowFee?: number; recording?: number;
  sellerConcessions?: number; repairs?: number; homeWarranty?: number; annualTaxes?: number; closingOn?: string; taxesPaidThrough?: string; other?: Array<{ label: string; amount: number }>;
  brokerageTransactionFee?: number; // Simple Choice: $495 per side, paid by the agent, shown for Cory's own math only
}
export interface NetSheetLine { label: string; amount: number }
export interface NetSheet { lines: NetSheetLine[]; totalCosts: number; net: number; agentGross: number; agentAfterFee: number }

/** Utah title premium is filed per company; this is a placeholder curve (~0.5% of price with a $600 floor) to be replaced by the title company's quote. */
export function estimateTitle(price: number): number { return Math.max(600, Math.round(price * 0.0045)); }

export function netSheet(i: NetSheetInput): NetSheet {
  const lines: NetSheetLine[] = [];
  const listingFee = Math.round(i.salePrice * (i.listingFeePct / 100)) + (i.listingFeeFlat ?? 0);
  lines.push({ label: `Listing brokerage fee (${i.listingFeePct}%${i.listingFeeFlat ? ` + $${i.listingFeeFlat}` : ''})`, amount: listingFee });
  const coop = Math.round(i.salePrice * ((i.buyerBrokeragePct ?? 0) / 100)) + (i.buyerBrokerageFlat ?? 0);
  if (coop) lines.push({ label: `Offer to buyer brokerage (${i.buyerBrokeragePct ?? 0}%)`, amount: coop });
  if (i.mortgagePayoff) lines.push({ label: 'Mortgage payoff', amount: i.mortgagePayoff });
  if (i.secondPayoff) lines.push({ label: 'Second loan / HELOC payoff', amount: i.secondPayoff });
  lines.push({ label: 'Owner\'s title policy (estimate; title company quotes the real number)', amount: i.titleInsurance ?? estimateTitle(i.salePrice) });
  lines.push({ label: 'Escrow / settlement fee (seller half)', amount: i.escrowFee ?? 350 });
  lines.push({ label: 'Recording and reconveyance', amount: i.recording ?? 120 });
  if (i.hoaTransfer) lines.push({ label: 'HOA transfer / reinvestment fee', amount: i.hoaTransfer });
  if (i.sellerConcessions) lines.push({ label: 'Seller concessions to buyer', amount: i.sellerConcessions });
  if (i.repairs) lines.push({ label: 'Repairs / credits', amount: i.repairs });
  if (i.homeWarranty) lines.push({ label: 'Home warranty', amount: i.homeWarranty });
  if (i.annualTaxes && i.closingOn) {
    // Utah property tax is billed in November for the calendar year; prorate the seller's share Jan 1 through closing.
    const [y, m, d] = i.closingOn.split('-').map(Number);
    const dayOfYear = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000) + 1;
    const share = Math.round(i.annualTaxes * dayOfYear / 365);
    lines.push({ label: `Property tax proration (${dayOfYear} days of $${new Intl.NumberFormat('en-US').format(i.annualTaxes)})`, amount: share });
  }
  for (const o of i.other ?? []) lines.push({ label: o.label, amount: o.amount });
  const totalCosts = lines.reduce((a, l) => a + l.amount, 0);
  const agentGross = listingFee;
  return { lines, totalCosts, net: i.salePrice - totalCosts, agentGross, agentAfterFee: agentGross - (i.brokerageTransactionFee ?? 495) };
}
