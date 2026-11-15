import { env } from '../config.js';

export const fathomConfigured = (): boolean => !!env.fathom.apiKey;

const BASE = 'https://api.fathom.ai/external/v1';

export interface FathomTranscriptLine {
  speaker: string;
  email: string | null;
  text: string;
  timestamp: string;
}

export interface FathomMeeting {
  recordingId: string;
  title: string;
  url: string;
  shareUrl: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  recordedBy: string | null;
  invitees: string[];
  summaryMarkdown: string | null;
  actionItems: Array<{ description: string; assignee: string | null; playbackUrl: string | null; timestamp: string | null }>;
  transcript: FathomTranscriptLine[] | null;
}

async function fathomFetch<T>(path: string): Promise<T> {
  if (!fathomConfigured()) throw new Error('Fathom is not configured (FATHOM_API_KEY)');
  const res = await fetch(`${BASE}${path}`, { headers: { 'X-Api-Key': env.fathom.apiKey, Accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Fathom ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

function mapMeeting(m: any, withTranscript: boolean): FathomMeeting {
  const ts = (v: any): string | null => (v ? String(v) : null);
  return {
    recordingId: String(m.recording_id ?? m.id ?? ''),
    title: m.title || m.meeting_title || 'Untitled meeting',
    url: m.url || m.share_url || '',
    shareUrl: m.share_url || null,
    createdAt: m.created_at || m.recording_start_time || '',
    startedAt: ts(m.recording_start_time || m.scheduled_start_time),
    endedAt: ts(m.recording_end_time || m.scheduled_end_time),
    recordedBy: m.recorded_by?.email || m.recorded_by?.name || null,
    invitees: (m.calendar_invitees || []).map((i: any) => i.email || i.name).filter(Boolean),
    summaryMarkdown: m.default_summary?.markdown_formatted || null,
    actionItems: (m.action_items || []).map((a: any) => ({
      description: a.description || '',
      assignee: a.assignee?.email || a.assignee?.name || null,
      playbackUrl: a.recording_playback_url || null,
      timestamp: a.recording_timestamp || null,
    })),
    transcript: withTranscript
      ? (m.transcript || []).map((l: any) => ({
          speaker: l.speaker?.display_name || 'Unknown',
          email: l.speaker?.matched_calendar_invitee_email || null,
          text: l.text || '',
          timestamp: l.timestamp || '',
        }))
      : null,
  };
}

export async function listMeetings(opts: { createdAfter?: string; createdBefore?: string; maxPages?: number } = {}): Promise<FathomMeeting[]> {
  const out: FathomMeeting[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const params = new URLSearchParams();
    if (opts.createdAfter) params.set('created_after', opts.createdAfter);
    if (opts.createdBefore) params.set('created_before', opts.createdBefore);
    if (cursor) params.set('cursor', cursor);
    const page = await fathomFetch<{ items: any[]; next_cursor?: string | null }>(`/meetings?${params}`);
    out.push(...(page.items || []).map((m) => mapMeeting(m, false)));
    cursor = page.next_cursor || undefined;
    pages++;
  } while (cursor && pages < (opts.maxPages ?? 3));
  return out;
}

/** Fetches one meeting with transcript, summary and action items (lists are the only endpoint; filtered client-side). */
export async function getMeeting(recordingId: string, createdAtHint?: string): Promise<FathomMeeting | null> {
  const params = new URLSearchParams({ include_transcript: 'true', include_summary: 'true', include_action_items: 'true' });
  if (createdAtHint) {
    const d = new Date(createdAtHint);
    if (!Number.isNaN(d.getTime())) {
      params.set('created_after', new Date(d.getTime() - 36e5).toISOString());
      params.set('created_before', new Date(d.getTime() + 36e5).toISOString());
    }
  }
  let cursor: string | undefined;
  let pages = 0;
  do {
    if (cursor) params.set('cursor', cursor);
    const page = await fathomFetch<{ items: any[]; next_cursor?: string | null }>(`/meetings?${params}`);
    const hit = (page.items || []).find((m) => String(m.recording_id ?? m.id) === String(recordingId));
    if (hit) return mapMeeting(hit, true);
    cursor = page.next_cursor || undefined;
    pages++;
  } while (cursor && pages < 10);
  return null;
}

/** Renders a meeting in the same text format Fathom's own export uses (what the vaults already contain). */
export function renderMeetingExport(m: FathomMeeting): string {
  const started = m.startedAt ? new Date(m.startedAt) : m.createdAt ? new Date(m.createdAt) : null;
  const ended = m.endedAt ? new Date(m.endedAt) : null;
  const mins = started && ended ? Math.max(1, Math.round((ended.getTime() - started.getTime()) / 60000)) : null;
  const dateLabel = started ? started.toLocaleDateString('en-US', { month: 'long', day: '2-digit' }) : '';
  const lines: string[] = [];
  lines.push(`${m.title}${dateLabel ? ` - ${dateLabel}` : ''}`);
  lines.push(`VIEW RECORDING${mins ? ` - ${mins} mins` : ''}: ${m.shareUrl || m.url}`);
  for (const a of m.actionItems) lines.push(`ACTION ITEM: ${a.description}${a.assignee ? ` (${a.assignee})` : ''}${a.playbackUrl ? ` - WATCH: ${a.playbackUrl}` : ''}`);
  lines.push('');
  if (m.summaryMarkdown) {
    lines.push('SUMMARY:');
    lines.push(m.summaryMarkdown.trim());
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  for (const t of m.transcript || []) {
    lines.push(`${formatTs(t.timestamp)} - ${t.speaker}`);
    lines.push(`  ${t.text}`);
    lines.push('');
  }
  return lines.join('\n');
}

function formatTs(ts: string): string {
  // Fathom timestamps come as "HH:MM:SS" or seconds; normalise to M:SS or H:MM:SS.
  if (/^\d+(\.\d+)?$/.test(ts)) {
    const total = Math.floor(Number(ts));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }
  const parts = ts.split(':').map(Number);
  if (parts.length === 3 && parts[0] === 0) return `${parts[1]}:${String(parts[2]).padStart(2, '0')}`;
  return ts;
}
