/** Boot sequence behind the splash: paths -> DB + migrations -> seed -> doc engine -> model (async). */
import { appPaths, db, native, llamaHealthy, setLlmBackend, llm } from './native';
import { seedIfEmpty } from './seed';
import { backupDatabase } from './backup';
import { syncFormsLibrary, listForms } from './forms';
import { listPacketTemplates } from './repo';
import { linkFormsByRules } from './packetAi';

export interface BootState { ready: boolean; modelState: 'absent' | 'starting' | 'ready' | 'error'; modelPath?: string; backend?: string; error?: string }
export const boot: BootState = { ready: false, modelState: 'absent' };

const MODEL_FILE = 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf';
const logLines: string[] = [];
async function log(line: string): Promise<void> {
  logLines.push(`${new Date().toISOString()} ${line}`);
  try { const p = await appPaths(); await native.writeText(p.backups + '/boot.log', logLines.join(String.fromCharCode(10)) + String.fromCharCode(10)); } catch { /* logging must never break boot */ }
}

let bootStarted = false;
export async function runBoot(onState: (s: BootState) => void): Promise<void> {
  if (bootStarted) return; bootStarted = true; // React StrictMode mounts twice in dev
  try {
    await native.splash('Preparing folders', 10);
    const p = await appPaths();
    await native.splash('Opening database', 30);
    const d = await db();
    await native.splash('Loading templates', 45);
    await seedIfEmpty(d, p);
    await native.splash('Backing up database', 52);
    try { const b = await backupDatabase(); if (b) await log(`backup: ${b}`); } catch (e) { await log(`backup failed: ${String(e)}`); }
    await native.splash('Starting document engine', 60);
    try {
      await log(`doc: ${await native.docStart()}`);
      await native.docCall('ping');
      await log('doc: ping ok');
    } catch (e) {
      boot.error = `Document engine: ${String(e)}`; await log(boot.error);
    }
    await native.splash('Ready', 100);
    boot.ready = true; onState({ ...boot });
    await native.appReady();
    // Forms library + Exhibit B links in the background, so intake can prefill even before the Packets page is opened.
    void (async () => {
      try { const r = await syncFormsLibrary(); const fs = await listForms(); let n = 0; for (const t of await listPacketTemplates()) n += await linkFormsByRules(t.id, t.side, fs); await log(`forms: ${r.total} indexed (${r.added} new), ${n} packet items linked`); }
      catch (e) { await log(`forms: ${String(e)}`); }
    })();
    // Model warm-up is async: the app is usable before the LLM answers.
    const modelPath = `${p.models}\\${MODEL_FILE}`;
    boot.modelPath = modelPath;
    boot.modelState = 'starting'; onState({ ...boot });
    try {
      await log(`llama: start ${modelPath}`);
      const reply = await native.llamaStart(modelPath, 99, 8); setLlmBackend(reply); await log(`llama: ${reply}`);
      for (let i = 0; i < 120; i++) { if (await llamaHealthy()) break; await new Promise(r => setTimeout(r, 1000)); }
      boot.modelState = (await llamaHealthy()) ? 'ready' : 'error'; boot.backend = llm.backend;
      await log(`llama: ${boot.modelState} via ${llm.backend}`);
    } catch (e) {
      boot.modelState = /not found/.test(String(e)) ? 'absent' : 'error';
      boot.error = String(e); await log(`llama: ${boot.error}`);
    }
    onState({ ...boot });
    startModelSupervisor(modelPath, onState);
  } catch (e) {
    boot.error = String(e); boot.ready = true; onState({ ...boot }); await log(`boot: ${boot.error}`);
    await native.appReady();
  }
}

/**
 * The iGPU Vulkan path can die under memory pressure (device lost). Poll health; on the first two
 * deaths respawn on the GPU, after that fall back to CPU-only layers so the model stays available.
 */
let supervisorStarted = false;
export function startModelSupervisor(modelPath: string, onState: (s: BootState) => void): void {
  if (supervisorStarted) return; supervisorStarted = true;
  let crashes = 0;
  window.setInterval(async () => {
    if (boot.modelState === 'absent' || boot.modelState === 'starting') return;
    if (await llamaHealthy()) { if (boot.modelState !== 'ready') { boot.modelState = 'ready'; onState({ ...boot }); } return; }
    crashes += 1;
    const gpu = crashes > 2 ? 0 : 99;
    await log(`llama: not healthy (crash ${crashes}); respawning with gpuLayers=${gpu}`);
    boot.modelState = 'starting'; onState({ ...boot });
    try {
      setLlmBackend(await native.llamaStart(modelPath, gpu, 8));
      for (let i = 0; i < 90; i++) { if (await llamaHealthy()) break; await new Promise(r => setTimeout(r, 1000)); }
      boot.modelState = (await llamaHealthy()) ? 'ready' : 'error';
    } catch (e) { boot.modelState = 'error'; boot.error = String(e); }
    await log(`llama: supervisor -> ${boot.modelState}`);
    onState({ ...boot });
  }, 30_000);
}
