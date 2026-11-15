import { useEffect, useRef, useState } from 'react';
import { Box, Chip, Paper, Typography } from '@mui/material';
import type { Job, ServerEvent } from '@sf/shared';
import { api } from '../../api/client';
import { useServerEvents } from '../../api/ws';
import { mono } from '../../theme';

export function JobLog({ jobId, title }: { jobId: string; title?: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get<Job>(`/api/jobs/${jobId}`).then((j) => {
      setJob(j);
      setLines(j.lines);
    }).catch(() => undefined);
  }, [jobId]);

  useServerEvents((e: ServerEvent) => {
    if (e.type === 'job.log' && e.jobId === jobId) setLines((l) => [...l, e.line].slice(-2000));
    if (e.type === 'job.done' && e.jobId === jobId) api.get<Job>(`/api/jobs/${jobId}`).then(setJob).catch(() => undefined);
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [lines.length]);

  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Typography variant="subtitle2" sx={{ flex: 1 }}>
          {title || job?.title || 'Job'}
        </Typography>
        {job && <Chip label={job.status} color={job.status === 'succeeded' ? 'success' : job.status === 'failed' ? 'error' : 'info'} />}
      </Box>
      <Box sx={{ maxHeight: 360, overflow: 'auto', fontFamily: mono, fontSize: 12, whiteSpace: 'pre-wrap', color: 'text.secondary', bgcolor: 'background.default', p: 1, borderRadius: 1 }}>
        {lines.length ? lines.join('\n') : 'Waiting for output…'}
        <div ref={endRef} />
      </Box>
    </Paper>
  );
}
