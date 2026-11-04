/**
 * Salisbury RE Desk's compliance gate. Deterministic, this app's own rule table; runs on every client-facing draft
 * and on every model output through the Monitor.
 * What it enforces and why: the registered brokerage name and the Equal Housing line on client-facing text
 * (Utah 61-2f + R162-2f advertising rules); no Fair Housing framing about WHO a home is for (federal + Utah Fair
 * Housing); the "not a mortgage broker" disclaimer whenever mortgage math appears (RESPA, Cory's rule of 2026-08-03);
 * no client-count claims; the tenure claim in one fixed wording. Former brokerage names are banned strings only.
 */
export type Kind = 'page' | 'email' | 'text' | 'social' | 'video';

export interface Problem { type: 'MISSING' | 'BANNED'; what: string; match?: string }
export interface Verdict { ok: boolean; problems: Problem[] }

export const BROKERAGE = 'Simple Choice Real Estate';
export const EHO = 'Equal Housing Opportunity';
export const TENURE_OK = 'helping Utah families since 2014';

const REQUIRE: Array<[RegExp, string, Kind[]]> = [
  [/Simple\s+Choice\s+Real\s+Estate/i, `brokerage attribution (exact string "${BROKERAGE}")`, ['page', 'email', 'video']],
  [/Equal\s+Housing\s+Opportunity/i, 'Equal Housing Opportunity notice', ['page', 'email', 'video']],
];

const MLO_DISCLAIMER = /not\s+(a\s+)?mortgage\s+(broker|lender)|not\s+(mortgage|financial|legal).{0,40}advice|licensed\s+lender/i;

const BANNED: Array<[RegExp, string]> = [
  [/KW\s+Westfield|Keller\s+Williams|\bKWW\b|kw\.com/i, 'Former brokerage string (KW Westfield / Keller Williams). Brokerage is now Simple Choice Real Estate.'],
  [/Sweet\s+(Homes\s+Utah|Utah\s+Homes)|Equity\s+Real\s+Estate/i, 'Dead brokerage name. Brokerage is Simple Choice Real Estate.'],
  [/\b\d{2,}\s*\+?\s*(families|clients|homes\s+sold)\b|hundreds of families/i, 'Client-count claim. Length of service is fine ("since 2014"); client counts are not.'],
  [/since\s+2012|1[0-3]\+?\s*years/i, 'Wrong tenure. License issued 2014-01-14: use "since 2014".'],
  [/perfect for (young )?(families|couples|newlyweds|singles|professionals)|great for (a )?(growing|young) famil|starter home for a (growing|young) famil|safe neighborhood|family[- ]friendly neighborhood|good schools nearby|ideal for (christian|retirees|bachelors)|no (kids|children)|adults? only|exclusive (community|neighborhood)/i,
    'Fair Housing: describes WHO the content is for (protected-class framing). Describe the property or the process, never the people.'],
  [/\bfor\s+sale\b/i, '"for sale" in social copy. Frame as "check out this home" and credit "listed by [agent]".'],
  [/\bguarantee[sd]?\b.{0,40}\b(sell|sold|price|offer)/i, 'Outcome guarantee language on a listing/sale. Remove or route through the broker.'],
  [/(this|that) is (legal|tax) advice|you should (sue|litigate)/i, 'Legal/tax advice (ICA 11.4). Refer to counsel.'],
  [/wire (instructions|info)[^.]{0,80}(attached|below|here)/i, 'Wiring instructions in writing (ICA 10.3). Never send or confirm wire details by email or text.'],
];

export function checkCompliance(text: string, kind: Kind = 'page', opts: { mortgage?: boolean } = {}): Verdict {
  const problems: Problem[] = [];
  for (const [rx, what, kinds] of REQUIRE) {
    if (!kinds.includes(kind)) continue;
    if (!rx.test(text)) problems.push({ type: 'MISSING', what });
  }
  const touchesMoney = opts.mortgage ?? /\b(apr|interest rate|monthly payment|down payment|pre-?approv|dti|mortgage|loan)\b/i.test(text);
  if (touchesMoney && !MLO_DISCLAIMER.test(text)) problems.push({ type: 'MISSING', what: 'Not-a-mortgage-broker disclaimer (this text touches money or financing)' });
  for (const [rx, what] of BANNED) {
    if (what.startsWith('"for sale"') && kind !== 'social') continue;
    const m = rx.exec(text);
    if (m) problems.push({ type: 'BANNED', what, match: m[0].slice(0, 60) });
  }
  return { ok: problems.length === 0, problems };
}

/** Standard footer for client-facing pages and emails. */
export function complianceFooter(): string {
  return `Cory Salisbury, REALTOR | ${BROKERAGE} | Utah license 5072842-SA00 | ${EHO}`;
}
