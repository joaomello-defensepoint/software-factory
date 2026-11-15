import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControl, InputLabel, MenuItem, Select, Stack, TextField, ToggleButton, ToggleButtonGroup } from '@mui/material';
import type { Project } from '@sf/shared';
import { api } from '../../api/client';

type Target = 'local' | 'jira' | 'llama';

export function NewTicketDialog({ open, projects, onClose }: { open: boolean; projects: Project[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [target, setTarget] = useState<Target>('jira');
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState('Story');
  const [priority, setPriority] = useState('');
  const [epic, setEpic] = useState('');
  const [projectId, setProjectId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: async () => {
      if (target === 'local') return api.post('/api/cards', { title: summary, description, projectId: projectId || null, issueType: type, priority: priority || null });
      if (target === 'jira') return api.post('/api/jira/issues', { summary, description, issueType: type, priority: priority || null, epicKey: epic || null, localProjectId: projectId || null, labels: ['software-factory'] });
      return api.post('/api/llama/issues', { summary, description, type: type.toUpperCase().replace(' ', '_'), priority: priority ? priority.toUpperCase() : null, epicKey: epic || null, localProjectId: projectId || null });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cards'] });
      setSummary('');
      setDescription('');
      setEpic('');
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  const types = target === 'llama' ? ['Story', 'Task', 'Bug', 'Technical Task', 'Epic'] : target === 'jira' ? ['Story', 'Task', 'Defect', 'Sub-task', 'Epic'] : ['Story', 'Task', 'Bug'];
  const priorities = target === 'llama' ? ['Critical', 'High', 'Medium', 'Low', 'Trivial'] : ['Highest', 'High', 'Medium', 'Low', 'Lowest'];

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>New ticket</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <ToggleButtonGroup exclusive value={target} onChange={(_e, v) => v && setTarget(v)} size="small">
            <ToggleButton value="jira">Jira (IWC)</ToggleButton>
            <ToggleButton value="llama">Llama (EAM)</ToggleButton>
            <ToggleButton value="local">Local only</ToggleButton>
          </ToggleButtonGroup>
          {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}
          <TextField label="Summary" value={summary} onChange={(e) => setSummary(e.target.value)} fullWidth autoFocus helperText={target === 'jira' ? 'Short, imperative, with an area prefix — e.g. "Kiosk Dashboard: filter locations by site"' : ''} />
          <TextField label="Description (markdown)" value={description} onChange={(e) => setDescription(e.target.value)} fullWidth multiline minRows={8} placeholder={'## Summary\nAs a user, I should be able to…\n\n## Proposed Changes\n- …\n\n## How to Test After\n- …'} />
          <Stack direction="row" spacing={2}>
            <FormControl size="small" sx={{ minWidth: 160 }}>
              <InputLabel>Type</InputLabel>
              <Select label="Type" value={types.includes(type) ? type : types[0]} onChange={(e) => setType(e.target.value)}>
                {types.map((t) => <MenuItem key={t} value={t}>{t}</MenuItem>)}
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 160 }}>
              <InputLabel>Priority</InputLabel>
              <Select label="Priority" value={priority} onChange={(e) => setPriority(e.target.value)}>
                <MenuItem value="">(default)</MenuItem>
                {priorities.map((p) => <MenuItem key={p} value={p}>{p}</MenuItem>)}
              </Select>
            </FormControl>
            {target !== 'local' && <TextField size="small" label="Epic key" value={epic} onChange={(e) => setEpic(e.target.value)} placeholder={target === 'jira' ? 'IWC-9457' : 'EAM-12'} />}
            <FormControl size="small" sx={{ minWidth: 220 }}>
              <InputLabel>Local project</InputLabel>
              <Select label="Local project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <MenuItem value="">(decide later)</MenuItem>
                {projects.map((p) => <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>)}
              </Select>
            </FormControl>
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={summary.trim().length < 3 || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? 'Creating…' : target === 'local' ? 'Create card' : `Create in ${target === 'jira' ? 'Jira' : 'Llama'}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
