import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Box, Button, Chip, Stack, TextField, Typography } from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import type { Note } from '@sf/shared';
import { api } from '../../api/client';
import { useServerEvents } from '../../api/ws';
import { timeAgo } from '../common/format';

/** Steering notes: what you write here reaches the running agent at its next tool call and every later step. */
export function NotesPanel({ cardId, running }: { cardId: string; running: boolean }) {
  const qc = useQueryClient();
  const notes = useQuery({ queryKey: ['notes', cardId], queryFn: () => api.get<Note[]>(`/api/cards/${cardId}/notes`) });
  const [text, setText] = useState('');
  useServerEvents((e) => {
    if (e.type === 'note.created' && e.note.cardId === cardId) qc.invalidateQueries({ queryKey: ['notes', cardId] });
    if (e.type === 'run.event' && e.event.type === 'human_note') qc.invalidateQueries({ queryKey: ['notes', cardId] });
  });
  const send = useMutation({
    mutationFn: () => api.post<Note>(`/api/cards/${cardId}/notes`, { text }),
    onSuccess: () => {
      setText('');
      qc.invalidateQueries({ queryKey: ['notes', cardId] });
    },
  });
  return (
    <Box>
      <Typography variant="subtitle2" gutterBottom>
        {running ? 'Steer the agents' : 'Notes for the agents'}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        {running
          ? 'Delivered to the running agent right after its next tool call, and prepended to every later step (reviewer, advocates, maestro).'
          : 'Read by every role when the workflow starts: direction, constraints, things to avoid, where to look first.'}
      </Typography>
      <Stack spacing={0.75} sx={{ mb: 1, maxHeight: 180, overflow: 'auto' }}>
        {notes.data?.map((n) => (
          <Box key={n.id} sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
            <Typography variant="caption" color="text.secondary" sx={{ minWidth: 56, pt: 0.25 }}>
              {timeAgo(n.ts)}
            </Typography>
            <Typography variant="body2" sx={{ flex: 1, whiteSpace: 'pre-wrap' }}>
              {n.text}
            </Typography>
            {n.delivered.length > 0 && <Chip label={`seen by ${n.delivered.length}`} size="small" sx={{ height: 18 }} />}
          </Box>
        ))}
        {notes.data?.length === 0 && (
          <Typography variant="caption" color="text.secondary">
            No notes yet.
          </Typography>
        )}
      </Stack>
      <Box sx={{ display: 'flex', gap: 1 }}>
        <TextField
          fullWidth
          multiline
          minRows={1}
          maxRows={4}
          placeholder={running ? 'e.g. keep the change inside the ReactApp, do not touch the API' : 'e.g. reuse the existing EquipmentGrid; the Kiosk side is out of scope'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) send.mutate();
          }}
        />
        <Button variant="contained" endIcon={<SendIcon />} disabled={!text.trim() || send.isPending} onClick={() => send.mutate()}>
          Send
        </Button>
      </Box>
    </Box>
  );
}
