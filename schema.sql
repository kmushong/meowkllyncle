-- D1 schema for Kelly's Cat Sitting
-- Apply with: wrangler d1 execute DB --file=schema.sql

CREATE TABLE IF NOT EXISTS bookings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  status     TEXT    NOT NULL DEFAULT 'pending',
  name       TEXT    NOT NULL,
  contact    TEXT    NOT NULL,
  address    TEXT    NOT NULL,
  area       TEXT,
  cats       TEXT    NOT NULL,
  meds       TEXT,
  notes      TEXT,
  total      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS visits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  date       TEXT    NOT NULL,
  slot       TEXT    NOT NULL,
  len        TEXT    NOT NULL,
  price      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_visits_date_slot ON visits(date, slot);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blocks (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  date   TEXT NOT NULL,
  slot   TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  UNIQUE(date, slot)
);
