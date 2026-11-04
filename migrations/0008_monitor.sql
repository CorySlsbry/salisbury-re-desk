-- Monitor + confidence loop: how every model output was checked, what the loop learned, and two read-only views
-- ("local SQL") that reports, agent tools and the Audit page all read from.
ALTER TABLE model_runs ADD COLUMN grounding_score REAL;
ALTER TABLE model_runs ADD COLUMN ungrounded_json TEXT;
ALTER TABLE model_runs ADD COLUMN input_sha TEXT;
ALTER TABLE model_runs ADD COLUMN model_sha TEXT;
ALTER TABLE model_runs ADD COLUMN passes INTEGER;
ALTER TABLE model_runs ADD COLUMN strategy TEXT;

-- What the loop learned from its own verdicts: for a job and a failure signature, which strategy failed and which one
-- finally passed. Written only by the loop, never by a model. Bounded to the top rows per job by count.
CREATE TABLE IF NOT EXISTS agent_lessons (
  id INTEGER PRIMARY KEY,
  job TEXT NOT NULL,
  failure_signature TEXT NOT NULL,
  strategy_failed TEXT NOT NULL,
  strategy_worked TEXT,
  hint TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(job, failure_signature)
);

-- Every pending deadline and open task with its client and property. "Today" is applied by the app in Mountain Time.
CREATE VIEW IF NOT EXISTS v_at_risk AS
SELECT 'deadline' AS kind, d.id AS ref_id, d.transaction_id, t.client_id, c.last_name, c.first_name, p.street, t.side,
       d.label AS title, d.due_on, d.due_time, d.basis AS detail
FROM deadlines d
JOIN transactions t ON t.id = d.transaction_id
JOIN clients c ON c.id = t.client_id
LEFT JOIN properties p ON p.id = t.property_id
WHERE d.status = 'pending'
UNION ALL
SELECT 'task', k.id, k.transaction_id, k.client_id, c.last_name, c.first_name, p.street, t.side,
       k.title, k.due_on, k.due_time, k.priority
FROM tasks k
LEFT JOIN clients c ON c.id = k.client_id
LEFT JOIN transactions t ON t.id = k.transaction_id
LEFT JOIN properties p ON p.id = t.property_id
WHERE k.done_at IS NULL;

-- Every Complete File item still missing on an open file, with the dates the ICA clocks run from.
CREATE VIEW IF NOT EXISTS v_packet_gaps AS
SELECT i.id AS item_id, i.transaction_id, t.client_id, c.last_name, c.first_name, p.street, t.side, t.status AS tx_status,
       t.agreement_signed_on, t.acceptance_on, t.broker_submitted_on, i.label, i.doc_kind, i.required_when, i.position
FROM transaction_packet_items i
JOIN transactions t ON t.id = i.transaction_id
JOIN clients c ON c.id = t.client_id
LEFT JOIN properties p ON p.id = t.property_id
WHERE i.status = 'missing' AND t.status IN ('active', 'under_contract', 'pending');
