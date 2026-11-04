/** Thin typed wrappers over the Rust commands and the SQLite plugin. Single reader of every shape. */
import { invoke } from '@tauri-apps/api/core';
import Database from '@tauri-apps/plugin-sql';

export interface AppPaths {
  root: string; db_url: string; clients: string; forms_state: string; forms_uar: string;
  templates: string; backups: string; models: string; resources: string;
}

let _paths: AppPaths | null = null;
let _db: Database | null = null;

export async function appPaths(): Promise<AppPaths> {
  if (!_paths) _paths = await invoke<AppPaths>('app_paths');
  return _paths;
}
export async function db(): Promise<Database> {
  if (!_db) { const p = await appPaths(); _db = await Database.load(p.db_url); }
  return _db;
}
export const native = {
  createClientFolder: (folderName: string) => invoke<string>('create_client_folder', { folderName }),
  fileIntoVault: (src: string, destDir: string, fileName: string) => invoke<[string, string, number]>('file_into_vault', { src, destDir, fileName }),
  sha256File: (path: string) => invoke<[string, number]>('sha256_file', { path }),
  writeText: (path: string, contents: string) => invoke<void>('write_text', { path, contents }),
  listDir: (path: string) => invoke<[string, number, boolean][]>('list_dir', { path }),
  downloadFile: (url: string, dest: string) => invoke<[string, number]>('download_file', { url, dest }),
  /** Locate a street address through Rust (the geocoders do not allow browser calls): [lat, lng, matched address, source] or null. */
  geocodeLookup: (address: string) => invoke<[number, number, string, string] | null>('geocode_lookup', { address }),
  downloadModel: (url: string, dest: string, expectedSha256?: string) => invoke<[string, number]>('download_model', { url, dest, expectedSha256: expectedSha256 ?? null }),
  docStart: () => invoke<string>('doc_start'),
  docCall: <T = unknown>(method: string, params: Record<string, unknown> = {}) => invoke<T>('doc_call', { method, params }),
  llamaStart: (modelPath: string, gpuLayers = 99, threads = 8) => invoke<string>('llama_start', { modelPath, gpuLayers, threads }),
  sidecarsStop: () => invoke<void>('sidecars_stop'),
  appReady: () => invoke<void>('app_ready'),
  oauthListen: (port: number, timeoutSecs = 300) => invoke<string>('oauth_listen', { port, timeoutSecs }),
  /** DPAPI-encrypted per-user secret under %USERPROFILE%\.salisbury-re\secrets (never in the synced DB). Empty value deletes. */
  secretSet: (name: string, value: string) => invoke<void>('secret_set', { name, value }),
  secretGet: (name: string) => invoke<string | null>('secret_get', { name }),
  backupOffdrive: (src: string) => invoke<{ dest: string; bytes: number; kept: number }>('backup_offdrive', { src }),
  bitlockerStatus: () => invoke<{ status: 'on' | 'off' | 'unknown'; detail: string }>('bitlocker_status'),
  splash: (step: string, pct: number) => invoke<void>('splash_progress', { step, pct }).catch(() => {}),
};

/* ---------- document engine result shapes (mirror sidecar/doc/server.py) ---------- */
export interface PdfInfo { pages: number; sha256: string; title: string | null; has_forms: boolean }
export interface PdfPageText { page: number; width: number; height: number; text: string; words: [number, number, number, number, string][] | null }
export interface PdfFields { count: number; fields: Record<string, { value: string | null; type: string }> }
export interface OcrLine { box: [number, number][]; text: string; conf: number }
export interface OcrPage { page: number; dpi: number; lines: OcrLine[]; text: string }

