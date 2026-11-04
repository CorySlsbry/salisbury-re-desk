-- 0004: Google Calendar / Gmail links, prefilled form drafts.
CREATE TABLE IF NOT EXISTS calendar_links (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('deadline','task','open_house')),
  ref_id INTEGER NOT NULL,
  google_event_id TEXT NOT NULL, calendar_id TEXT NOT NULL DEFAULT 'primary',
  fingerprint TEXT,                                    -- hash of what was pushed; re-push only when it changes
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(kind, ref_id)
);
ALTER TABLE documents ADD COLUMN draft INTEGER NOT NULL DEFAULT 0;   -- 1 = prefilled by the app, unsigned
ALTER TABLE documents ADD COLUMN packet_item_id INTEGER REFERENCES transaction_packet_items(id);
