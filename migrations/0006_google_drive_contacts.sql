-- Google Drive uploads and Google Contacts links. Both tables hold only Google ids and links, never tokens.
CREATE TABLE IF NOT EXISTS google_drive_files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  google_file_id TEXT NOT NULL,
  web_view_link TEXT NOT NULL,
  folder_id TEXT,
  shared_json TEXT NOT NULL DEFAULT '[]',
  uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS google_contacts (
  client_id INTEGER PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  resource_name TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
