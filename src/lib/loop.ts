/**
 * The confidence loop every model job runs inside: read -> research -> task -> test, up to five passes, complete only
 * above the accuracy bar (Settings, 95% by default). Passes 1 and 2 keep the approach and feed the reviewer's findings
 * back. If pass 2 still fails, the failure is not reconciled and each later pass steps down the job's strategy
 * ladder. After the last pass the job fails loudly: the caller gets ok=false and the problems, never a silent partial.
 *
 * Self-improvement is memory, not code: for a job and a failure signature the loop remembers which strategy failed and
 * which one finally passed, and starts there next time. Lessons come only from the loop's own deterministic verdicts.
 */
export interface Failure { pass: number; strategy: string; confidence: number; problems: string[] }
export interface TestResult { confidence: number; problems: string[] }
export interface Job<C, O> {
  name: string;
  /** Strategy ladder, index 0 is the normal approach; later rungs are different approaches, ending with the safest. */
  strategies: string[];
  read: (ctx: C) => Promise<void>;
  research: (ctx: C, pass: number, failures: Failure[]) => Promise<void>;
  task: (ctx: C, strategy: string, failures: Failure[], hints: string[]) => Promise<O>;
  test: (out: O, ctx: C) => Promise<TestResult>;
  timeCapMs: number;
}
export interface Lesson { job: string; failure_signature: string; strategy_failed: string; strategy_worked: string | null; hint: string; count: number }
export interface LessonStore {
  load: (job: string) => Promise<Lesson[]>;
  save: (l: Omit<Lesson, 'count'>) => Promise<void>;
}
export interface LoopResult<O> { ok: boolean; output: O | null; confidence: number; passes: number; strategy: string; switched: boolean; failures: Failure[]; lessonsUsed: string[]; elapsedMs: number; timedOut: boolean }
export interface LoopOptions { bar?: number; maxPasses?: number; lessons?: LessonStore; now?: () => number; onStep?: (s: string) => void }

/** A failure signature keeps only the kind of each problem ("ungrounded:date", "schema:truncated"), sorted and unique. */
export function signatureOf(problems: string[]): string {
  return [...new Set(problems.map(p => p.split(':').slice(0, 2).join(':')))].sort().join('|') || 'unknown';
}

/** In-memory lessons, for tests and for callers without a database. */
export function memoryLessons(seed: Lesson[] = []): LessonStore & { rows: Lesson[] } {
  const rows = [...seed];
  return {
    rows,
    async load(job) { return rows.filter(r => r.job === job).sort((a, b) => b.count - a.count); },
    async save(l) {
      const cur = rows.find(r => r.job === l.job && r.failure_signature === l.failure_signature);
      if (cur) { cur.count++; cur.strategy_failed = l.strategy_failed; if (l.strategy_worked) cur.strategy_worked = l.strategy_worked; if (l.hint) cur.hint = l.hint; }
      else rows.push({ ...l, count: 1 });
    },
  };
}

export async function runWithConfidence<C, O>(job: Job<C, O>, ctx: C, opts: LoopOptions = {}): Promise<LoopResult<O>> {
  const bar = opts.bar ?? 0.95, max = opts.maxPasses ?? 5, now = opts.now ?? (() => Date.now());
  const t0 = now();
  const lessons = opts.lessons ? await opts.lessons.load(job.name) : [];
  const lessonsUsed: string[] = [];
  const ladder = job.strategies.length ? job.strategies : ['default'];
  await job.read(ctx);
  const failures: Failure[] = [];
  let idx = 0, switched = false, last: O | null = null, lastConf = 0, timedOut = false;
  for (let pass = 1; pass <= max; pass++) {
    if (now() - t0 > job.timeCapMs) { timedOut = true; break; }
    const lastSig = failures.length ? signatureOf(failures[failures.length - 1].problems) : null;
    // A remembered win for this exact failure jumps straight to the strategy that worked last time.
    const remembered = lastSig ? lessons.find(l => l.failure_signature === lastSig && l.strategy_worked && ladder.includes(l.strategy_worked)) : null;
    if (remembered && ladder.indexOf(remembered.strategy_worked!) > idx) { idx = ladder.indexOf(remembered.strategy_worked!); switched = true; lessonsUsed.push(remembered.failure_signature); }
    else if (pass >= 3 && idx < ladder.length - 1) { idx++; switched = true; }
    const strategy = ladder[idx];
    const hints = lessons.filter(l => l.hint && (!lastSig || l.failure_signature === lastSig)).slice(0, 3).map(l => l.hint);
    opts.onStep?.(pass === 1 ? `Pass 1 (${strategy})` : `Pass ${pass} of ${max}: ${switched ? 'different approach, ' : ''}${strategy}`);
    await job.research(ctx, pass, failures);
    let out: O; let test: TestResult;
    try { out = await job.task(ctx, strategy, failures, hints); test = await job.test(out, ctx); }
    catch (e) { out = null as O; test = { confidence: 0, problems: [`error:${String(e).slice(0, 80)}`] }; }
    last = out; lastConf = test.confidence;
    if (test.confidence > bar) {
      if (opts.lessons) for (const f of failures) await opts.lessons.save({ job: job.name, failure_signature: signatureOf(f.problems), strategy_failed: f.strategy, strategy_worked: strategy, hint: hintFrom(f.problems) });
      return { ok: true, output: out, confidence: test.confidence, passes: pass, strategy, switched, failures, lessonsUsed, elapsedMs: now() - t0, timedOut: false };
    }
    failures.push({ pass, strategy, confidence: test.confidence, problems: test.problems });
  }
  if (opts.lessons && failures.length) { const f = failures[failures.length - 1]; await opts.lessons.save({ job: job.name, failure_signature: signatureOf(f.problems), strategy_failed: f.strategy, strategy_worked: null, hint: hintFrom(f.problems) }); }
  return { ok: false, output: last, confidence: lastConf, passes: failures.length, strategy: ladder[idx], switched, failures, lessonsUsed, elapsedMs: now() - t0, timedOut };
}

/** One plain line the loop can put in front of the model next time. Built from problem kinds only, never from document text. */
export function hintFrom(problems: string[]): string {
  const kinds = new Set(problems.map(p => p.split(':').slice(0, 2).join(':')));
  const lines: string[] = [];
  if ([...kinds].some(k => k.startsWith('ungrounded:date'))) lines.push('Use only dates that appear in the source; never infer a date.');
  if ([...kinds].some(k => k.startsWith('ungrounded:money') || k.startsWith('ungrounded:percent'))) lines.push('Copy amounts and percentages exactly as written; do not compute new ones.');
  if ([...kinds].some(k => k.startsWith('ungrounded:name') || k.startsWith('ungrounded:address'))) lines.push('Use names and addresses exactly as given; do not add people or places.');
  if (kinds.has('schema:truncated') || kinds.has('schema:invalid-json')) lines.push('Return shorter JSON: fewer items, shorter strings, valid syntax.');
  if ([...kinds].some(k => k.startsWith('quote-mismatch'))) lines.push('The quote must be copied word for word from the page.');
  if ([...kinds].some(k => k.startsWith('missed') || k.startsWith('blank-line'))) lines.push('The field is on the document: find the filled-in value next to its label. A run of underscores is an empty line, never a value.');
  if ([...kinds].some(k => k.startsWith('value-bad-format'))) lines.push('The value must look like the field type (a real percentage, a phone number, a date); a fee of 0 is a wrong field.');
  if ([...kinds].some(k => k.startsWith('compliance'))) lines.push('Keep the brokerage name and Equal Housing line; never name a former brokerage.');
  return lines.join(' ');
}
