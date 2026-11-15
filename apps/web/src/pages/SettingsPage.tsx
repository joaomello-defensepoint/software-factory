import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Box, Button, Chip, Paper, Stack, Typography } from '@mui/material';
import CodeMirror from '@uiw/react-codemirror';
import { yaml } from '@codemirror/lang-yaml';
import type { IntegrationStatus, Project, UsageReport } from '@sf/shared';
import { api } from '../api/client';
import { LinearProgress, Table, TableBody, TableCell, TableHead, TableRow } from '@mui/material';
import { timeAgo } from '../components/common/format';

const limitLabel: Record<string, string> = { five_hour: 'Current session (5-hour window)', seven_day: 'Weekly (all models)', seven_day_opus: 'Weekly (Opus)', seven_day_sonnet: 'Weekly (Sonnet)' };

function UsageSection() {
  const usage = useQuery({ queryKey: ['usage'], queryFn: () => api.get<UsageReport>('/api/usage'), refetchInterval: 60_000 });
  const u = usage.data;
  if (!u) return null;
  const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle2" gutterBottom>
        AI usage
      </Typography>
      <Stack spacing={2}>
        <Box>
          <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
            Claude plan limits {u.claude.account?.subscriptionType ? `· ${u.claude.account.subscriptionType}` : ''} {u.claude.account?.email ? `· ${u.claude.account.email}` : ''}
          </Typography>
          {u.claude.rateLimits.length === 0 && (
            <Typography variant="caption" color="text.secondary">
              No limit data observed yet. Claude reports the session and weekly windows while sessions run; they appear here after the first workflow or chat.
            </Typography>
          )}
          <Stack spacing={1}>
            {u.claude.rateLimits.map((r) => (
              <Box key={r.type}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Typography variant="body2">{limitLabel[r.type] || r.type}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {r.utilization !== null ? `${Math.round(r.utilization * (r.utilization <= 1 ? 100 : 1))}% used` : r.status}
                    {r.resetsAt ? ` · resets ${new Date(r.resetsAt).toLocaleString()}` : ''} · seen {timeAgo(r.observedAt)}
                  </Typography>
                </Box>
                <LinearProgress variant="determinate" value={r.utilization !== null ? Math.min(100, r.utilization * (r.utilization <= 1 ? 100 : 1)) : 0} color={r.status === 'rejected' ? 'error' : r.status === 'allowed_warning' ? 'warning' : 'primary'} sx={{ height: 8, borderRadius: 4 }} />
              </Box>
            ))}
          </Stack>
        </Box>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Factory sessions</TableCell>
              <TableCell align="right">Sessions</TableCell>
              <TableCell align="right">Cost (est.)</TableCell>
              <TableCell align="right">Input tokens</TableCell>
              <TableCell align="right">Output tokens</TableCell>
              <TableCell align="right">Cache read</TableCell>
              <TableCell>By kind</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {u.periods.map((p) => (
              <TableRow key={p.label}>
                <TableCell>{p.label}</TableCell>
                <TableCell align="right">{p.sessions}</TableCell>
                <TableCell align="right">${p.costUsd.toFixed(2)}</TableCell>
                <TableCell align="right">{fmt(p.inputTokens)}</TableCell>
                <TableCell align="right">{fmt(p.outputTokens)}</TableCell>
                <TableCell align="right">{fmt(p.cacheReadTokens)}</TableCell>
                <TableCell>
                  {Object.entries(p.byKind).map(([k, v]) => (
                    <Chip key={k} label={`${k} ${v.sessions} · $${v.costUsd.toFixed(2)}`} size="small" variant="outlined" sx={{ mr: 0.5, height: 20 }} />
                  ))}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr 1fr' }, gap: 2 }}>
          <Box>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>Fathom</Typography>
            <Typography variant="caption" color="text.secondary">
              {u.integrations.fathomIngested} meeting(s) ingested · {u.integrations.fathomIngestedLast7Days} in the last 7 days · last {u.integrations.lastFathomIngest ? timeAgo(u.integrations.lastFathomIngest) : 'never'}
            </Typography>
          </Box>
          <Box>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>Jira</Typography>
            <Typography variant="caption" color="text.secondary">
              {u.integrations.jiraSyncs} sync(s) · last {u.integrations.jiraLastSync ? timeAgo(u.integrations.jiraLastSync) : 'never'}
            </Typography>
          </Box>
          <Box>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>Connector calls (7 days)</Typography>
            <Typography variant="caption" color="text.secondary">
              {Object.keys(u.integrations.bridgeCallsLast7Days).length ? Object.entries(u.integrations.bridgeCallsLast7Days).map(([k, v]) => `${k}: ${v}`).join(' · ') : 'none yet'}
            </Typography>
          </Box>
        </Box>
        <Typography variant="caption" color="text.secondary">
          Workflow runs: {u.runs.total} total · {u.runs.succeeded} succeeded · {u.runs.failed} failed · {u.runs.last7Days} in the last 7 days · average ${u.runs.avgCostUsd.toFixed(2)} per run. Costs are the SDK's estimates, not billing.
        </Typography>
      </Stack>
    </Paper>
  );
}

function Status({ ok, label, detail }: { ok: boolean | null; label: string; detail?: string | null }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <Chip label={ok ? 'ok' : ok === null ? 'unknown' : 'missing'} color={ok ? 'success' : ok === null ? 'default' : 'warning'} />
      <Typography variant="body2">{label}</Typography>
      {detail && (
        <Typography variant="caption" color="text.secondary">
          {detail}
        </Typography>
      )}
    </Box>
  );
}

export function SettingsPage() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['integrations'], queryFn: () => api.get<IntegrationStatus>('/api/integrations/status') });
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.get<Project[]>('/api/projects') });
  const raw = useQuery({ queryKey: ['config-raw'], queryFn: () => api.get<{ path: string; content: string }>('/api/config/raw') });
  const [text, setText] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const check = useMutation({
    mutationFn: () => api.post<{ accountId: string; displayName: string; email: string | null; mode: string }>('/api/integrations/jira/check'),
    onSuccess: (r) => setCheckResult(`OK (${r.mode}) — authorized as ${r.displayName || r.email || r.accountId}`),
    onError: (e: Error) => setCheckResult(e.message),
  });
  useEffect(() => {
    if (raw.data) setText(raw.data.content);
  }, [raw.data]);
  const save = useMutation({
    mutationFn: () => api.put('/api/config/raw', { content: text }),
    onSuccess: () => {
      setSaved('Saved');
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['config-raw'] });
    },
    onError: (e: Error) => setSaved(e.message),
  });
  const s = status.data;
  return (
    <Stack spacing={2} sx={{ maxWidth: 1100 }}>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle2" gutterBottom>
          Integrations
        </Typography>
        {s ? (
          <Stack spacing={1}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              <Status ok={s.jira.configured} label="Jira" detail={s.jira.mode === 'mcp' ? `through your claude.ai Atlassian connector (MCP) · ${s.jira.baseUrl} · project ${s.jira.project}` : `REST API token · ${s.jira.email} @ ${s.jira.baseUrl}`} />
              <Button size="small" onClick={() => check.mutate()} disabled={check.isPending}>
                {check.isPending ? 'Checking…' : 'Test connection'}
              </Button>
              {checkResult && <Typography variant="caption" color={checkResult.startsWith('OK') ? 'success.main' : 'error.main'}>{checkResult}</Typography>}
            </Box>
            <Status ok={s.fathom.configured} label="Fathom" detail={s.fathom.mode === 'mcp' ? 'through your claude.ai Fathom connector (MCP)' : 'REST API key'} />
            <Status ok={s.ado.loggedIn} label="Azure DevOps" detail={s.ado.loggedIn ? `az CLI logged in · ${s.ado.orgUrl}` : 'run: az login --allow-no-subscriptions'} />
            <Status ok={s.llama.configured} label="Llama" detail={s.llama.configured ? `${s.llama.org}/${s.llama.project} · through the llama MCP server in ~/.claude.json` : 'no LLAMA_API_KEY found in ~/.claude.json or .env'} />
            <Status ok={!!s.claude.version} label="Claude Code" detail={s.claude.version || 'claude CLI not found on PATH'} />
            <Typography variant="caption" color="text.secondary">
              MCP mode reuses the connectors you already authorized in claude.ai; each sync is a short Haiku session (≈6 s, under a cent). To re-authorize or switch Jira to joao.mello@indysoft.com, reconnect the Atlassian connector in claude.ai settings. Optional REST tokens in .env switch an integration to direct API calls.
            </Typography>
          </Stack>
        ) : (
          <Typography color="text.secondary">Loading…</Typography>
        )}
      </Paper>
      <UsageSection />
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle2" gutterBottom>
          Projects
        </Typography>
        <Stack spacing={0.5}>
          {projects.data?.map((p) => (
            <Box key={p.id} sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <Chip label={p.exists ? 'found' : 'missing'} color={p.exists ? 'success' : 'error'} />
              <Typography variant="body2" sx={{ minWidth: 220 }}>
                {p.name}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {p.path} · base {p.baseBranches.join(' | ')} · {p.worktrees?.length ?? 0} worktree(s) · vault {p.vaultPath ? p.vaultPath.split('/').pop() : 'none'}
              </Typography>
            </Box>
          ))}
        </Stack>
      </Paper>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <Typography variant="subtitle2" sx={{ flex: 1 }}>
            config.yaml {raw.data ? `· ${raw.data.path}` : ''}
          </Typography>
          <Button variant="contained" onClick={() => save.mutate()} disabled={save.isPending || !text}>
            Save
          </Button>
        </Box>
        {saved && (
          <Alert severity={saved === 'Saved' ? 'success' : 'error'} onClose={() => setSaved(null)} sx={{ mb: 1 }}>
            {saved}
          </Alert>
        )}
        <CodeMirror value={text} height="420px" theme="dark" extensions={[yaml()]} onChange={setText} />
        <Typography variant="caption" color="text.secondary">
          Projects, base branches, design docs, vault mapping, ADO repo mapping and the Jira status → column mapping live here. Optional per project: worktreeRoot, branchTemplate, defectBranchTemplate.
        </Typography>
      </Paper>
    </Stack>
  );
}
