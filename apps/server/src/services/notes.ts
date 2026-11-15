import { nanoid } from 'nanoid';
import type { Note } from '@sf/shared';
import { getDb, nowIso } from '../db.js';
import { hub } from '../events.js';

interface Row {
  id: string;
  card_id: string;
  run_id: string | null;
  ts: string;
  text: string;
  delivered: string;
}

const toNote = (r: Row): Note => ({ id: r.id, cardId: r.card_id, runId: r.run_id, ts: r.ts, text: r.text, delivered: JSON.parse(r.delivered || '[]') });

export function listNotes(cardId: string): Note[] {
  return (getDb().prepare('SELECT * FROM notes WHERE card_id = ? ORDER BY ts').all(cardId) as unknown as Row[]).map(toNote);
}

export function addNote(cardId: string, runId: string | null, text: string): Note {
  const id = nanoid(10);
  getDb().prepare('INSERT INTO notes (id, card_id, run_id, ts, text, delivered) VALUES (?, ?, ?, ?, ?, ?)').run(id, cardId, runId, nowIso(), text.trim(), '[]');
  const note = toNote(getDb().prepare('SELECT * FROM notes WHERE id = ?').get(id) as unknown as Row);
  hub.broadcast({ type: 'note.created', note });
  return note;
}

/** Notes this session (step:role) has not received yet. */
export function undeliveredNotes(cardId: string, sessionKey: string): Note[] {
  return listNotes(cardId).filter((n) => !n.delivered.includes(sessionKey));
}

export function markDelivered(noteIds: string[], sessionKey: string): void {
  const db = getDb();
  for (const id of noteIds) {
    const row = db.prepare('SELECT delivered FROM notes WHERE id = ?').get(id) as { delivered: string } | undefined;
    if (!row) continue;
    const set = new Set<string>(JSON.parse(row.delivered || '[]'));
    set.add(sessionKey);
    db.prepare('UPDATE notes SET delivered = ? WHERE id = ?').run(JSON.stringify([...set]), id);
  }
}

/** Markdown block with all notes for a card (oldest first), or an empty string. */
export function notesBlock(cardId: string): string {
  const notes = listNotes(cardId);
  if (!notes.length) return '';
  return notes.map((n) => `- [${n.ts.slice(0, 16).replace('T', ' ')}] ${n.text}`).join('\n');
}
