/**
 * Deadline engine. Pure, no I/O. Rules come from the Utah REPC text (state form eff. 2024-12-04):
 *  - §21: performance by 5:00 PM Mountain on the stated date; "days" = calendar days counted
 *    beginning the day AFTER the triggering event; extensions only in writing (addendum).
 *  - §24: exactly four contract deadlines, written as absolute dates.
 *  - Earnest money: 4 calendar days after Acceptance (§23: signed AND communicated).
 *  - §11: walk-through no earlier than 7 calendar days before Settlement.
 *  - There is NO weekend/holiday rollover in the REPC. A Sunday deadline is a Sunday deadline.
 * Business days (Utah + federal holidays, incl. Pioneer Day) apply ONLY to broker/ICA obligations.
 */
export type DeadlineType =
  | 'seller_disclosure' | 'due_diligence' | 'financing_appraisal' | 'settlement'
  | 'emd_to_brokerage' | 'emd_to_trust' | 'additional_emd'
  | 'walkthrough_window_opens' | 'closing_recorded'
  | 'broker_listing_file' | 'broker_contract_file' | 'broker_status_statement' | 'record_retention_end'
  | 'listing_expires' | 'bba_expires' | 'broker_bba_file' | 'hoa_records_due';

export type Basis = 'contract' | 'derived' | 'broker' | 'practice' | 'compliance';

export interface Deadline {
  type: DeadlineType;
  label: string;
  dueOn: string;      // YYYY-MM-DD
  dueTime: string;    // HH:MM, America/Denver
  basis: Basis;
  reminderOn?: string;
  note?: string;
  waived?: boolean;
}

export interface RepcDates {
  acceptanceOn: string;                    // Day 0 (signed AND communicated)
  sellerDisclosureOn?: string | null;      // §24(a)
  dueDiligenceOn?: string | null;          // §24(b)
  financingAppraisalOn?: string | null;    // §24(c)  (null for cash)
  settlementOn?: string | null;            // §24(d)
  emdReceivedOn?: string | null;           // when the brokerage actually received EMD
  additionalEmd?: boolean;                 // §8.4 elected
  isCash?: boolean;
}

export interface Flag { level: 'error' | 'warn' | 'info'; message: string }

export const DEFAULT_TIME = '17:00';

/* ---------- date helpers (YYYY-MM-DD strings, UTC math, no timezone drift) ---------- */
function pad(n: number): string { return String(n).padStart(2, '0'); }
function iso(y: number, m: number, d: number): string { return `${y}-${pad(m)}-${pad(d)}`; }

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  // UTC-DAY-OK: pure calendar arithmetic on a YYYY-MM-DD string; no wall clock is read, so no zone can shift it
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function dayOfWeek(date: string): number { // 0 = Sunday
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  let count = 0;
  for (let d = 1; d <= 31; d++) {
    const s = iso(year, month, d);
    if (dayOfWeek(s) === weekday && ++count === n) return s;
  }
  throw new Error('nthWeekday out of range');
}
function lastWeekday(year: number, month: number, weekday: number): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let d = last; d >= 1; d--) {
    const s = iso(year, month, d);
    if (dayOfWeek(s) === weekday) return s;
  }
  throw new Error('lastWeekday out of range');
}
function observed(date: string): string { // federal observance: Saturday -> Friday, Sunday -> Monday
  const dow = dayOfWeek(date);
  if (dow === 6) return addDays(date, -1);
  if (dow === 0) return addDays(date, 1);
  return date;
}

/** Utah state + federal holidays as observed. Business-day math only; never applied to REPC dates. */
export function utahHolidays(year: number): Set<string> {
  return new Set([
    observed(iso(year, 1, 1)),        // New Year's Day
    nthWeekday(year, 1, 1, 3),        // MLK Day
    nthWeekday(year, 2, 1, 3),        // Presidents' Day
    lastWeekday(year, 5, 1),          // Memorial Day
    observed(iso(year, 6, 19)),       // Juneteenth
    observed(iso(year, 7, 4)),        // Independence Day
    observed(iso(year, 7, 24)),       // Pioneer Day (Utah)
    nthWeekday(year, 9, 1, 1),        // Labor Day
    nthWeekday(year, 10, 1, 2),       // Columbus Day
    observed(iso(year, 11, 11)),      // Veterans Day
    nthWeekday(year, 11, 4, 4),       // Thanksgiving
    observed(iso(year, 12, 25)),      // Christmas
  ]);
}
export function isBusinessDay(date: string): boolean {
  const dow = dayOfWeek(date);
  if (dow === 0 || dow === 6) return false;
  return !utahHolidays(Number(date.slice(0, 4))).has(date);
}
/** n business days after date (the day after date is the first counted day). Negative n walks back. */
export function addBusinessDays(date: string, n: number): string {
  let cur = date;
  let left = Math.abs(n);
  const step = n < 0 ? -1 : 1;
  while (left > 0) {
    cur = addDays(cur, step);
    if (isBusinessDay(cur)) left--;
  }
  return cur;
}
/** REPC calendar-day count: the day after the trigger is day 1. */
export function repcDays(triggerOn: string, days: number): string { return addDays(triggerOn, days); }

