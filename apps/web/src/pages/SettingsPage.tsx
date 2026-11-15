import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Box, Button, Chip, Paper, Stack, Typography } from '@mui/material';
import CodeMirror from '@uiw/react-codemirror';
import { yaml } from '@codemirror/lang-yaml';
import type { IntegrationStatus, Project } from '@sf/shared';
import { api } from '../api/client';

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
