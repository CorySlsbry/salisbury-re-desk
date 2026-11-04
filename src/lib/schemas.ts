/**
 * The hard-coded shape of everything the local model is allowed to hand back. A model answer that does not fit is not
 * "mostly right": it fails the schema gate and the loop tries again. Written for this app's four model jobs only.
 */
import { z } from 'zod';

export const ExtractionAnswer = z.strictObject({
  key: z.string().min(1).max(60),
  value: z.string().max(200),
  page: z.coerce.number().int().min(0).max(999),
  quote: z.string().max(240),
  found: z.boolean(),
});
export const ExtractionAnswers = z.strictObject({ answers: z.array(ExtractionAnswer).max(12) });
export type ExtractionAnswersT = z.infer<typeof ExtractionAnswers>;

export const PacketPick = z.strictObject({
  form_number: z.coerce.number().int().positive(),
  situation: z.string().max(60),
  required_when: z.enum(['pre1978', 'hoa', 'if_applicable']),
  reason: z.string().max(140),
});
export const PacketPicks = z.strictObject({ picks: z.array(PacketPick).max(12) });
export type PacketPicksT = z.infer<typeof PacketPicks>;

/** The polish job rewrites a programmed draft; it may only return text. */
export const Polish = z.strictObject({ text: z.string().min(1).max(6000) });
export type PolishT = z.infer<typeof Polish>;

/** Arguments the agents' read-only tools accept. Anything else (extra keys, wrong types, out-of-range) is refused before a query runs. */
const days = z.coerce.number().int().min(0).max(365).optional();
export const TOOL_ARGS: Record<string, z.ZodType> = {
  list_deadlines: z.strictObject({ days_ahead: days }),
  list_tasks: z.strictObject({ days_ahead: days }),
  list_transactions: z.strictObject({}),
  packet_status: z.strictObject({ transaction_id: z.coerce.number().int().positive().optional() }),
  birthdays_today: z.strictObject({}),
  list_leads: z.strictObject({ stage: z.enum(['lead', 'nurture', 'client', 'past', 'lost']).optional() }),
  touches_today: z.strictObject({}),
  list_ideas: z.strictObject({}),
  reel_schedule: z.strictObject({ count: z.coerce.number().int().min(1).max(20).optional() }),
  posts_today: z.strictObject({}),
};
export function parseToolArgs(name: string, raw: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const schema = TOOL_ARGS[name];
  if (!schema) return { ok: false, error: `unknown tool ${name}` };
  const r = schema.safeParse(raw ?? {});
  if (!r.success) return { ok: false, error: `arguments rejected for ${name}: ${r.error.issues.map(i => `${i.path.join('.') || 'root'} ${i.message}`).join('; ')}` };
  return { ok: true, args: r.data as Record<string, unknown> };
}
