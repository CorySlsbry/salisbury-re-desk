-- 0005: in-app automations (deterministic, run at boot / every 15 min / after intake), showings, broker submission stamp.
CREATE TABLE IF NOT EXISTS automation_runs (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL,                                   -- broker_file | hoa_clock | showing_digest | offdrive_backup | bitlocker | compliance_scan | repc_version
  at TEXT NOT NULL DEFAULT (datetime('now')),
  trigger TEXT NOT NULL,                               -- boot | interval | intake | manual
  ok INTEGER NOT NULL DEFAULT 1,
  summary TEXT NOT NULL,
  details_json TEXT,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_auto_runs_key ON automation_runs(key, at);

CREATE TABLE IF NOT EXISTS showings (
  id INTEGER PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id),
  shown_on TEXT NOT NULL, shown_at TEXT,               -- date, HH:MM
  agent TEXT, brokerage TEXT, feedback TEXT,
  interest TEXT,                                       -- hot | warm | cold | no_show | unknown
  source TEXT NOT NULL DEFAULT 'paste',                -- paste | manual | email
  fingerprint TEXT UNIQUE,                             -- dedupes re-pasted emails
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_showings_tx ON showings(transaction_id, shown_on);

ALTER TABLE transactions ADD COLUMN broker_submitted_on TEXT;
ALTER TABLE transactions ADD COLUMN hoa_request_sent_on TEXT;
