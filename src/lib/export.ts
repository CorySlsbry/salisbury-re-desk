/**
 * Complete File export (broker hand-off, ICA Exhibit B). Builds one zip in Exhibit B order with an index and a
 * sha256 manifest, into <client folder>\07 Broker Submissions\. Pure TS: fflate + the Tauri fs plugin (scoped).
 */
import { readFile, writeFile } from '@tauri-apps/plugin-fs';
import { zipSync, strToU8 } from 'fflate';
import { getClient, getTransaction, listDocuments, listPacket, listDeadlines, getSettings, logEvent, updateTransaction, type DocumentRow } from './repo';

export interface ExportResult { zipPath: string; included: number; missing: string[] }

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function exportCompleteFile(transactionId: number): Promise<ExportResult> {
  const tx = await getTransaction(transactionId); if (!tx) throw new Error('transaction not found');
  const client = await getClient(tx.client_id); if (!client?.folder_path) throw new Error('client has no folder');
  const packet = await listPacket(transactionId);
  const docs = await listDocuments(transactionId);
  const deadlines = await listDeadlines({ transactionId });
  const s = await getSettings();
  const byId = new Map<number, DocumentRow>(docs.map(d => [d.id, d]));
  const files: Record<string, Uint8Array> = {};
  const manifest: string[] = [];
  const missing: string[] = [];
  let n = 0;
  const used = new Set<number>();
  for (const item of packet) {
    const doc = item.document_id ? byId.get(item.document_id) : docs.find(d => d.kind === item.doc_kind && !used.has(d.id));
    if (!doc) { if (item.status !== 'not_applicable') missing.push(item.label); continue; }
    used.add(doc.id);
    const bytes = await readFile(doc.path);
    const name = `${String(item.position).padStart(2, '0')} ${item.doc_kind}${doc.path.slice(doc.path.lastIndexOf('.'))}`;
    files[name] = bytes; n++;
    manifest.push(`${await sha256Hex(bytes)}  ${name}  (${item.label})`);
  }
  for (const doc of docs) if (!used.has(doc.id)) { const bytes = await readFile(doc.path); const name = `99 other - ${doc.path.split(/[\\/]/).pop()}`; files[name] = bytes; n++; manifest.push(`${await sha256Hex(bytes)}  ${name}`); }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const index = [
    `COMPLETE FILE - ${client.last_name}, ${client.first_name} - ${tx.street ?? ''}${tx.city ? ', ' + tx.city : ''}`,
    `Agent: ${s.agent_name}, ${s.brokerage} (${s.agent_license})   Side: ${tx.side}   Status: ${tx.status}`,
    `Price: ${tx.contract_price ?? tx.list_price ?? ''}   Acceptance: ${tx.acceptance_on ?? ''}   Exported: ${stamp}`,
    '', 'Documents (Exhibit B order):', ...Object.keys(files).map(f => `  ${f}`),
    '', 'Deadlines:', ...deadlines.map(d => `  ${d.due_on} ${d.due_time}  ${d.label}  [${d.status}]`),
    '', missing.length ? `MISSING (still owed): ${missing.join('; ')}` : 'All applicable checklist items present.',
    '', 'sha256 manifest:', ...manifest, '',
  ].join('\n');
  files['00 INDEX.txt'] = strToU8(index);
  const zip = zipSync(files, { level: 6 });
  const zipPath = `${client.folder_path}\\07 Broker Submissions\\Complete File ${stamp}.zip`;
  await writeFile(zipPath, zip);
  await updateTransaction(transactionId, { broker_file_status: missing.length ? 'partial' : 'submitted' });
  await logEvent('broker.complete_file.exported', 'transaction', transactionId, { zipPath, included: n, missing });
  return { zipPath, included: n, missing };
}
