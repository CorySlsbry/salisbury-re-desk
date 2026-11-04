-- salisburyre.com CRM link (Supabase project nlnahfapzrmihqflwrac): what the app has pushed, and what it has pulled.
CREATE TABLE IF NOT EXISTS crm_links (
  entity TEXT NOT NULL,                -- client | transaction | deadline | showing
  local_id INTEGER NOT NULL,
  crm_table TEXT NOT NULL,             -- crm_contacts | crm_deals | crm_transaction_milestones | crm_showing_feedback
  crm_id TEXT NOT NULL,
  fingerprint TEXT,
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entity, local_id, crm_table)
);

-- Website leads and CRM contacts pulled from salisburyre.com, waiting for Cory to add them as clients (or dismiss).
CREATE TABLE IF NOT EXISTS crm_inbox (
  crm_id TEXT PRIMARY KEY,             -- leads.id or crm_contacts.id
  kind TEXT NOT NULL,                  -- lead | contact
  name TEXT, email TEXT, phone TEXT,
  source TEXT, magnet TEXT, tags TEXT, notes TEXT,
  received_at TEXT,
  status TEXT NOT NULL DEFAULT 'new',  -- new | added | dismissed
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  pulled_at TEXT NOT NULL DEFAULT (datetime('now'))
);
