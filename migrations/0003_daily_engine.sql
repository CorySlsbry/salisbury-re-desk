-- 0003: the Daily Engine (Pat's non-negotiables + weekly rhythm), leads pipeline, ideas, open houses, touches.
ALTER TABLE clients ADD COLUMN stage TEXT NOT NULL DEFAULT 'client';        -- lead | nurture | client | past | lost
ALTER TABLE clients ADD COLUMN preferred_channel TEXT;                       -- call | text | email | facebook | instagram | other
ALTER TABLE clients ADD COLUMN birthday TEXT;                                -- YYYY-MM-DD or MM-DD
ALTER TABLE clients ADD COLUMN interest TEXT;                                -- seller | buyer | both | unknown
ALTER TABLE clients ADD COLUMN lead_received_at TEXT;
ALTER TABLE clients ADD COLUMN last_touch_on TEXT;
ALTER TABLE clients ADD COLUMN replied_at TEXT;                              -- reply received: drip paused, call within 5 minutes

CREATE TABLE IF NOT EXISTS cadence_enrollments (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  cadence_id INTEGER NOT NULL REFERENCES cadences(id),
  started_on TEXT NOT NULL, paused_at TEXT, completed_at TEXT, cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_enroll_client ON cadence_enrollments(client_id);

-- One row per checklist item per day. Item keys come from templates/engine.json.
CREATE TABLE IF NOT EXISTS daily_log (
  id INTEGER PRIMARY KEY,
  on_date TEXT NOT NULL, item_key TEXT NOT NULL,
  done_at TEXT, count INTEGER NOT NULL DEFAULT 0, note TEXT,
  UNIQUE(on_date, item_key)
);

-- Ideas that surface on the walk / the drive. They queue into Thursday's reel build and Friday's posting.
CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL, hook TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','built','posted','dropped')),
  captured_at TEXT NOT NULL DEFAULT (datetime('now')), built_on TEXT, posted_on TEXT, platform TEXT
);

-- Outreach touches (the "reach out to 10 people" counter; 3 must be gratitude / compliment).
CREATE TABLE IF NOT EXISTS touches (
  id INTEGER PRIMARY KEY,
  client_id INTEGER REFERENCES clients(id),
  on_date TEXT NOT NULL, channel TEXT NOT NULL,                              -- call | text | email | facebook | instagram | dm | other
  kind TEXT NOT NULL DEFAULT 'business' CHECK (kind IN ('gratitude','business')),
  who TEXT, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_touches_date ON touches(on_date);

CREATE TABLE IF NOT EXISTS open_houses (
  id INTEGER PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id),
  on_date TEXT NOT NULL, start_time TEXT NOT NULL DEFAULT '10:00', end_time TEXT NOT NULL DEFAULT '12:00',
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','posted','held','cancelled','cleaned')),
  marketplace_task_id INTEGER REFERENCES tasks(id), cleanup_task_id INTEGER REFERENCES tasks(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Posts logged against the per-platform cadence (so the app can warn before a platform throttles you).
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  on_date TEXT NOT NULL, platform TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'reel',   -- reel | post | story | marketplace | friend_add
  idea_id INTEGER REFERENCES ideas(id), face INTEGER NOT NULL DEFAULT 0, note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_posts_date ON posts(on_date, platform);
