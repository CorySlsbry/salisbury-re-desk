/**
 * Turn whatever the local model printed into a checked object, or say exactly why it could not.
 * Pure: no model, no database. Strips think-blocks and code fences, rescues a truncated array of objects, then
 * validates against the job's zod schema.
 */
import type { z } from 'zod';

export interface Parsed<T> { ok: boolean; data: T | null; problems: string[]; salvaged: boolean }

/** Complete top-level objects inside the first JSON array found after `key` (balanced braces, string-aware). */
export function salvageArrayObjects(raw: string, key: string): unknown[] {
  const at = raw.indexOf(`"${key}"`); if (at < 0) return [];
  const start = raw.indexOf('[', at); if (start < 0) return [];
  const out: unknown[] = [];
  let depth = 0, inStr = false, esc = false, objStart = -1;
  for (let i = start + 1; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) objStart = i; depth++; continue; }
    if (ch === '}') { depth--; if (depth === 0 && objStart >= 0) { try { out.push(JSON.parse(raw.slice(objStart, i + 1))); } catch { /* skip a broken object */ } objStart = -1; } continue; }
    if (ch === ']' && depth === 0) break;
  }
  return out;
}

export function parseModelJson<T>(schema: z.ZodType<T>, raw: string, opts: { arrayKey?: string } = {}): Parsed<T> {
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/gi, '').trim();
  const problems: string[] = [];
  let candidate: unknown = null; let salvaged = false;
  const a = cleaned.indexOf('{'), b = cleaned.lastIndexOf('}');
  if (a >= 0 && b > a) { try { candidate = JSON.parse(cleaned.slice(a, b + 1)); } catch (e) { problems.push(`schema:invalid-json:${String(e).slice(0, 60)}`); } }
  else problems.push('schema:no-json');
  if (candidate == null && opts.arrayKey) {
    const items = salvageArrayObjects(cleaned, opts.arrayKey);
    if (items.length) { candidate = { [opts.arrayKey]: items }; salvaged = true; problems.push('schema:truncated'); }
  }
  if (candidate == null) return { ok: false, data: null, problems: problems.length ? problems : ['schema:no-json'], salvaged };
  const r = schema.safeParse(candidate);
  if (!r.success) {
    for (const i of r.error.issues.slice(0, 8)) problems.push(`schema:${i.path.join('.') || 'root'}:${i.message}`);
    return { ok: false, data: null, problems, salvaged };
  }
  return { ok: true, data: r.data, problems, salvaged };
}
