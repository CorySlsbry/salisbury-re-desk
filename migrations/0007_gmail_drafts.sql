-- Gmail drafts the app created, keyed by a hash of recipient + subject + body, so a second click reuses the draft instead of making a twin.
CREATE TABLE IF NOT EXISTS google_gmail_drafts (
  key TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
