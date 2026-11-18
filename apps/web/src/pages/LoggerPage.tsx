import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Box, Button, Chip, CircularProgress, Divider, FormControlLabel, IconButton, List, ListItemButton, ListItemText, Paper, Stack, Switch, TextField, Tooltip, Typography } from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import VisibilityIcon from '@mui/icons-material/Visibility';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import TerminalIcon from '@mui/icons-material/Terminal';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import type { LoggerRun, LoggerState } from '@sf/shared';
import { api } from '../api/client';
import { useServerEvents } from '../api/ws';
import { timeAgo } from '../components/common/format';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SECRET_LABELS: Record<string, string> = { ADO_PAT: 'Azure DevOps PAT', KIMAI_TOKEN: 'Kimai', LLAMA_API_KEY: 'Llama', GCAL_SA_KEY: 'Google Calendar', SLACK_BOT_TOKEN: 'Slack bot' };

const statusChip = (r: LoggerRun) => {
  const map: Record<LoggerRun['status'], { label: string; color: 'default' | 'success' | 'info' | 'warning' | 'error' }> = {
    running: { label: 'running', color: 'info' },
    created: { label: `logged${r.entryId ? ` #${r.entryId}` : ''}`, color: 'success' },
    previewed: { label: 'preview', color: 'warning' },
    skipped_duplicate: { label: `already logged${r.entryId ? ` #${r.entryId}` : ''}`, color: 'default' },
    skipped_empty: { label: 'no activity', color: 'default' },
    failed: { label: 'failed', color: 'error' },
  };
  const m = map[r.status];
  return <Chip size="small" label={m.label} color={m.color} variant={r.status === 'running' ? 'filled' : 'outlined'} />;
};

const yesterdayLocal = (): string => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
};

export function LoggerPage() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [date, setDate] = useState(yesterdayLocal);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const state = useQuery({ queryKey: ['logger', 'state'], queryFn: () => api.get<LoggerState>('/api/logger/state'), refetchInterval: 60_000 });
  const runs = useQuery({ queryKey: ['logger', 'runs'], queryFn: () => api.get<LoggerRun[]>('/api/logger/runs?limit=80'), refetchInterval: 30_000 });
  useServerEvents((e) => {
    if (e.type === 'logger.changed') qc.invalidateQueries({ queryKey: ['logger'] });
  });

  const current = useMemo(() => runs.data?.find((r) => r.id === selected) ?? runs.data?.[0] ?? null, [runs.data, selected]);
  useEffect(() => {
    if (current) setDraft(current.description ?? '');
  }, [current?.id, current?.description]);

  const start = useMutation({
    mutationFn: (input: { date: string; dryRun: boolean }) => api.post<LoggerRun>('/api/logger/run', input),
    onSuccess: (r) => {
      setSelected(r.id);
      qc.invalidateQueries({ queryKey: ['logger'] });
    },
    onError: (e: Error) => setError(e.message),
  });
  const commit = useMutation({
    mutationFn: () => api.post<LoggerRun>(`/api/logger/runs/${current!.id}/commit`, { description: draft }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['logger'] }),
    onError: (e: Error) => setError(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/logger/runs/${id}`),
    onSuccess: () => {
      setSelected(null);
      qc.invalidateQueries({ queryKey: ['logger'] });
    },
  });
  const patchConfig = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch('/api/logger/config', patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['logger'] }),
    onError: (e: Error) => setError(e.message),
  });

  const s = state.data;
  const busy = !!s?.running || start.isPending || commit.isPending;
  const g = current?.gathered;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, height: '100%' }}>
      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} useFlexGap sx={{ alignItems: { md: 'center' }, flexWrap: 'wrap' }}>
          <Box sx={{ flex: 1, minWidth: 280 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
              Kimai time logger
            </Typography>
            {s ? (
              <Typography variant="body2" color="text.secondary">
                {s.config.enabled ? `Fires ${s.config.days.map((d) => DAY_NAMES[d]).join(', ')} at ${s.config.time} (this Mac's time) and logs the previous day.` : 'Schedule disabled; run it by hand below.'}
                {s.nextRunAt ? ` Next: ${new Date(s.nextRunAt).toLocaleString()} → logs ${s.nextTargetDate}.` : ''}
                {s.config.catchUp ? ' Missed slots run at the next start of the app.' : ''}
              </Typography>
            ) : (
              <CircularProgress size={16} />
            )}
            {s && (
              <Stack direction="row" spacing={0.5} useFlexGap sx={{ mt: 1, flexWrap: 'wrap' }}>
                <Tooltip title={s.adoViaAz ? 'Azure DevOps commits are read with an az CLI token' : 'az CLI not logged in; the PAT is used instead'}>
                  <Chip size="small" label="ADO via az" color={s.adoViaAz ? 'success' : 'default'} variant="outlined" />
                </Tooltip>
                {Object.entries(s.secrets).map(([k, ok]) => (
                  <Tooltip key={k} title={ok ? `${k} present in ${s.secretsPath}` : `${k} missing in ${s.secretsPath}`}>
                    <Chip size="small" label={SECRET_LABELS[k] || k} color={ok ? 'success' : 'warning'} variant="outlined" />
                  </Tooltip>
                ))}
                <Chip size="small" label={`model ${s.config.model}`} variant="outlined" />
              </Stack>
            )}
          </Box>
          <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            {s && <FormControlLabel control={<Switch size="small" checked={s.config.enabled} onChange={(_e, v) => patchConfig.mutate({ enabled: v })} />} label="Scheduled" />}
            {s && <FormControlLabel control={<Switch size="small" checked={s.config.notifySlack} onChange={(_e, v) => patchConfig.mutate({ notifySlack: v })} />} label="Slack DM" />}
            {s && <TextField size="small" type="time" label="Time" value={s.config.time} onChange={(e) => e.target.value && patchConfig.mutate({ time: e.target.value })} sx={{ width: 120 }} slotProps={{ inputLabel: { shrink: true } }} />}
            <TextField size="small" type="date" label="Day to log" value={date} onChange={(e) => setDate(e.target.value)} sx={{ width: 170 }} slotProps={{ inputLabel: { shrink: true } }} />
            <Tooltip title="Gather everything and write the entry, but do not create it in Kimai. You can edit and log it afterwards.">
              <span>
                <Button variant="outlined" startIcon={<VisibilityIcon />} disabled={busy || !date} onClick={() => start.mutate({ date, dryRun: true })}>
                  Preview
                </Button>
              </span>
            </Tooltip>
            <Tooltip title="Run the whole flow now and create the Kimai entry (skips if the day is already logged).">
              <span>
                <Button variant="contained" startIcon={busy ? <CircularProgress size={16} color="inherit" /> : <PlayArrowIcon />} disabled={busy || !date} onClick={() => start.mutate({ date, dryRun: false })}>
                  Log now
                </Button>
              </span>
            </Tooltip>
          </Stack>
        </Stack>
      </Paper>

      <Box sx={{ display: 'flex', gap: 2, flex: 1, minHeight: 0 }}>
        <Paper variant="outlined" sx={{ width: 340, flexShrink: 0, overflow: 'auto' }}>
          <List dense disablePadding>
            {(runs.data ?? []).map((r) => (
              <ListItemButton key={r.id} selected={current?.id === r.id} onClick={() => setSelected(r.id)} sx={{ alignItems: 'flex-start' }}>
                <ListItemText
                  primary={
                    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {r.date}
                      </Typography>
                      {statusChip(r)}
                    </Box>
                  }
                  secondary={`${r.trigger} · ${timeAgo(r.startedAt)}${r.costUsd ? ` · $${r.costUsd.toFixed(2)}` : ''}`}
                />
              </ListItemButton>
            ))}
            {runs.data && runs.data.length === 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                No runs yet. Press Preview to see what would be logged for yesterday.
              </Typography>
            )}
          </List>
        </Paper>

        <Paper variant="outlined" sx={{ flex: 1, minWidth: 0, p: 2, overflow: 'auto' }}>
          {!current ? (
            <Typography variant="body2" color="text.secondary">
              Select a run.
            </Typography>
          ) : (
            <Stack spacing={2}>
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                <Typography variant="h6">{current.date}</Typography>
                {statusChip(current)}
                {current.trigger !== 'preview' && <Chip size="small" label={current.trigger} variant="outlined" />}
                {current.notified && <Chip size="small" label="Slack DM sent" variant="outlined" color="info" />}
                <Box sx={{ flex: 1 }} />
                {current.sessionId && (
                  <Button size="small" startIcon={<TerminalIcon />} onClick={() => (location.hash = `sessions/${current.sessionId}`)}>
                    Open session
                  </Button>
                )}
                {current.status !== 'running' && (
                  <Tooltip title="Remove this run from the history (the Kimai entry is not touched)">
                    <IconButton size="small" onClick={() => remove.mutate(current.id)}>
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
              </Box>
              {current.statusLine && <Alert severity={current.status === 'created' ? 'success' : current.status === 'failed' ? 'error' : current.status === 'previewed' ? 'warning' : 'info'}>{current.statusLine}</Alert>}
              {g?.warnings?.length ? (
                <Alert severity="warning">
                  {g.warnings.map((w, i) => (
                    <div key={i}>{w}</div>
                  ))}
                </Alert>
              ) : null}

              {(current.description || current.status === 'previewed') && (
                <Box>
                  <Typography variant="subtitle2" gutterBottom>
                    Entry description {current.status === 'previewed' ? '(editable before logging)' : ''}
                  </Typography>
                  {current.status === 'previewed' ? (
                    <Stack spacing={1}>
                      <TextField multiline minRows={8} value={draft} onChange={(e) => setDraft(e.target.value)} fullWidth slotProps={{ input: { sx: { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13 } } }} />
                      <Box>
                        <Button variant="contained" color="success" startIcon={<CheckCircleIcon />} disabled={busy || !draft.trim()} onClick={() => commit.mutate()}>
                          Log this entry in Kimai
                        </Button>
                      </Box>
                    </Stack>
                  ) : (
                    <Box component="pre" sx={{ m: 0, p: 1.5, bgcolor: 'background.default', borderRadius: 1, fontSize: 13, whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, Menlo, monospace' }}>
                      {current.description}
                    </Box>
                  )}
                </Box>
              )}

              {g && (
                <Box>
                  <Typography variant="subtitle2" gutterBottom>
                    Gathered
                  </Typography>
                  <Stack spacing={1}>
                    <Section title={`Azure commits (${g.commitTop.length})`} lines={g.commitTop} />
                    <Section title={`Llama items (${g.llamaLines.length})`} lines={g.llamaLines} />
                    <Section title={`Calendar meetings (${g.meetings.length})`} lines={g.meetings} />
                    <Section title={`Slack discussions with you (${g.slackCandidates.length})`} lines={g.slackCandidates} />
                  </Stack>
                </Box>
              )}

              <Divider />
              <Box>
                <Typography variant="subtitle2" gutterBottom>
                  Log
                </Typography>
                <Box component="pre" sx={{ m: 0, fontSize: 12, color: 'text.secondary', whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, Menlo, monospace' }}>
                  {current.log.join('\n') || '…'}
                </Box>
              </Box>
            </Stack>
          )}
        </Paper>
      </Box>
    </Box>
  );
}

function Section({ title, lines }: { title: string; lines: string[] }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        {title}
      </Typography>
      {lines.length ? (
        <Box component="ul" sx={{ m: 0, pl: 2.5, fontSize: 13 }}>
          {lines.map((l, i) => (
            <li key={i} style={{ wordBreak: 'break-word' }}>
              {l}
            </li>
          ))}
        </Box>
      ) : (
        <Typography variant="body2" color="text.disabled" sx={{ fontSize: 13 }}>
          none
        </Typography>
      )}
    </Box>
  );
}