/* ---------- reminder lead times (days before the deadline) ---------- */
export const REMINDER_LEAD: Partial<Record<DeadlineType, number>> = {
  seller_disclosure: 3,
  due_diligence: 3,
  financing_appraisal: 4,
  settlement: 4,
  walkthrough_window_opens: 3,
  additional_emd: 2,
  broker_listing_file: 1,
  broker_contract_file: 1,
  broker_status_statement: 3,
  listing_expires: 14,
};

/* ---------- the engine ---------- */
export function computeRepcDeadlines(r: RepcDates): { deadlines: Deadline[]; flags: Flag[] } {
  const out: Deadline[] = [];
  const flags: Flag[] = [];
  const push = (d: Deadline) => {
    const lead = REMINDER_LEAD[d.type];
    if (lead && !d.reminderOn && !d.waived) d.reminderOn = addDays(d.dueOn, -lead);
    out.push(d);
  };
  const A = r.acceptanceOn;

  // Earnest money: 4 calendar days after Acceptance to the brokerage; brokerage has 4 calendar days to deposit.
  const emdDue = repcDays(A, 4);
  push({ type: 'emd_to_brokerage', label: 'Earnest money to brokerage', dueOn: emdDue, dueTime: DEFAULT_TIME, basis: 'derived', reminderOn: addBusinessDays(emdDue, -2), note: 'REPC: 4 calendar days after Acceptance' });
  if (r.emdReceivedOn) {
    push({ type: 'emd_to_trust', label: 'Brokerage deposits EMD to trust', dueOn: repcDays(r.emdReceivedOn, 4), dueTime: DEFAULT_TIME, basis: 'broker', note: 'REPC: 4 calendar days after receipt (R162-2f-401c: 3 business days)' });
  }

  const four: Array<[DeadlineType, string, string | null | undefined]> = [
    ['seller_disclosure', 'Seller Disclosure Deadline (REPC 24a)', r.sellerDisclosureOn],
    ['due_diligence', 'Due Diligence Deadline (REPC 24b)', r.dueDiligenceOn],
    ['financing_appraisal', 'Financing & Appraisal Deadline (REPC 24c)', r.financingAppraisalOn],
    ['settlement', 'Settlement Deadline (REPC 24d)', r.settlementOn],
  ];
  for (const [type, label, on] of four) {
    if (!on) {
      if (type === 'financing_appraisal' && r.isCash) {
        push({ type, label, dueOn: A, dueTime: DEFAULT_TIME, basis: 'contract', waived: true, note: 'Cash offer: no Financing & Appraisal deadline' });
      } else {
        push({ type, label, dueOn: A, dueTime: DEFAULT_TIME, basis: 'contract', waived: true, note: 'NOT SPECIFIED on the contract' });
        flags.push({ level: 'warn', message: `${label} is blank on the contract` });
      }
      continue;
    }
    push({ type, label, dueOn: on, dueTime: DEFAULT_TIME, basis: 'contract' });
    if (on < A) flags.push({ level: 'error', message: `${label} (${on}) is before Acceptance (${A})` });
    const dow = dayOfWeek(on);
    if (dow === 0 || dow === 6) flags.push({ level: 'info', message: `${label} falls on a weekend and does NOT roll over (REPC 21)` });
    else if (!isBusinessDay(on)) flags.push({ level: 'info', message: `${label} falls on a holiday and does NOT roll over (REPC 21)` });
  }

  const sd = r.sellerDisclosureOn, dd = r.dueDiligenceOn, fa = r.financingAppraisalOn, st = r.settlementOn;
  if (sd && dd && sd > dd) flags.push({ level: 'error', message: 'Seller Disclosure Deadline is after Due Diligence Deadline' });
  if (dd && st && dd > st) flags.push({ level: 'error', message: 'Due Diligence Deadline is after Settlement Deadline' });
  if (fa && st && fa > st) flags.push({ level: 'error', message: 'Financing & Appraisal Deadline is after Settlement Deadline' });
  if (dd && fa && dd > fa) flags.push({ level: 'warn', message: 'Due Diligence Deadline is after Financing & Appraisal Deadline (unusual)' });

  if (r.additionalEmd && (dd || fa)) {
    const later = [dd, fa].filter((x): x is string => !!x).sort().pop() as string;
    push({ type: 'additional_emd', label: 'Additional earnest money (REPC 8.4)', dueOn: later, dueTime: DEFAULT_TIME, basis: 'contract', note: 'later of Due Diligence / Financing & Appraisal' });
  }
  if (st) {
    push({ type: 'walkthrough_window_opens', label: 'Walk-through window opens (REPC 11)', dueOn: repcDays(st, -7), dueTime: '09:00', basis: 'derived', note: 'no earlier than 7 calendar days before Settlement' });
    push({ type: 'broker_status_statement', label: 'Broker 30-day status statement due', dueOn: repcDays(A, 30), dueTime: DEFAULT_TIME, basis: 'compliance', note: 'R162-2f-401c: within 30 days of acceptance and every 30 days until closing' });
    push({ type: 'broker_contract_file', label: 'Submit executed contract to Simple Choice', dueOn: addBusinessDays(A, 2), dueTime: DEFAULT_TIME, basis: 'broker', note: 'ICA 6.2(b): 2 business days after binding' });
  }
  out.sort((a, b) => (a.dueOn + a.dueTime).localeCompare(b.dueOn + b.dueTime));
  return { deadlines: out, flags };
}

