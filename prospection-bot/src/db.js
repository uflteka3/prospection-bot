import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// DATA_DIR : dossier persistant (sur Render, le disque monté, ex. /data)
export const DATA_DIR = process.env.DATA_DIR || '.';
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'data.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS prospects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sector TEXT,
  phone TEXT,
  email TEXT,
  website TEXT,
  facebook TEXT,
  notes TEXT,
  status TEXT DEFAULT 'nouveau',
  last_contact TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(name, phone)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id INTEGER,
  jid TEXT,
  direction TEXT,
  body TEXT,
  at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

export function addProspect(p) {
  return db.prepare(`INSERT OR IGNORE INTO prospects (name, sector, phone, email, website, facebook, notes)
    VALUES (@name, @sector, @phone, @email, @website, @facebook, @notes)`).run({
    name: p.name, sector: p.sector || null, phone: p.phone || null,
    email: p.email || null, website: p.website || null,
    facebook: p.facebook || null, notes: p.notes || null
  });
}

export function findProspect(query) {
  const q = `%${query}%`;
  return db.prepare(`SELECT * FROM prospects WHERE name LIKE ? OR phone LIKE ? LIMIT 1`).get(q, q);
}

export function findProspectByPhone(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 8) return undefined;
  return db.prepare(`SELECT * FROM prospects WHERE phone LIKE ? LIMIT 1`).get(`%${digits.slice(-8)}%`);
}

export function setStatus(id, status) {
  db.prepare(`UPDATE prospects SET status = ?, last_contact = CURRENT_TIMESTAMP WHERE id = ?`).run(status, id);
}

export function logMessage(prospectId, jid, direction, body) {
  db.prepare(`INSERT INTO messages (prospect_id, jid, direction, body) VALUES (?, ?, ?, ?)`)
    .run(prospectId, jid, direction, body);
}

export function getHistory(prospectId, limit = 20) {
  return db.prepare(`SELECT direction, body, at FROM messages WHERE prospect_id = ? ORDER BY id DESC LIMIT ?`)
    .all(prospectId, limit).reverse();
}

export function listByStatus(status) {
  if (!status || status === 'tous') return db.prepare(`SELECT * FROM prospects ORDER BY id DESC LIMIT 50`).all();
  return db.prepare(`SELECT * FROM prospects WHERE status = ? ORDER BY id DESC LIMIT 50`).all(status);
}

export function knownNames() {
  return db.prepare(`SELECT name FROM prospects`).all().map(r => r.name.toLowerCase());
}

export function isKnown(p) {
  const row = db.prepare(`SELECT 1 FROM prospects WHERE lower(name) = lower(?) OR (phone IS NOT NULL AND phone = ?) LIMIT 1`)
    .get(p.name, p.phone || '');
  return !!row;
}

// Prospects contactés sans nouvelle depuis au moins `days` jours
export function dueFollowups(days = 3) {
  return db.prepare(`SELECT * FROM prospects WHERE status = 'contacte' AND last_contact IS NOT NULL
    AND last_contact <= datetime('now', ?) ORDER BY last_contact LIMIT 20`).all(`-${Number(days)} days`);
}
