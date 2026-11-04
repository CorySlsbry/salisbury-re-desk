/** The confidence loop's memory, backed by the agent_lessons table, plus the one accuracy bar every job reads. */
import * as repo from './repo';
import type { LessonStore } from './loop';

export function dbLessons(): LessonStore {
  return {
    async load(job) {
      try { return (await repo.listLessons(job)).map(r => ({ job: r.job, failure_signature: r.failure_signature, strategy_failed: r.strategy_failed, strategy_worked: r.strategy_worked, hint: r.hint, count: r.count })); }
      catch { return []; }
    },
    async save(l) { try { await repo.saveLesson(l); } catch { /* memory is optional; the loop still works without it */ } },
  };
}

/** Settings > Accuracy bar (agent_confidence_min). 0.95 unless Cory set something sane. */
export async function confidenceBar(): Promise<number> {
  const s = await repo.getSettings().catch(() => ({} as Record<string, string>));
  const v = Number(s.agent_confidence_min);
  return Number.isFinite(v) && v >= 0.5 && v <= 1 ? v : 0.95;
}
