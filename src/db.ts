import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
-- Links distribuídos pela Conty: o código aponta para o tipo e a referência.
CREATE TABLE IF NOT EXISTS links (
  code TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('campaign', 'referral', 'community')),
  ref TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL
);

-- Cada passagem pelo redirecionador /l/:code gera um click_id novo.
CREATE TABLE IF NOT EXISTS clicks (
  click_id TEXT PRIMARY KEY,
  link_code TEXT NOT NULL REFERENCES links(code),
  clicked_at TEXT NOT NULL
);

-- O app gera o device_id na primeira abertura e o envia em toda abertura e no cadastro.
CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  first_open_at TEXT NOT NULL
);

-- Toque: o app abriu carregando um link. Mesmo clique no mesmo aparelho é um toque só.
CREATE TABLE IF NOT EXISTS touches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL REFERENCES devices(device_id),
  click_id TEXT NOT NULL,
  click_id_source TEXT NOT NULL CHECK (click_id_source IN ('link', 'derived')),
  link_code TEXT NOT NULL REFERENCES links(code),
  recorded_at TEXT NOT NULL,
  UNIQUE (device_id, click_id)
);

-- A decisão inteira fica guardada para auditoria e não muda depois do cadastro.
CREATE TABLE IF NOT EXISTS signups (
  user_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  signed_up_at TEXT NOT NULL,
  origin_type TEXT NOT NULL CHECK (origin_type IN ('campaign', 'referral', 'community', 'organic')),
  origin_ref TEXT,
  winning_touch_id INTEGER REFERENCES touches(id),
  reason TEXT NOT NULL,
  decision TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS signups_by_device ON signups (device_id, signed_up_at);

CREATE TRIGGER IF NOT EXISTS signup_origin_is_final
BEFORE UPDATE ON signups
BEGIN
  SELECT RAISE(ABORT, 'origem do cadastro não muda depois de decidida');
END;
`;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}
