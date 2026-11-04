-- Salisbury RE Desk schema v1 (SQLite). Dates are ISO-8601 text; wall-clock times are America/Denver.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL,                                  -- lender | title | inspector | appraiser | coop_agent | attorney | hoa | other
  name TEXT NOT NULL, company TEXT, phone TEXT, email TEXT, notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL, last_name TEXT NOT NULL,
  second_first_name TEXT, second_last_name TEXT,       -- co-buyer / co-seller
  phone TEXT, email TEXT, phone2 TEXT, email2 TEXT,
  mailing_address TEXT,
  source TEXT,                                         -- referral | website | open_house | fsbo | expired | sphere | other
  sms_consent INTEGER NOT NULL DEFAULT 0, sms_consent_at TEXT,
  do_not_contact INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  folder_path TEXT,                                    -- Documents\Salisbury RE\Clients\<Last, First - Address>
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_clients_name ON clients(last_name, first_name);

CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY,
  street TEXT NOT NULL, unit TEXT, city TEXT, state TEXT NOT NULL DEFAULT 'UT', zip TEXT, county TEXT,
  tax_id TEXT, mls_number TEXT,
  year_built INTEGER,                                  -- before 1978 => lead-based paint disclosure required
  has_hoa INTEGER, hoa_name TEXT,
  address_key TEXT,                                    -- normalized street+zip for dedup
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_properties_key ON properties(address_key);