export function computeListingDeadlines(signedOn: string, expiresOn?: string | null): Deadline[] {
  return computeAgreementDeadlines('listing_agreement', signedOn, expiresOn);
}

/**
 * Representation agreements (UAR listing agreement / Exclusive Buyer-Broker Agreement): the broker file is due
 * 3 business days after signing (ICA 6.2(a)); the agreement itself ENDS at 5:00 PM Mountain on its End Date.
 */
export function computeAgreementDeadlines(kind: 'listing_agreement' | 'bba', signedOn: string, expiresOn?: string | null): Deadline[] {
  const listing = kind === 'listing_agreement';
  const out: Deadline[] = [{
    type: listing ? 'broker_listing_file' : 'broker_bba_file', label: listing ? 'Submit listing file to Simple Choice' : 'Submit buyer-broker agreement to Simple Choice',
    dueOn: addBusinessDays(signedOn, 3), dueTime: DEFAULT_TIME, basis: 'broker', note: 'ICA 6.2(a): 3 business days after signing', reminderOn: addBusinessDays(signedOn, 2),
  }];
  if (expiresOn) out.push({ type: listing ? 'listing_expires' : 'bba_expires', label: listing ? 'Listing agreement ends (5:00 PM)' : 'Buyer-broker agreement ends (5:00 PM)', dueOn: expiresOn, dueTime: DEFAULT_TIME, basis: 'contract', reminderOn: addDays(expiresOn, -14), note: 'Extend in writing before this date if the client is still active.' });
  return out;
}

/** Retention: 3 calendar years after the year in which the transaction closed or failed (R162-2f-401k). */
export function retentionEnd(closedOrFailedOn: string): string { return `${Number(closedOrFailedOn.slice(0, 4)) + 3}-12-31`; }

/** Practitioner defaults: real dates, on Thursdays, about a week apart. */
export function suggestRepcDates(acceptanceOn: string, opts: { isCash?: boolean } = {}): RepcDates {
  const nextThu = (from: string, weeks: number) => {
    let d = addDays(from, 7 * weeks);
    while (dayOfWeek(d) !== 4) d = addDays(d, 1);
    return d;
  };
  return {
    acceptanceOn,
    isCash: !!opts.isCash,
    sellerDisclosureOn: nextThu(acceptanceOn, 1),
    dueDiligenceOn: nextThu(acceptanceOn, 2),
    financingAppraisalOn: opts.isCash ? null : nextThu(acceptanceOn, 3),
    settlementOn: nextThu(acceptanceOn, opts.isCash ? 3 : 4),
  };
}
