import { useEffect, useRef, useState } from 'react';
import { Box, Chip, Typography } from '@mui/material';
import type { RunEvent, ServerEvent } from '@sf/shared';
import { api } from '../../api/client';
import { useServerEvents } from '../../api/ws';
import { mono } from '../../theme';
import { Markdown } from '../common/Markdown';

const colors: Partial<Record<RunEvent['type'], string>> = {
  step_started: '#7aa2f7',
  step_finished: '#7aa2f7',
  iteration: '#bb9af7',
  decision: '#9ece6a',
  human_request: '#e0af68',
  human_answer: '#e0af68',
  error: '#f7768e',
  tool_use: '#565f89',
  shell: '#7dcfff',
  run_finished: '#9ece6a',
};

export function RunLog({ runId }: { runId: string }) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setEvents([]);
    api.get<RunEvent[]>(`/api/runs/${runId}/events`).then(setEvents).catch(() => undefined);
  }, [runId]);
  useServerEvents((e: ServerEvent) => {
    if (e.type === 'run.event' && e.event.runId === runId) setEvents((prev) => (prev.some((x) => x.id === e.event.id) ? prev : [...prev, e.event]));
  });
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [events.length]);
  return (
    <Box sx={{ fontFamily: mono, fontSize: 12, bgcolor: 'background.default', borderRadius: 1, p: 1, maxHeight: 420, overflow: 'auto' }}>
      {events.length === 0 && <Typography variant="caption" color="text.secondary">No events yet.</Typography>}
      {events.map((e) => (
        <Box key={e.id} sx={{ display: 'flex', gap: 1, py: 0.25, borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
          <Typography variant="caption" color="text.secondary" sx={{ minWidth: 62, fontFamily: mono }}>
            {new Date(e.ts).toLocaleTimeString([], { hour12: false })}
          </Typography>
          <Chip label={e.role || e.type} size="small" sx={{ height: 18, fontSize: 10, minWidth: 90, bgcolor: 'transparent', border: '1px solid', borderColor: colors[e.type] || 'divider', color: colors[e.type] || 'text.secondary' }} />
          {e.type === 'assistant_text' || e.type === 'decision' || e.type === 'human_note' ? (
            <Markdown sx={{ flex: 1, minWidth: 0, fontFamily: 'Inter, system-ui, sans-serif', color: 'text.primary', '& p:first-of-type': { mt: 0 } }}>{e.text}</Markdown>
          ) : (
            <Box sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'text.secondary', flex: 1, minWidth: 0 }}>{e.text}</Box>
          )}
        </Box>
      ))}
      <div ref={endRef} />
    </Box>
  );
}
