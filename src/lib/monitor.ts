/**
 * The Monitor: a programmed reviewer for anything the local model writes. It has no model of its own.
 * groundingCheck pulls every checkable fact out of an output (dates, money, percentages, phones, emails, street
 * addresses, clock times, capitalised name pairs) and requires each one to appear in the sources the model was given.
 * A fact the sources do not contain is a hallucination until Cory says otherwise. Pure and unit-tested.
 */
import { checkCompliance, type Kind, type Verdict } from './compliance';

export interface Fact { kind: 'date' | 'money' | 'percent' | 'phone' | 'email' | 'address' | 'time' | 'name'; text: string; norm: string; weight: number }
export interface Grounding { score: number; grounded: Fact[]; ungrounded: Fact[] }
export interface MonitorVerdict { ok: boolean; confidence: number; grounding: Grounding; compliance: Verdict; problems: string[] }

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, '0');
/** "September 8, 2026" / "Sept 8 2026" / "9/8/2026" / "2026-09-08" -> "2026-09-08". Year-less forms keep month-day only. */
export function normalizeDate(s: string): string | null {
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${pad(+m[1])}-${pad(+m[2])}`;
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(\d{4}))?$/.exec(s);
  if (m) { const mo = MONTHS[m[1].slice(0, 4).toLowerCase()] ?? MONTHS[m[1].slice(0, 3).toLowerCase()]; if (!mo) return null; return m[3] ? `${m[3]}-${pad(mo)}-${pad(+m[2])}` : `--${pad(mo)}-${pad(+m[2])}`; }
  return null;
}
function normMoney(s: string): string { const k = /k$/i.test(s); const n = Number(s.replace(/[^0-9.]/g, '')); return String(Math.round(k ? n * 1000 : n)); }
function normPhone(s: string): string { return s.replace(/\D/g, '').slice(-10); }
function normTime(s: string): string { const m = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/i.exec(s); if (!m) return s.toLowerCase(); let h = +m[1] % 12; if (m[3].toLowerCase() === 'p') h += 12; return `${pad(h)}:${m[2] ?? '00'}`; }

// Word pairs that look like names but are the app's own vocabulary, weekdays, months or ordinary sentence starts.
const NAME_STOP = new Set(['simple choice', 'real estate', 'equal housing', 'housing opportunity', 'mountain time', 'salisbury re', 're desk', 'utah county', 'complete file', 'due diligence', 'seller disclosure', 'market update', 'weekly update', 'open house', 'thank you', 'earnest money', 'purchase contract', 'buyer broker', 'listing agreement', 'property condition', 'wire fraud', 'lead based', 'next step', 'next steps', 'good morning', 'good afternoon', 'best regards', 'kind regards', 'cory salisbury']);
const WORD_STOP = /^(The|This|That|These|Those|Your|Our|My|His|Her|Their|Please|Here|What|When|Where|Why|How|If|In|On|At|To|For|From|With|And|But|Or|So|As|It|We|You|They|He|She|I|A|An|Of|By|Is|Are|Was|Were|Be|Been|Have|Has|Had|Do|Does|Did|Will|Would|Can|Could|Should|May|Might|Just|Also|Then|Now|Today|Tomorrow|Yesterday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December|Dear|Hi|Hello|Thanks|Thank|Subject|Re|Mr|Mrs|Ms|Dr|Realtor|REALTOR|Utah|Lehi|Provo|Orem|Draper|Sandy|Salt|Lake|City|County|North|South|East|West|Dr|St|Ave|Ln|Rd|Way|Ct|Blvd)$/;

/** Every checkable fact in a text. Names weigh half: they are the noisiest signal. */
export function extractFacts(text: string): Fact[] {
  const out: Fact[] = []; const seen = new Set<string>();
  const add = (kind: Fact['kind'], t: string, norm: string, weight = 1) => { const k = `${kind}:${norm}`; if (norm && !seen.has(k)) { seen.add(k); out.push({ kind, text: t, norm, weight }); } };
  for (const m of text.matchAll(/\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b/g)) { const n = normalizeDate(m[0]); if (n) add('date', m[0], n, n.startsWith('--') ? 0.5 : 1); }
  for (const m of text.matchAll(/\$\s?\d[\d,]*(?:\.\d+)?\s?[kK]?\b/g)) add('money', m[0], normMoney(m[0]));
  for (const m of text.matchAll(/\b\d+(?:\.\d+)?\s?%/g)) add('percent', m[0], m[0].replace(/[^0-9.]/g, ''));
  for (const m of text.matchAll(/\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}\b/g)) add('phone', m[0], normPhone(m[0]));
  for (const m of text.matchAll(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g)) add('email', m[0], m[0].toLowerCase());
  for (const m of text.matchAll(/\b\d{2,6}\s+(?:[NSEW]\s+)?[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3}\s+(?:Dr|Drive|St|Street|Ave|Avenue|Ln|Lane|Rd|Road|Way|Ct|Court|Blvd|Cir|Circle|Pl|Place|Loop|Trail|Trl)\b\.?/g)) add('address', m[0], m[0].toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' '));
  for (const m of text.matchAll(/\b\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?\b/gi)) add('time', m[0], normTime(m[0]));
  for (const m of text.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*[ap]\.?m)/gi)) add('time', m[0], `${pad(+m[1])}:${m[2]}`);
  for (const m of text.matchAll(/\b([A-Z][a-z]{1,20})\s+([A-Z][a-z]{1,20})\b/g)) {
    const pair = `${m[1]} ${m[2]}`;
    if (WORD_STOP.test(m[1]) || WORD_STOP.test(m[2]) || NAME_STOP.has(pair.toLowerCase())) continue;
    add('name', pair, pair.toLowerCase(), 0.5);
  }
  return out;
}

/** Does this fact appear in the sources, in any spelling the app understands? */
function present(f: Fact, sourceText: string, sourceFacts: Set<string>): boolean {
  if (sourceFacts.has(`${f.kind}:${f.norm}`)) return true;
  const lower = sourceText.toLowerCase();
  if (lower.includes(f.text.toLowerCase())) return true;
  if (f.kind === 'date' && f.norm.startsWith('--')) return [...sourceFacts].some(k => k.startsWith('date:') && k.endsWith(f.norm.slice(1)));
  if (f.kind === 'money' || f.kind === 'percent' || f.kind === 'phone') return lower.replace(/[^0-9a-z@.]/g, '').includes(f.norm) || sourceText.includes(f.norm);
  if (f.kind === 'name') { const [a, b] = f.norm.split(' '); return lower.includes(`${b}, ${a}`) || lower.includes(`${a} ${b}`); }
  return false;
}

export function groundingCheck(output: string, sources: string[]): Grounding {
  const sourceText = sources.join('\n');
  const sourceFacts = new Set(extractFacts(sourceText).map(f => `${f.kind}:${f.norm}`));
  const grounded: Fact[] = [], ungrounded: Fact[] = [];
  for (const f of extractFacts(output)) (present(f, sourceText, sourceFacts) ? grounded : ungrounded).push(f);
  const total = [...grounded, ...ungrounded].reduce((s, f) => s + f.weight, 0);
  const bad = ungrounded.reduce((s, f) => s + f.weight, 0);
  return { score: total ? Math.max(0, 1 - bad / total) : 1, grounded, ungrounded };
}

/** One verdict for a model output: compliance is a hard gate, grounding is the confidence. */
export function verdictFor(output: string, sources: string[], kind: Kind = 'text', opts: { mortgage?: boolean } = {}): MonitorVerdict {
  const compliance = checkCompliance(output, kind, opts);
  const grounding = groundingCheck(output, sources);
  const problems = [
    ...compliance.problems.map(p => `compliance:${p.type}:${p.what.slice(0, 60)}`),
    ...grounding.ungrounded.map(f => `ungrounded:${f.kind}:${f.text}`),
  ];
  return { ok: compliance.ok && grounding.ungrounded.length === 0, confidence: compliance.ok ? grounding.score : 0, grounding, compliance, problems };
}

/** Sentence-level repair for the drafts ladder: keep only sentences whose facts are all grounded. */
export function dropUngroundedSentences(output: string, sources: string[]): string {
  const sentences = output.split(/(?<=[.!?])\s+|\n+/);
  const kept = sentences.filter(s => groundingCheck(s, sources).ungrounded.length === 0);
  return kept.join(' ').replace(/\s{2,}/g, ' ').trim();
}
