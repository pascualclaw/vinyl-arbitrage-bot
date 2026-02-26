import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_PATH = path.join(DB_DIR, 'listings.db');

let db: Database.Database;

export function initDb(): void {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS seen_listings (
      source    TEXT NOT NULL,
      listing_id TEXT NOT NULL,
      seen_at   INTEGER NOT NULL,
      alerted   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (source, listing_id)
    );

    CREATE TABLE IF NOT EXISTS dismissed_listings (
      source    TEXT NOT NULL,
      listing_id TEXT NOT NULL,
      dismissed_at INTEGER NOT NULL,
      PRIMARY KEY (source, listing_id)
    );
  `);

  console.log(`[cache] SQLite DB initialized at ${DB_PATH}`);
}

export function hasSeen(source: string, listingId: string): boolean {
  if (!db) throw new Error('DB not initialized');
  const row = db.prepare(
    'SELECT 1 FROM seen_listings WHERE source = ? AND listing_id = ?'
  ).get(source, listingId);
  return !!row;
}

export function markSeen(source: string, listingId: string, alerted: boolean = false): void {
  if (!db) throw new Error('DB not initialized');
  db.prepare(
    `INSERT OR IGNORE INTO seen_listings (source, listing_id, seen_at, alerted)
     VALUES (?, ?, ?, ?)`
  ).run(source, listingId, Date.now(), alerted ? 1 : 0);
}

export function markAlerted(source: string, listingId: string): void {
  if (!db) throw new Error('DB not initialized');
  db.prepare(
    `UPDATE seen_listings SET alerted = 1 WHERE source = ? AND listing_id = ?`
  ).run(source, listingId);
}

// Stub for future: Alex can respond to an alert to dismiss it
export function markDismissed(source: string, listingId: string): void {
  if (!db) throw new Error('DB not initialized');
  db.prepare(
    `INSERT OR REPLACE INTO dismissed_listings (source, listing_id, dismissed_at)
     VALUES (?, ?, ?)`
  ).run(source, listingId, Date.now());
}

export function isDismissed(source: string, listingId: string): boolean {
  if (!db) throw new Error('DB not initialized');
  const row = db.prepare(
    'SELECT 1 FROM dismissed_listings WHERE source = ? AND listing_id = ?'
  ).get(source, listingId);
  return !!row;
}

// Cleanup: remove entries older than 30 days to keep the DB lean
export function pruneOld(daysOld: number = 30): void {
  if (!db) throw new Error('DB not initialized');
  const cutoff = Date.now() - daysOld * 24 * 60 * 60 * 1000;
  const result = db.prepare(
    'DELETE FROM seen_listings WHERE seen_at < ?'
  ).run(cutoff);
  if (result.changes > 0) {
    console.log(`[cache] Pruned ${result.changes} old entries`);
  }
}