export const doc = {
  info: (path: string) => native.docCall<PdfInfo>('pdf.info', { path }),
  text: (path: string, opts: { pages?: number[]; words?: boolean } = {}) => native.docCall<{ pages: PdfPageText[] }>('pdf.text', { path, ...opts }),
  fields: (path: string) => native.docCall<PdfFields>('pdf.fields', { path }),
  thumb: (path: string, page = 1, dpi = 72, bbox?: [number, number, number, number]) => native.docCall<{ png_b64: string; w: number; h: number }>('pdf.thumb', { path, page, dpi, bbox }),
  ocr: (path: string, page = 1, dpi = 200) => native.docCall<OcrPage>('ocr.page', { path, page, dpi }),
  /** Type values onto a flat form (no AcroForm). box = [x0,y0,x1,y1] of the blank in PDF points. */
  stamp: (path: string, outPath: string, items: Array<{ page: number; box?: [number, number, number, number]; x?: number; y?: number; text: string; size?: number }>) => native.docCall<{ stamped: number; out_path: string }>('pdf.stamp', { path, out_path: outPath, items }),
  /** Build a simple PDF from text blocks (questionnaire, cover sheet, index). */
  make: (outPath: string, blocks: Array<{ text: string; size?: number; bold?: boolean; gap?: number }>) => native.docCall<{ pages: number; out_path: string }>('pdf.make', { out_path: outPath, blocks }),
  fill: (path: string, outPath: string, values: Record<string, string | boolean | null>, flatten = false) => native.docCall<{ filled: number; out_path: string }>('pdf.fill', { path, out_path: outPath, values, flatten }),
};

/* ---------- llama-server (OpenAI-compatible) ---------- */
/** Backend is chosen at boot from llama_start's reply: "llamacpp <url>" or "ollama <url>". */
export const llm = { url: 'http://127.0.0.1:8093', backend: 'llamacpp' as 'llamacpp' | 'ollama', model: 'local' };
export function setLlmBackend(reply: string): void {
  const [backend, url] = reply.split(' ');
  if (backend === 'ollama') { llm.backend = 'ollama'; llm.url = url; llm.model = 'redesk-qwen3-4b'; }
  else { llm.backend = 'llamacpp'; llm.url = url ?? llm.url; llm.model = 'local'; }
}
export async function llamaHealthy(): Promise<boolean> {
  try {
    const r = await fetch(llm.backend === 'ollama' ? `${llm.url}/api/tags` : `${llm.url}/health`);
    if (!r.ok) return false;
    if (llm.backend === 'ollama') { const j = await r.json(); return Array.isArray(j.models) && j.models.some((m: { name: string }) => m.name.startsWith(llm.model)); }
    return true;
  } catch { return false; }
}
/* ---- multi-turn chat with OpenAI-style tools (llama-server --jinja and Ollama both speak it) ---- */
export interface ChatMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: ToolCall[]; tool_call_id?: string; name?: string }
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ToolSpec { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export async function localChatTurn(messages: ChatMessage[], opts: { tools?: ToolSpec[]; temperature?: number; maxTokens?: number; onToken?: (t: string) => void } = {}): Promise<ChatMessage> {
  const body: Record<string, unknown> = { model: llm.model, temperature: opts.temperature ?? 0.2, max_tokens: opts.maxTokens ?? 900, messages, stream: !!opts.onToken && !opts.tools };
  if (opts.tools?.length) body.tools = opts.tools;
  const r = await fetch(`${llm.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`llama ${r.status}: ${await r.text()}`);
  if (!body.stream) {
    const j = await r.json(); const m = j.choices?.[0]?.message ?? {};
    return { role: 'assistant', content: (m.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim(), tool_calls: m.tool_calls };
  }
  const reader = r.body!.getReader(); const dec = new TextDecoder(); let out = ''; let buf = '';
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop() ?? '';
    for (const l of lines) {
      if (!l.startsWith('data: ')) continue; const d = l.slice(6).trim(); if (d === '[DONE]') continue;
      try { const t = JSON.parse(d).choices?.[0]?.delta?.content ?? ''; if (t) { out += t; opts.onToken!(t); } } catch { /* partial */ }
    }
  }
  return { role: 'assistant', content: out };
}

export interface ChatOpts { system?: string; jsonSchema?: Record<string, unknown>; temperature?: number; maxTokens?: number; onToken?: (t: string) => void; timeoutMs?: number; job?: AiJob }
export async function localChat(user: string, opts: ChatOpts = {}): Promise<string> {
  const body: Record<string, unknown> = {
    model: llm.model, temperature: opts.temperature ?? 0.1, max_tokens: opts.maxTokens ?? 1024, stream: !!opts.onToken,
    messages: [...(opts.system ? [{ role: 'system', content: opts.system }] : []), { role: 'user', content: user }],
  };
  if (opts.jsonSchema) body.response_format = { type: 'json_schema', json_schema: { name: 'out', schema: opts.jsonSchema, strict: true } };
  const ctl = new AbortController(); const timer = window.setTimeout(() => ctl.abort(), opts.timeoutMs ?? 180_000);
  const r = await fetch(`${llm.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal })
    .catch(e => { throw new Error(ctl.signal.aborted ? `The model did not answer within ${Math.round((opts.timeoutMs ?? 180_000) / 1000)} s. It may be busy with another request; try again in a minute.` : String(e)); })
    .finally(() => window.clearTimeout(timer));
  if (!r.ok) throw new Error(`llama ${r.status}: ${await r.text()}`);
  if (!opts.onToken) { const j = await r.json(); return j.choices?.[0]?.message?.content ?? ''; }
  const reader = r.body!.getReader(); const dec = new TextDecoder(); let out = ''; let buf = '';
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop() ?? '';
    for (const l of lines) {
      if (!l.startsWith('data: ')) continue; const d = l.slice(6).trim(); if (d === '[DONE]') continue;
      try { const t = JSON.parse(d).choices?.[0]?.delta?.content ?? ''; if (t) { out += t; opts.onToken(t); } } catch { /* partial */ }
    }
  }
  return out;
}

