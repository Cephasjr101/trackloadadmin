'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || './data/loadmatch.db';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  role          TEXT NOT NULL CHECK (role IN ('carrier','shipper','admin')),
  owner_name    TEXT NOT NULL,
  company       TEXT,
  email         TEXT NOT NULL UNIQUE,
  phone         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trucks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plate_no        TEXT NOT NULL,
  truck_type      TEXT NOT NULL,
  from_city       TEXT NOT NULL,
  to_city         TEXT NOT NULL,
  capacity_kg     REAL NOT NULL,
  volume_m3       REAL NOT NULL,
  rate_per_km_ghs REAL NOT NULL,
  available_from  TEXT NOT NULL,
  available_to    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS loads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  description   TEXT NOT NULL,
  from_city     TEXT NOT NULL,
  to_city       TEXT NOT NULL,
  weight_kg     REAL NOT NULL,
  volume_m3     REAL NOT NULL,
  budget_ghs    REAL NOT NULL,
  pickup_date   TEXT NOT NULL,
  delivery_date TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','matched','closed')),
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  truck_id            INTEGER NOT NULL REFERENCES trucks(id) ON DELETE CASCADE,
  load_id             INTEGER NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
  score               REAL NOT NULL,
  distance_km         REAL NOT NULL,
  estimated_price_ghs REAL NOT NULL,
  commission_pct      REAL NOT NULL DEFAULT 5,
  status              TEXT NOT NULL DEFAULT 'proposed'
                       CHECK (status IN ('proposed','accepted','contracted','in_transit','delivered','paid','cancelled')),
  created_at          INTEGER NOT NULL,
  UNIQUE(truck_id, load_id)
);

CREATE TABLE IF NOT EXISTS contracts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id          INTEGER NOT NULL UNIQUE REFERENCES matches(id) ON DELETE CASCADE,
  terms_text        TEXT NOT NULL,
  carrier_signature TEXT,
  shipper_signature TEXT,
  carrier_signed_at INTEGER,
  shipper_signed_at INTEGER,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id        INTEGER NOT NULL UNIQUE REFERENCES matches(id) ON DELETE CASCADE,
  amount_ghs      REAL NOT NULL,
  commission_ghs  REAL NOT NULL,
  payout_ghs      REAL NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','escrowed','released','refunded')),
  escrowed_at     INTEGER,
  released_at     INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pods (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id      INTEGER NOT NULL UNIQUE REFERENCES matches(id) ON DELETE CASCADE,
  otp_hash      TEXT NOT NULL,
  otp_salt      TEXT NOT NULL,
  requested_at  INTEGER NOT NULL,
  verified_at   INTEGER,
  attempts      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tracking_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id   INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  lat        REAL NOT NULL,
  lng        REAL NOT NULL,
  note       TEXT,
  created_at INTEGER NOT NULL
);
`);

module.exports = db;
