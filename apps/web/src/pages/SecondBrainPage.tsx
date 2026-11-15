import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Box, Button, Chip, FormControl, InputLabel, List, ListItemButton, ListItemText, MenuItem, Paper, Select, Stack, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import ReactMarkdown from 'react-markdown';
import type { BrainPage, BrainVault, FathomMeetingSummary, Job, Project } from '@sf/shared';
import { api } from '../api/client';
import { JobLog } from '../components/common/JobLog';
import { timeAgo } from '../components/common/format';

export function SecondBrainPage() {
  const qc = useQueryClient();
  const vaults = useQuery({ queryKey: ['brain', 'vaults'], queryFn: () => api.get<BrainVault[]>('/api/brain/vaults') });
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.get<Project[]>('/api/projects') });
  const [vaultId, setVaultId] = useState<string>('');
  useEffect(() => {
    if (!vaultId && vaults.data?.length) setVaultId(vaults.data.find((v) => v.id === 'eam')?.id ?? vaults.data[0].id);
  }, [vaults.data, vaultId]);
  const vault = vaults.data?.find((v) => v.id === vaultId);

  const [days, setDays] = useState(14);
  const meetings = useQuery({ queryKey: ['brain', 'meetings', days], queryFn: () => api.get<FathomMeetingSummary[]>(`/api/brain/fathom/meetings?days=${days}`), retry: false });
  const pages = useQuery({ queryKey: ['brain', 'pages', vaultId], queryFn: () => api.get<BrainPage[]>(`/api/brain/vaults/${vaultId}/pages`), enabled: !!vaultId });
  const [section, setSection] = useState<BrainPage['section'] | 'all'>('synthesis');
  const [pagePath, setPagePath] = useState<string | null>(null);
  const page = useQuery({ queryKey: ['brain', 'page', vaultId, pagePath], queryFn: () => api.get<{ content: string }>(`/api/brain/vaults/${vaultId}/page?path=${encodeURIComponent(pagePath!)}`), enabled: !!pagePath });
  const [question, setQuestion] = useState('');
  const [projectId, setProjectId] = useState('');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);

  const pushJob = (j: Job) => setJobs((prev) => [j, ...prev].slice(0, 6));
  const fail = (e: Error) => setError(e.message);
  const ingest = useMutation({ mutationFn: (m: FathomMeetingSummary) => api.post<Job>(`/api/brain/vaults/${vaultId}/ingest`, { recordingId: m.recordingId, createdAt: m.createdAt }), onSuccess: pushJob, onError: fail });
  const index = useMutation({ mutationFn: () => api.post<Job>(`/api/brain/vaults/${vaultId}/index-repo`, { projectId }), onSuccess: pushJob, onError: fail });
  const lint = useMutation({ mutationFn: () => api.post<Job>(`/api/brain/vaults/${vaultId}/lint`), onSuccess: pushJob, onError: fail });
  const ask = useMutation({ mutationFn: () => api.post<Job>(`/api/brain/vaults/${vaultId}/query`, { question }), onSuccess: (j) => { pushJob(j); setQuestion(''); }, onError: fail });
  const openVault = useMutation({ mutationFn: () => api.post(`/api/brain/vaults/${vaultId}/open`), onError: fail });

  const filteredPages = useMemo(() => (pages.data ?? []).filter((p) => section === 'all' || p.section === section), [pages.data, section]);
  const vaultProjects = (projects.data ?? []).filter((p) => !vault || p.vaultPath === vault.path || !p.vaultPath);

  return (
    <Stack spacing={2} sx={{ height: '100%' }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
        <FormControl size="small" sx={{ minWidth: 200 }}>
          <InputLabel>Vault</InputLabel>
          <Select label="Vault" value={vaultId} onChange={(e) => { setVaultId(e.target.value); setPagePath(null); }}>
            {vaults.data?.map((v) => <MenuItem key={v.id} value={v.id}>{v.name} · {v.wikiCount} pages · {v.rawCount} sources</MenuItem>)}
          </Select>
        </FormControl>
        {vault && (
          <Typography variant="caption" color="text.secondary">
            {vault.path} · last log entry {vault.lastLog ?? 'never'}
          </Typography>
        )}
        <Box sx={{ flex: 1 }} />
        <FormControl size="small" sx={{ minWidth: 220 }}>
          <InputLabel>Repository to index</InputLabel>
          <Select label="Repository to index" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {vaultProjects.map((p) => <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>)}
          </Select>
        </FormControl>
        <Button variant="outlined" disabled={!projectId || !vaultId || index.isPending} onClick={() => index.mutate()}>
          Index repository
        </Button>
        <Button variant="outlined" disabled={!vaultId} onClick={() => lint.mutate()}>
          Lint vault
        </Button>
        <Button disabled={!vaultId} onClick={() => openVault.mutate()}>
          Open in VS Code
        </Button>
      </Stack>
      {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1.1fr 1fr 1.2fr' }, gap: 2, flex: 1, minHeight: 0 }}>
        <Paper variant="outlined" sx={{ p: 1.5, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <Typography variant="subtitle2" sx={{ flex: 1 }}>
              Fathom meetings
            </Typography>
            <ToggleButtonGroup exclusive size="small" value={days} onChange={(_e, v) => v && setDays(v)}>
              <ToggleButton value={7}>7d</ToggleButton>
              <ToggleButton value={14}>14d</ToggleButton>
              <ToggleButton value={30}>30d</ToggleButton>
              <ToggleButton value={90}>90d</ToggleButton>
            </ToggleButtonGroup>
          </Box>
          {meetings.isError && <Alert severity="warning">{(meetings.error as Error).message}</Alert>}
          <List dense sx={{ overflow: 'auto', flex: 1 }}>
            {meetings.data?.map((m) => (
              <ListItemButton key={m.recordingId} onClick={() => window.open(m.url, '_blank')} sx={{ alignItems: 'flex-start' }}>
                <ListItemText primary={m.title} secondary={`${m.createdAt.slice(0, 10)} · ${m.durationMin ? `${m.durationMin} min · ` : ''}${m.recordedBy ?? ''} · ${m.invitees.length} invitees`} />
                <Button size="small" variant={m.ingested ? 'text' : 'outlined'} disabled={!vaultId || ingest.isPending} onClick={(e) => { e.stopPropagation(); ingest.mutate(m); }}>
                  {m.ingested ? 'Re-ingest' : 'Ingest'}
                </Button>
              </ListItemButton>
            ))}
            {meetings.data?.length === 0 && <Typography color="text.secondary" sx={{ p: 1 }}>No meetings in this window.</Typography>}
          </List>
        </Paper>
        <Paper variant="outlined" sx={{ p: 1.5, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
            <Typography variant="subtitle2" sx={{ flex: 1 }}>
              Wiki
            </Typography>
            {(['synthesis', 'concepts', 'entities', 'sources', 'all'] as const).map((s) => (
              <Chip key={s} label={s} size="small" variant={section === s ? 'filled' : 'outlined'} color={section === s ? 'primary' : 'default'} onClick={() => setSection(s)} />
            ))}
          </Box>
          <List dense sx={{ overflow: 'auto', flex: 1 }}>
            {filteredPages.map((p) => (
              <ListItemButton key={p.path} selected={pagePath === p.path} onClick={() => setPagePath(p.path)}>
                <ListItemText primary={p.title} secondary={`${p.path}${p.updated ? ` · ${p.updated}` : ''}`} />
              </ListItemButton>
            ))}
          </List>
        </Paper>
        <Paper variant="outlined" sx={{ p: 1.5, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto' }}>
          <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
            <TextField fullWidth placeholder="Ask the second brain… e.g. what did we decide about kit substitutions?" value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && question.trim() && ask.mutate()} />
            <Button variant="contained" disabled={!question.trim() || !vaultId || ask.isPending} onClick={() => ask.mutate()}>
              Ask
            </Button>
          </Stack>
          {jobs.map((j) => (
            <Box key={j.id} sx={{ mb: 1 }}>
              <JobLog jobId={j.id} title={j.title} />
            </Box>
          ))}
          {pagePath && (
            <Box sx={{ fontSize: 13, '& pre': { whiteSpace: 'pre-wrap' }, '& h1': { fontSize: 18 }, '& h2': { fontSize: 15 } }}>
              <Typography variant="caption" color="text.secondary">
                {pagePath}
              </Typography>
              <ReactMarkdown>{page.data?.content ?? 'Loading…'}</ReactMarkdown>
            </Box>
          )}
          {!pagePath && !jobs.length && (
            <Typography color="text.secondary" variant="body2">
              Pick a wiki page to read it here, ingest a Fathom meeting, index a repository, or ask a question. Jobs stream their output here as they run.
            </Typography>
          )}
        </Paper>
      </Box>
      {vaults.data && vaults.data.length > 0 && (
        <Typography variant="caption" color="text.secondary">
          Vault ages: {vaults.data.map((v) => `${v.name} ${v.lastLog ? timeAgo(v.lastLog) : 'never'}`).join(' · ')}. The agents receive each project's vault index and synthesis dashboards as context when a workflow runs.
        </Typography>
      )}
    </Stack>
  );
}
