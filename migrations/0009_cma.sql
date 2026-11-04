-- CMA from an address: cached geocodes, comps imported from MLS exports, and saved CMAs.
CREATE TABLE IF NOT EXISTS geocache (
  address TEXT PRIMARY KEY,
  lat REAL, lng REAL,
  matched TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per listing the MLS export contained. Re-importing the same MLS number or address updates the row.
CREATE TABLE IF NOT EXISTS mls_comps (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,            -- mls number, else the normalised address
  mls_number TEXT,
  address TEXT NOT NULL, city TEXT, zip TEXT,
  lat REAL, lng REAL,
  status TEXT NOT NULL,                -- sold | active | under_contract | other
  list_price INTEGER, sold_price INTEGER, sold_on TEXT, list_date TEXT, dom INTEGER,
  sqft INTEGER, basement_finished_sqft INTEGER, beds INTEGER, full_baths INTEGER, three_quarter_baths INTEGER, half_baths INTEGER,
  year_built INTEGER, garage INTEGER, acres REAL, style TEXT, style_raw TEXT,
  source_file TEXT, imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS mls_comps_status ON mls_comps(status, sold_on);

CREATE TABLE IF NOT EXISTS cmas (
  id INTEGER PRIMARY KEY,
  address TEXT NOT NULL, lat REAL, lng REAL,
  transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  subject_json TEXT NOT NULL,
  selection_json TEXT NOT NULL,        -- rung used, chosen comps, considered-and-why, context sets
  result_json TEXT NOT NULL,           -- the grid result: adjusted comps, survivors, dropped, three numbers
  pdf_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
