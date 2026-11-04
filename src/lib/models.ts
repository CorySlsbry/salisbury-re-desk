/** Model registry: what the app runs, where it comes from, and how to fetch it on a fresh machine. */
import { listen } from '@tauri-apps/api/event';
import { appPaths, native } from './native';

export interface ModelSpec { id: string; file: string; url: string; sizeGb: number; sha256?: string; purpose: string }

export const MODELS: ModelSpec[] = [
  {
    id: 'qwen3-4b-instruct-q4km', file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    sizeGb: 2.5, purpose: 'extraction + short drafting (default)',
  },
  {
    id: 'qwen3-30b-a3b-q4km', file: 'Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF/resolve/main/Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf',
    sizeGb: 18, purpose: 'optional: long client-facing drafting (needs ~20 GB RAM)',
  },
];

export async function modelPath(m: ModelSpec): Promise<string> { const p = await appPaths(); return `${p.models}\\${m.file}`; }

export async function modelPresent(m: ModelSpec): Promise<boolean> {
  const p = await appPaths();
  const files = await native.listDir(p.models).catch(() => [] as [string, number, boolean][]);
  return files.some(([f, bytes]) => f.endsWith(m.file) && bytes > 1_000_000_000);
}

export async function downloadModel(m: ModelSpec, onProgress: (done: number, total: number) => void): Promise<void> {
  const dest = await modelPath(m);
  const un = await listen<{ url: string; done: number; total: number }>('download-progress', e => { if (e.payload.url === m.url) onProgress(e.payload.done, e.payload.total); });
  try { await native.downloadModel(m.url, dest, m.sha256); } finally { un(); }
}