CREATE TABLE IF NOT EXISTS forms (                     -- form templates on disk
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,                           -- repc | blank_addendum | lead_paint | uar_listing_agreement ...
  name TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('state','uar','brokerage','custom')),
  path TEXT NOT NULL, sha256 TEXT NOT NULL, version_label TEXT, url TEXT,
  field_map_json TEXT,                                 -- {app_field: pdf_field_name}
  checked_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  property_id INTEGER REFERENCES properties(id),
  side TEXT NOT NULL CHECK (side IN ('seller','buyer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('lead','active','under_contract','pending','closed','fell_through','cancelled')),
  list_price REAL, contract_price REAL,
  agreement_signed_on TEXT,                            -- listing agreement / BBA signed date
  agreement_expires_on TEXT,
  acceptance_on TEXT,                                  -- REPC acceptance (signed AND communicated) = Day 0
  acceptance_time TEXT,
  repc_version TEXT,                                   -- e.g. '2024-12-04'
  is_cash INTEGER NOT NULL DEFAULT 0,
  lender_contact_id INTEGER REFERENCES contacts(id),
  title_contact_id INTEGER REFERENCES contacts(id),
  coop_agent_contact_id INTEGER REFERENCES contacts(id),
  commission_pct REAL, commission_flat REAL,
  broker_file_status TEXT NOT NULL DEFAULT 'not_started' CHECK (broker_file_status IN ('not_started','partial','submitted','approved')),
  closed_on TEXT, fell_through_on TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tx_client ON transactions(client_id);
CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  transaction_id INTEGER REFERENCES transactions(id),
  client_id INTEGER REFERENCES clients(id),
  kind TEXT NOT NULL,                                  -- listing_agreement | bba | repc | addendum | counter | spcd | agency_disclosure | lead_paint | wire_fraud | mls_input | hoa | preapproval | emd_receipt | inspection | appraisal | title | settlement | cda | communication | other
  title TEXT, path TEXT NOT NULL, sha256 TEXT NOT NULL, pages INTEGER, bytes INTEGER,
  form_id INTEGER REFERENCES forms(id),
  signed INTEGER NOT NULL DEFAULT 0, signed_on TEXT,
  extracted_json TEXT,                                 -- {field:{value,page,bbox,tier,confidence}}
  extraction_tier INTEGER,                             -- 1 acroform | 2 text anchors | 3 ocr+llm
  reviewed_at TEXT,                                    -- Cory confirmed the extraction
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_docs_tx ON documents(transaction_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_docs_sha ON documents(sha256);

CREATE TABLE IF NOT EXISTS deadlines (
  id INTEGER PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id),
  type TEXT NOT NULL,                                  -- see src/lib/deadlines.ts DeadlineType
  label TEXT NOT NULL,
  due_on TEXT NOT NULL, due_time TEXT NOT NULL DEFAULT '17:00',
  basis TEXT NOT NULL DEFAULT 'contract' CHECK (basis IN ('contract','derived','broker','practice','compliance')),
  source_document_id INTEGER REFERENCES documents(id), source_page INTEGER,
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','waived','missed','superseded')),
  superseded_by INTEGER REFERENCES deadlines(id),
  reminder_on TEXT, notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deadlines_due ON deadlines(due_on);
CREATE UNIQUE INDEX IF NOT EXISTS idx_deadlines_tx_type_active ON deadlines(transaction_id, type) WHERE status IN ('pending','done','waived','missed');

CREATE TABLE IF NOT EXISTS cadences (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  applies_to TEXT NOT NULL,                            -- lead | listing | under_contract | post_close | buyer
  weekdays_only INTEGER NOT NULL DEFAULT 1, description TEXT
);
CREATE TABLE IF NOT EXISTS cadence_steps (
  id INTEGER PRIMARY KEY, cadence_id INTEGER NOT NULL REFERENCES cadences(id),
  day_offset INTEGER NOT NULL, anchor TEXT NOT NULL DEFAULT 'start',  -- start | acceptance | settlement | closing | live
  kind TEXT NOT NULL CHECK (kind IN ('email','call','text','video_text','task')),
  title TEXT NOT NULL, body_template TEXT, position INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  transaction_id INTEGER REFERENCES transactions(id), client_id INTEGER REFERENCES clients(id),
  cadence_step_id INTEGER REFERENCES cadence_steps(id),
  deadline_id INTEGER REFERENCES deadlines(id),
  kind TEXT NOT NULL DEFAULT 'task', title TEXT NOT NULL, body TEXT,
  due_on TEXT NOT NULL, due_time TEXT,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  done_at TEXT, snoozed_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_on) WHERE done_at IS NULL;

CREATE TABLE IF NOT EXISTS packet_templates (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('seller','buyer','closing'))
);
CREATE TABLE IF NOT EXISTS packet_items (
  id INTEGER PRIMARY KEY, template_id INTEGER NOT NULL REFERENCES packet_templates(id),
  position INTEGER NOT NULL, doc_kind TEXT NOT NULL, label TEXT NOT NULL,
  required_when TEXT,                                  -- always | pre1978 | hoa | if_applicable
  form_code TEXT, note TEXT
);
-- Snapshot rule: items are COPIED onto the transaction so a template edit never rewrites history.
CREATE TABLE IF NOT EXISTS transaction_packet_items (
  id INTEGER PRIMARY KEY, transaction_id INTEGER NOT NULL REFERENCES transactions(id),
  position INTEGER NOT NULL, doc_kind TEXT NOT NULL, label TEXT NOT NULL, required_when TEXT, form_code TEXT,
  status TEXT NOT NULL DEFAULT 'missing' CHECK (status IN ('missing','not_applicable','received','submitted')),
  document_id INTEGER REFERENCES documents(id), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS intake_sections (
  id INTEGER PRIMARY KEY, transaction_id INTEGER NOT NULL REFERENCES transactions(id),
  section TEXT NOT NULL,                               -- motivation | timeline | property | financing | showing | repairs | closing | notes
  author TEXT NOT NULL DEFAULT 'cory' CHECK (author IN ('cory','client','ai')),
  body_md TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(transaction_id, section, author)
);

CREATE TABLE IF NOT EXISTS events (                    -- append-only audit
  id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')),
  actor TEXT NOT NULL DEFAULT 'cory', name TEXT NOT NULL,
  subject_type TEXT, subject_id INTEGER, payload_json TEXT
);

CREATE TABLE IF NOT EXISTS model_runs (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')),
  model TEXT NOT NULL, purpose TEXT NOT NULL, prompt_sha TEXT, latency_ms INTEGER,
  input_tokens INTEGER, output_tokens INTEGER, output_json TEXT, ok INTEGER NOT NULL DEFAULT 1
);