/* ---------- provider dispatch: local llama.cpp or Claude on Cory's subscription, chosen per job in Settings ---------- */
import type { AiJob } from './providers';
export type { AiJob };
/** The model that will answer this job right now, for labels and logs. */
export async function modelFor(job: AiJob): Promise<{ provider: 'local' | 'claude'; model: string; label: string }> {
  const { currentRoute } = await import('./providers');
  const r = await currentRoute(job);
  return { provider: r.provider, model: r.provider === 'local' ? (llm.model === 'local' ? 'qwen3-4b-instruct-q4km' : llm.model) : `claude:${r.model}`, label: r.label };
}
/** Can this job get an answer right now? Claude routes are assumed reachable (the call itself falls back); local needs llama-server. */
export async function modelAvailable(job: AiJob): Promise<boolean> {
  const { currentRoute } = await import('./providers');
  const r = await currentRoute(job);
  return r.provider === 'claude' ? true : llamaHealthy();
}
async function fallbackNote(job: AiJob, err: unknown): Promise<void> {
  try { const { logEvent } = await import('./repo'); await logEvent('ai.fallback_local', undefined, undefined, { job, reason: String(err instanceof Error ? err.message : err).slice(0, 200) }); } catch { /* logging only */ }
}
export async function chat(user: string, opts: ChatOpts = {}): Promise<string> {
  const job = opts.job ?? 'drafts';
  const { currentRoute, claudeChat } = await import('./providers');
  const route = await currentRoute(job);
  if (route.provider === 'claude') {
    try { return await claudeChat(user, { ...opts, model: route.model }); }
    catch (e) { const { getSettings } = await import('./repo'); if ((await getSettings()).ai_fallback_local === 'off' || !(await llamaHealthy())) throw e; await fallbackNote(job, e); }
  }
  return localChat(user, opts);
}
export async function chatTurn(messages: ChatMessage[], opts: { tools?: ToolSpec[]; temperature?: number; maxTokens?: number; onToken?: (t: string) => void; job?: AiJob } = {}): Promise<ChatMessage> {
  const job = opts.job ?? 'agents';
  const { currentRoute, claudeChatTurn } = await import('./providers');
  const route = await currentRoute(job);
  if (route.provider === 'claude') {
    try { return await claudeChatTurn(messages, { tools: opts.tools, model: route.model, onToken: opts.onToken }); }
    catch (e) { const { getSettings } = await import('./repo'); if ((await getSettings()).ai_fallback_local === 'off' || !(await llamaHealthy())) throw e; await fallbackNote(job, e); }
  }
  return localChatTurn(messages, opts);
}
