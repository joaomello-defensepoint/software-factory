import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, List, ListItemButton, ListItemText, Paper, Stack, Tab, Tabs, TextField, Typography } from '@mui/material';
import CodeMirror from '@uiw/react-codemirror';
import { yaml } from '@codemirror/lang-yaml';
import { markdown } from '@codemirror/lang-markdown';
import type { WorkflowDefinition } from '@sf/shared';
import { api } from '../api/client';

interface WorkflowFile {
  path: string;
  content: string;
}

const ROLE_TEMPLATE = (name: string) => `---
name: ${name}
description: What this role is responsible for.
model: opus
tools: Read, Glob, Grep, Bash
---

You are the **${name}** of a software factory. Describe how this role thinks, what it must verify, and what its final message must contain.
`;

export function WorkflowsPage() {
  const qc = useQueryClient();
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: () => api.get<WorkflowDefinition[]>('/api/workflows') });
  const [selected, setSelected] = useState<string | null>(null);
  const current = useMemo(() => workflows.data?.find((w) => w.id === selected) ?? workflows.data?.[0] ?? null, [workflows.data, selected]);
  const files = useQuery({ queryKey: ['workflow-files', current?.id], queryFn: () => api.get<WorkflowFile[]>(`/api/workflows/${current!.id}/files`), enabled: !!current });
  const [file, setFile] = useState<string>('workflow.yaml');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [dup, setDup] = useState<{ id: string; name: string } | null>(null);
  const [newRole, setNewRole] = useState<string | null>(null);

  useEffect(() => {
    setDrafts({});
    setFile('workflow.yaml');
  }, [current?.id]);

  const content = (p: string) => drafts[p] ?? files.data?.find((f) => f.path === p)?.content ?? '';
  const dirty = (p: string) => drafts[p] !== undefined && drafts[p] !== files.data?.find((f) => f.path === p)?.content;

  const save = useMutation({
    mutationFn: (p: string) => api.put(`/api/workflows/${current!.id}/files`, { path: p, content: content(p) }),
    onSuccess: (_d, p) => {
      setMsg(`Saved ${p}`);
      setDrafts((d) => {
        const n = { ...d };
        delete n[p];
        return n;
      });
      qc.invalidateQueries({ queryKey: ['workflow-files', current?.id] });
      qc.invalidateQueries({ queryKey: ['workflows'] });
    },
    onError: (e: Error) => setMsg(e.message),
  });
  const duplicate = useMutation({
    mutationFn: () => api.post<WorkflowDefinition>(`/api/workflows/${current!.id}/duplicate`, { newId: dup!.id, newName: dup!.name }),
    onSuccess: (w) => {
      setDup(null);
      qc.invalidateQueries({ queryKey: ['workflows'] });
      setSelected(w.id);
    },
    onError: (e: Error) => setMsg(e.message),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/workflows/${current!.id}`),
    onSuccess: () => {
      setSelected(null);
      qc.invalidateQueries({ queryKey: ['workflows'] });
    },
  });
  const addRole = useMutation({
    mutationFn: (name: string) => api.put(`/api/workflows/${current!.id}/files`, { path: `roles/${name}.md`, content: ROLE_TEMPLATE(name) }),
    onSuccess: (_d, name) => {
      setNewRole(null);
      setFile(`roles/${name}.md`);
      qc.invalidateQueries({ queryKey: ['workflow-files', current?.id] });
      qc.invalidateQueries({ queryKey: ['workflows'] });
    },
  });
  const removeFile = useMutation({
    mutationFn: (p: string) => api.del(`/api/workflows/${current!.id}/files`, { path: p }),
    onSuccess: () => {
      setFile('workflow.yaml');
      qc.invalidateQueries({ queryKey: ['workflow-files', current?.id] });
      qc.invalidateQueries({ queryKey: ['workflows'] });
    },
  });

  return (
    <Box sx={{ display: 'flex', gap: 2, height: '100%', minHeight: 0 }}>
      <Paper variant="outlined" sx={{ width: 300, minWidth: 300, display: 'flex', flexDirection: 'column' }}>
        <Box sx={{ p: 1.5, borderBottom: 1, borderColor: 'divider' }}>
          <Typography variant="subtitle2">Workflows</Typography>
          <Typography variant="caption" color="text.secondary">
            ~/.claude/software-factory/workflows
          </Typography>
        </Box>
        <List dense sx={{ flex: 1, overflow: 'auto' }}>
          {workflows.data?.map((w) => (
            <ListItemButton key={w.id} selected={current?.id === w.id} onClick={() => setSelected(w.id)}>
              <ListItemText primary={w.name} secondary={`${w.steps.length} steps · ${w.roles.length} roles · max ${w.maxIterations} iterations`} />
            </ListItemButton>
          ))}
        </List>
        <Box sx={{ p: 1, display: 'flex', gap: 1, borderTop: 1, borderColor: 'divider' }}>
          <Button fullWidth variant="outlined" disabled={!current} onClick={() => setDup({ id: `${current!.id}-copy`, name: `${current!.name} (copy)` })}>
            Duplicate
          </Button>
          <Button fullWidth color="error" disabled={!current || current.id === 'maestro-loop'} onClick={() => remove.mutate()}>
            Delete
          </Button>
        </Box>
      </Paper>
      <Paper variant="outlined" sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {current ? (
          <>
            <Box sx={{ p: 1.5, borderBottom: 1, borderColor: 'divider' }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                {current.name}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {current.description}
              </Typography>
              <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap', gap: 0.5 }}>
                {current.steps.map((s, i) => (
                  <Chip key={s.id} label={`${i + 1}. ${s.name} (${s.kind}${s.roles.length ? `: ${s.roles.join(' + ')}` : ''})`} variant="outlined" />
                ))}
              </Stack>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', borderBottom: 1, borderColor: 'divider' }}>
              <Tabs value={files.data?.some((f) => f.path === file) ? file : 'workflow.yaml'} onChange={(_e, v) => setFile(v)} variant="scrollable" sx={{ flex: 1, minHeight: 40 }}>
                {files.data?.map((f) => (
                  <Tab key={f.path} value={f.path} label={`${f.path}${dirty(f.path) ? ' •' : ''}`} sx={{ minHeight: 40, textTransform: 'none' }} />
                ))}
              </Tabs>
              <Button onClick={() => setNewRole('new-role')}>+ Role</Button>
              {file.startsWith('roles/') && (
                <Button color="error" onClick={() => removeFile.mutate(file)}>
                  Remove file
                </Button>
              )}
              <Button variant="contained" disabled={!dirty(file) || save.isPending} onClick={() => save.mutate(file)} sx={{ mx: 1 }}>
                Save
              </Button>
            </Box>
            {msg && (
              <Alert severity={msg.startsWith('Saved') ? 'success' : 'error'} onClose={() => setMsg(null)}>
                {msg}
              </Alert>
            )}
            <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              <CodeMirror value={content(file)} height="100%" minHeight="500px" theme="dark" extensions={[file.endsWith('.md') ? markdown() : yaml()]} onChange={(v) => setDrafts((d) => ({ ...d, [file]: v }))} />
            </Box>
          </>
        ) : (
          <Typography sx={{ p: 2 }} color="text.secondary">
            No workflow selected.
          </Typography>
        )}
      </Paper>
      <Dialog open={!!dup} onClose={() => setDup(null)}>
        <DialogTitle>Duplicate workflow</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '12px !important', minWidth: 400 }}>
          <TextField label="New id (kebab-case)" value={dup?.id ?? ''} onChange={(e) => setDup((d) => ({ ...d!, id: e.target.value }))} />
          <TextField label="Name" value={dup?.name ?? ''} onChange={(e) => setDup((d) => ({ ...d!, name: e.target.value }))} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDup(null)}>Cancel</Button>
          <Button variant="contained" onClick={() => duplicate.mutate()}>
            Create
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={newRole !== null} onClose={() => setNewRole(null)}>
        <DialogTitle>New role</DialogTitle>
        <DialogContent sx={{ pt: '12px !important', minWidth: 400 }}>
          <TextField fullWidth label="Role id (kebab-case)" value={newRole ?? ''} onChange={(e) => setNewRole(e.target.value)} helperText="Creates roles/<id>.md; reference it from workflow.yaml steps" />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNewRole(null)}>Cancel</Button>
          <Button variant="contained" disabled={!newRole || !/^[a-z0-9-]+$/.test(newRole)} onClick={() => addRole.mutate(newRole!)}>
            Create
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
