import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Box, Button, Chip, Dialog, DialogContent, DialogTitle, Divider, FormControl, FormControlLabel, IconButton, InputLabel, MenuItem, Select, Stack, Switch, Tab, Tabs, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ReactMarkdown from 'react-markdown';
import type { Card, Project, WorkflowDefinition, WorkflowRun } from '@sf/shared';
import { api } from '../../api/client';
import { RunLog } from './RunLog';
import { runStatusColor, sourceColor } from './CardItem';
import { timeAgo } from '../common/format';

type RunWithActive = WorkflowRun & { active: boolean };

export function CardDialog({ card, projects, workflows, onClose }: { card: Card | null; projects: Project[]; workflows: WorkflowDefinition[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'details' | 'run'>('details');
  const [workflowId, setWorkflowId] = useState<string>('');
  const [draft, setDraft] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const id = card?.id;

  useEffect(() => {
    setTab(card?.runId ? 'run' : 'details');
    setError(null);
    setNotice(null);
  }, [id]);
  useEffect(() => {
    if (!workflowId && workflows.length) setWorkflowId(workflows[0].id);
  }, [workflows, workflowId]);

  const runs = useQuery({ queryKey: ['runs', id], queryFn: () => api.get<RunWithActive[]>(`/api/runs?cardId=${id}`), enabled: !!id, refetchInterval: 10_000 });
  const transitions = useQuery({ queryKey: ['transitions', card?.key], queryFn: () => api.get<Array<{ id: string; name: string; to: string }>>(`/api/jira/transitions/${card!.key}`), enabled: !!card?.key && card.source === 'jira', retry: false });
  const llamaStatuses = useQuery({ queryKey: ['llama-statuses', card?.key?.split('-')[0]], queryFn: () => api.get<Array<{ id: string; name: string }>>(`/api/llama/statuses?project=${card!.key!.split('-')[0]}`), enabled: !!card?.key && card.source === 'llama', retry: false });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['cards'] });
    qc.invalidateQueries({ queryKey: ['runs', id] });
  };
  const fail = (e: Error) => setError(e.message);
  const patch = useMutation({ mutationFn: (p: Partial<Card>) => api.patch(`/api/cards/${id}`, p), onSuccess: invalidate, onError: fail });
  const start = useMutation({
    mutationFn: () => api.post<WorkflowRun>('/api/runs', { cardId: id, workflowId, projectId: card?.projectId, baseBranch: card?.baseBranch }),
    onSuccess: () => {
      setTab('run');
      invalidate();
    },
    onError: fail,
  });
  const cancel = useMutation({ mutationFn: (runId: string) => api.post(`/api/runs/${runId}/cancel`), onSuccess: invalidate, onError: fail });
  const open = useMutation({ mutationFn: () => api.post<{ ok: boolean; message: string }>(`/api/cards/${id}/open`), onSuccess: (r) => (r.ok ? setNotice(r.message) : setError(r.message)), onError: fail });
  const createPr = useMutation({ mutationFn: () => api.post<{ url: string }>(`/api/cards/${id}/pr`, { draft }), onSuccess: (pr) => { setNotice(`PR created: ${pr.url}`); invalidate(); }, onError: fail });
  const refreshPr = useMutation({ mutationFn: () => api.post<{ status: string; mergeStatus: string | null }>(`/api/cards/${id}/pr/refresh`), onSuccess: (pr) => { setNotice(`PR status: ${pr.status}${pr.mergeStatus ? ` (${pr.mergeStatus})` : ''}`); invalidate(); }, onError: fail });
  const transition = useMutation({ mutationFn: (t: string) => api.post(`/api/jira/transitions/${card!.key}`, { transition: t }), onSuccess: () => { invalidate(); qc.invalidateQueries({ queryKey: ['transitions'] }); }, onError: fail });
  const llamaStatus = useMutation({ mutationFn: (s: string) => api.post(`/api/llama/status/${card!.key}`, { status: s }), onSuccess: invalidate, onError: fail });
  const remove = useMutation({ mutationFn: () => api.del(`/api/cards/${id}`), onSuccess: () => { invalidate(); onClose(); }, onError: fail });

  if (!card) return null;
  const project = projects.find((p) => p.id === card.projectId);
  const latest = runs.data?.[0];
  const running = latest?.active;

  return (
    <Dialog open onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 6 }}>
        {card.key && <Chip label={card.key} color={sourceColor[card.source]} variant="outlined" onClick={card.url ? () => window.open(card.url!, '_blank') : undefined} />}
        <Typography variant="h6" sx={{ flex: 1, fontSize: 16 }}>
          {card.title}
        </Typography>
        {card.runStatus && <Chip label={card.runStatus.replace('_', ' ')} color={runStatusColor(card.runStatus)} />}
        <IconButton onClick={onClose} sx={{ position: 'absolute', right: 8, top: 8 }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ px: 3, borderBottom: 1, borderColor: 'divider' }}>
        <Tab value="details" label="Details" />
        <Tab value="run" label={`Workflow run${runs.data?.length ? ` (${runs.data.length})` : ''}`} />
      </Tabs>
      <DialogContent sx={{ minHeight: 420 }}>
        {error && <Alert severity="error" onClose={() => setError(null)} sx={{ mb: 2 }}>{error}</Alert>}
        {notice && <Alert severity="success" onClose={() => setNotice(null)} sx={{ mb: 2 }}>{notice}</Alert>}
        {tab === 'details' && (
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '2fr 1fr' }, gap: 3 }}>
            <Box>
              <Typography variant="caption" color="text.secondary">
                {card.issueType || 'card'} · {card.priority || 'no priority'} · {card.externalStatus ? `tracker status: ${card.externalStatus}` : card.source} · updated {timeAgo(card.updatedAt)}
                {card.epicKey ? ` · epic ${card.epicKey}` : ''}
              </Typography>
              <Box sx={{ '& p': { mt: 0 }, '& pre': { whiteSpace: 'pre-wrap', bgcolor: 'background.default', p: 1, borderRadius: 1 }, fontSize: 14, mt: 1 }}>
                <ReactMarkdown>{card.description || '_No description._'}</ReactMarkdown>
              </Box>
              {card.labels.length > 0 && (
                <Stack direction="row" spacing={0.5} sx={{ mt: 1 }}>
                  {card.labels.map((l) => <Chip key={l} label={l} variant="outlined" />)}
                </Stack>
              )}
            </Box>
            <Stack spacing={2}>
              <FormControl size="small" fullWidth>
                <InputLabel>Project</InputLabel>
                <Select label="Project" value={card.projectId ?? ''} onChange={(e) => patch.mutate({ projectId: e.target.value || null, baseBranch: projects.find((p) => p.id === e.target.value)?.baseBranches[0] ?? null })}>
                  <MenuItem value="">—</MenuItem>
                  {projects.map((p) => <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>)}
                </Select>
              </FormControl>
              <FormControl size="small" fullWidth disabled={!project}>
                <InputLabel>Base branch</InputLabel>
                <Select label="Base branch" value={card.baseBranch ?? project?.baseBranches[0] ?? ''} onChange={(e) => patch.mutate({ baseBranch: e.target.value })}>
                  {(project?.baseBranches ?? []).map((b) => <MenuItem key={b} value={b}>{b}</MenuItem>)}
                </Select>
              </FormControl>
              <Divider />
              <FormControl size="small" fullWidth>
                <InputLabel>Workflow</InputLabel>
                <Select label="Workflow" value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
                  {workflows.map((w) => <MenuItem key={w.id} value={w.id}>{w.name}</MenuItem>)}
                </Select>
              </FormControl>
              <Button variant="contained" disabled={!card.projectId || !workflowId || running || start.isPending} onClick={() => start.mutate()}>
                {running ? 'Workflow running…' : card.worktreePath ? 'Run workflow again' : 'Start workflow (creates worktree)'}
              </Button>
              {card.worktreePath && (
                <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
                  branch <b>{card.branch}</b>
                  <br />
                  {card.worktreePath}
                </Typography>
              )}
              <Button variant="outlined" onClick={() => open.mutate()} disabled={!card.worktreePath && !card.projectId}>
                Open in VS Code
              </Button>
              <Divider />
              {card.prUrl ? (
                <>
                  <Button variant="outlined" href={card.prUrl} target="_blank">
                    Open PR #{card.prId}
                  </Button>
                  <Button onClick={() => refreshPr.mutate()} disabled={refreshPr.isPending}>
                    Refresh PR status
                  </Button>
                </>
              ) : (
                <>
                  <FormControlLabel control={<Switch checked={draft} onChange={(e) => setDraft(e.target.checked)} />} label="Create as draft" />
                  <Button variant="outlined" disabled={!card.worktreePath || !project?.ado || createPr.isPending} onClick={() => createPr.mutate()}>
                    {createPr.isPending ? 'Pushing & creating PR…' : 'Create Azure DevOps PR'}
                  </Button>
                </>
              )}
              {card.source === 'jira' && (
                <FormControl size="small" fullWidth>
                  <InputLabel>Transition in Jira</InputLabel>
                  <Select label="Transition in Jira" value="" onChange={(e) => e.target.value && transition.mutate(e.target.value)}>
                    {(transitions.data ?? []).map((t) => <MenuItem key={t.id} value={t.name}>{t.name} → {t.to}</MenuItem>)}
                    {transitions.isError && <MenuItem disabled value="">Jira not configured</MenuItem>}
                  </Select>
                </FormControl>
              )}
              {card.source === 'llama' && (
                <FormControl size="small" fullWidth>
                  <InputLabel>Set Llama status</InputLabel>
                  <Select label="Set Llama status" value="" onChange={(e) => e.target.value && llamaStatus.mutate(e.target.value)}>
                    {(llamaStatuses.data ?? []).map((s) => <MenuItem key={s.id} value={s.name}>{s.name}</MenuItem>)}
                  </Select>
                </FormControl>
              )}
              <Button color="error" onClick={() => remove.mutate()} disabled={running}>
                {card.source === 'local' ? 'Delete card' : 'Remove from board (keeps the ticket)'}
              </Button>
            </Stack>
          </Box>
        )}
        {tab === 'run' && (
          <Stack spacing={2}>
            {!runs.data?.length && <Typography color="text.secondary">No runs yet. Pick a project and a workflow in Details, then start it.</Typography>}
            {latest && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Chip label={latest.status.replace('_', ' ')} color={runStatusColor(latest.status)} />
                <Typography variant="body2">
                  {latest.workflowId} · iteration {latest.iteration}{latest.currentStep ? ` · step ${latest.currentStep}` : ''} · ≈ ${latest.costUsd.toFixed(2)} · started {timeAgo(latest.startedAt)}
                </Typography>
                <Box sx={{ flex: 1 }} />
                {latest.active && (
                  <Button color="error" variant="outlined" onClick={() => cancel.mutate(latest.id)}>
                    Cancel run
                  </Button>
                )}
              </Box>
            )}
            {latest?.error && <Alert severity="error">{latest.error}</Alert>}
            {latest?.summary && latest.status === 'succeeded' && (
              <Alert severity="success" sx={{ '& .MuiAlert-message': { width: '100%' } }}>
                <Box sx={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto', fontSize: 13 }}>{latest.summary}</Box>
              </Alert>
            )}
            {latest && <RunLog runId={latest.id} />}
          </Stack>
        )}
      </DialogContent>
    </Dialog>
  );
}
