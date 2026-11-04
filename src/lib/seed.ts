/** Seed reference data (packets, cadences, brokerage identity) on first run. Idempotent. */
import type Database from '@tauri-apps/plugin-sql';
import type { AppPaths } from './native';
import packets from '../../templates/packets.json';
import cadences from '../../templates/cadences.json';
import engineTemplate from '../../templates/engine.json';

export const IDENTITY = {
  agent_name: 'Cory Salisbury',
  agent_title: 'REALTOR',
  brokerage: 'Simple Choice Real Estate',
  brokerage_license: '7041062-CN00',
  agent_license: '5072842-SA00',
  broker_name: 'Pat Morgan',
  broker_email: 'person1@example.com',
  broker_phone: '(555) 010-0100',
  brokerage_address: '536 N Ritter, Saratoga Springs, UT 84045',
  agent_phone: '(801) 245-0511',
  eho: 'Equal Housing Opportunity',
  tenure: 'helping Utah families since 2014',
  timezone: 'America/Denver',
  transaction_fee: '495',
  repc_version: '2024-12-04',
};

export async function seedIfEmpty(d: Database, _p: AppPaths): Promise<void> {
  for (const [k, v] of Object.entries({ ...IDENTITY, ...engineTemplate.settings_defaults })) {
    await d.execute('INSERT OR IGNORE INTO settings(key, value) VALUES ($1, $2)', [k, v]);
  }
  const n = await d.select<{ c: number }[]>('SELECT COUNT(*) AS c FROM packet_templates');
  if (n[0]?.c === 0) {
    for (const side of ['seller', 'buyer', 'closing'] as const) {
      const t = packets[side] as { name: string; items: Array<{ doc_kind: string; label: string; required_when?: string; form_code?: string }> };
      const r = await d.execute('INSERT INTO packet_templates(code, name, side) VALUES ($1, $2, $3)', [side, t.name, side]);
      let pos = 1;
      for (const it of t.items) {
        await d.execute('INSERT INTO packet_items(template_id, position, doc_kind, label, required_when, form_code) VALUES ($1,$2,$3,$4,$5,$6)',
          [r.lastInsertId, pos++, it.doc_kind, it.label, it.required_when ?? 'always', it.form_code ?? null]);
      }
    }
  }
  // Cadences are keyed by code: a cadence added to templates/cadences.json after first run is inserted on the next boot.
  const have = new Set((await d.select<{ code: string }[]>('SELECT code FROM cadences')).map(r => r.code));
  {
    for (const cad of cadences.cadences) {
      if (have.has(cad.code)) continue;
      const r = await d.execute('INSERT INTO cadences(code, name, applies_to, weekdays_only, description) VALUES ($1,$2,$3,$4,$5)',
        [cad.code, cad.name, cad.applies_to, cad.weekdays_only ? 1 : 0, JSON.stringify({ pause_on_reply: (cad as { pause_on_reply?: boolean }).pause_on_reply ?? false, repeat_weekly: (cad as { repeat_weekly?: boolean }).repeat_weekly ?? false })]);
      let pos = 1;
      for (const s of cad.steps) {
        const step = s as { day: number; kind: string; title: string; body?: string; anchor?: string };
        await d.execute('INSERT INTO cadence_steps(cadence_id, day_offset, anchor, kind, title, body_template, position) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [r.lastInsertId, step.day, step.anchor ?? 'start', step.kind, step.title, step.body ?? null, pos++]);
      }
    }
  }
}
