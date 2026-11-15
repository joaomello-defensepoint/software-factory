import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, ensureDirs } from './config.js';

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  ensureDirs();
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(d: DatabaseSync): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      key TEXT UNIQUE,
      url TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      issue_type TEXT,
      priority TEXT,
      labels TEXT NOT NULL DEFAULT '[]',
      epic_key TEXT,
      external_status TEXT,
      col TEXT NOT NULL DEFAULT 'backlog',
      position REAL NOT NULL DEFAULT 0,
      project_id TEXT,
      base_branch TEXT,
      branch TEXT,
      worktree_path TEXT,
      run_id TEXT,
      pr_url TEXT,
      pr_id INTEGER,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cards_col ON cards(col, archived);

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL,
      current_step TEXT,
      iteration INTEGER NOT NULL DEFAULT 1,
      worktree_path TEXT NOT NULL,
      branch TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      cost_usd REAL NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error TEXT,
      summary TEXT,
      state TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_runs_card ON runs(card_id);

    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      step TEXT,
      role TEXT,
      text TEXT NOT NULL,
      data TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, id);

    CREATE TABLE IF NOT EXISTS human_requests (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      card_id TEXT NOT NULL,
      step TEXT,
      role TEXT,
      questions TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      answers TEXT,
      created_at TEXT NOT NULL,
      answered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_requests_status ON human_requests(status);

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      run_id TEXT,
      ts TEXT NOT NULL,
      text TEXT NOT NULL,
      delivered TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_notes_card ON notes(card_id, ts);

    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

export function kvGet<T>(key: string, fallback: T): T {
  const row = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function kvSet(key: string, value: unknown): void {
  getDb()
    .prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

export const nowIso = (): string => new Date().toISOString();
