/**
 * Document management for a client file: every document lives under Documents\Salisbury RE\Clients\<Last, First - Address>\
 * in a numbered subfolder chosen by its kind, is registered in the `documents` table with its sha256, and opens in the
 * Windows default app for its type (Acrobat, Edge, Word...) with one click. Nothing is ever moved out or deleted.
 */
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { native, doc } from './native';
import * as repo from './repo';
import type { DocKind } from './intake';

/** Which numbered subfolder a document kind is filed in. Mirrors Exhibit B's order and the folder tree the app creates. */
export const KIND_FOLDER: Record<string, string> = {
  listing_agreement: '01 Agreements', bba: '01 Agreements', compensation: '01 Agreements', agency_disclosure: '01 Agreements',
  spcd: '02 Disclosures', spcd_ack: '02 Disclosures', lead_paint: '02 Disclosures', wire_fraud: '02 Disclosures', hoa: '02 Disclosures', mls_input: '02 Disclosures',
  repc: '03 Contract & Addenda', addendum: '03 Contract & Addenda', counter: '03 Contract & Addenda', emd_receipt: '03 Contract & Addenda',
  inspection: '04 Inspection & Appraisal', appraisal: '04 Inspection & Appraisal',
  preapproval: '05 Title & Closing', title: '05 Title & Closing', title_commitment: '05 Title & Closing', settlement: '05 Title & Closing', cda: '05 Title & Closing', referral: '05 Title & Closing', cancellation: '05 Title & Closing',
  communication: '06 Communications', other: '00 Intake',
};
export const KIND_LABEL: Array<[string, string]> = [
  ['listing_agreement', 'Listing agreement'], ['bba', 'Buyer-broker agreement'], ['agency_disclosure', 'Agency disclosure / limited agency'], ['compensation', 'Compensation agreement'],
  ['spcd', "Seller's Property Condition Disclosure"], ['lead_paint', 'Lead-based paint disclosure'], ['wire_fraud', 'Wire fraud advisory'], ['hoa', 'HOA documents / request'], ['mls_input', 'MLS data sheet / exemption forms'],
  ['repc', 'REPC (purchase contract)'], ['addendum', 'Addendum / counteroffer'], ['emd_receipt', 'Earnest money receipt'],
  ['inspection', 'Inspection report / resolution'], ['appraisal', 'Appraisal'], ['preapproval', 'Pre-approval / proof of funds'],
  ['title_commitment', 'Title commitment'], ['settlement', 'Settlement statement / CD'], ['cda', 'Commission disbursement authorization'], ['referral', 'Referral agreement'], ['cancellation', 'Cancellation / release'],
  ['communication', 'Written communication'], ['other', 'Other'],
];
export function folderFor(kind: string): string { return KIND_FOLDER[kind] ?? '00 Intake'; }

/** Open a file in the default Windows app. Falls back to showing it in Explorer if no app is registered for the type. */
export async function openDocument(path: string): Promise<void> {
  try { await openPath(path); }
  catch (e) {
    const msg = String(e);
    if (/not allowed|scope|forbidden/i.test(msg)) throw new Error(`Windows was not allowed to open ${path.split(/[\\/]/).pop()}: it is outside the folders the app may open (Documents\\Salisbury RE, Downloads, Desktop).`);
    try { await revealItemInDir(path); } catch { /* fall through */ }
    throw new Error(`Could not open ${path.split(/[\\/]/).pop()} in its default app (${msg.slice(0, 120)}). It has been shown in Explorer instead; right-click it there and choose "Open with".`);
  }
}
export async function revealDocument(path: string): Promise<void> { await revealItemInDir(path); }

/** Best guess at what a dropped PDF is, from its first-page title. Cory confirms before filing. */
export async function guessKind(path: string): Promise<DocKind> {
  try { const [{ classify }, t] = await Promise.all([import('./intake'), doc.text(path, { pages: [1] })]); return classify(t.pages.map(p => p.text).join('\n')).kind; } catch { return 'other'; }
}

/** Copy a file into the client folder (never move), register it, and mark the matching packet item received. */
export async function fileDocument(txId: number, src: string, kind: string, opts: { signed?: boolean; title?: string } = {}): Promise<{ path: string; documentId: number; packetMarked: boolean }> {
  const tx = await repo.getTransaction(txId); if (!tx) throw new Error('transaction not found');
  const client = await repo.getClient(tx.client_id); if (!client?.folder_path) throw new Error('this client has no folder yet');
  const fileName = src.split(/[\\/]/).pop() ?? 'document.pdf';
  const [path, sha, bytes] = await native.fileIntoVault(src, `${client.folder_path}\\${folderFor(kind)}`, fileName);
  let pages: number | null = null;
  try { pages = (await doc.info(path)).pages; } catch { /* not a PDF, or engine busy */ }
  const documentId = await repo.addDocument({ transaction_id: txId, client_id: client.id, kind, title: opts.title ?? fileName.replace(/\.[a-z0-9]+$/i, ''), path, sha256: sha, pages, bytes, form_id: null, signed: opts.signed ? 1 : 0, signed_on: opts.signed ? repo.today() : null, extracted_json: null, extraction_tier: null, reviewed_at: null, draft: 0, packet_item_id: null });
  let packetMarked = false;
  if (opts.signed !== false) {
    const before = (await repo.listPacket(txId)).filter(i => i.doc_kind === kind && i.status === 'missing').length;
    await repo.markPacketItemByKind(txId, kind, documentId);
    packetMarked = before > 0;
  }
  await repo.logEvent('document.filed', 'document', documentId, { txId, kind, path, sha256: sha, signed: !!opts.signed });
  return { path, documentId, packetMarked };
}
