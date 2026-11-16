import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControl, InputLabel, List, ListItemButton, ListItemText, MenuItem, Paper, Select, Stack, TextField, Tooltip, Typography } from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import StopIcon from '@mui/icons-material/Stop';
import AddIcon from '@mui/icons-material/Add';
import ReactMarkdown from 'react-markdown';
import type { ExternalSession, Project, SessionMessageLine, SessionSummary } from '@sf/shared';
import { api } from '../api/client';
import { useServerEvents } from '../api/ws';
import { mono } from '../theme';
import { timeAgo } from '../components/common/format';

type SessionRow = SessionSummary & { live?: boolean };

const statusColor: Record<SessionSummary['status'], 'default' | 'info' | 'warning' | 'success' | 'error'> = {
  starting: 'info',
  running: 'info',
  waiting_human: 'warning',
  done: 'success',
  failed: 'error',
  cancelled: 'default',
  interrupted: 'warning',
};

function parseHash(): { sessionId: string | null; cardId: string | null; runId: string | null } {
  const h = location.hash.replace('#', '');
  const [base, rest] = h.split(/[/?]/, 2);
  if (base !== 'sessions') return { sessionId: null, cardId: null, runId: null };
  const params = new URLSearchParams(h.includes('?') ? h.slice(h.indexOf('?') + 1) : '');
  return { sessionId: h.includes('/') ? rest || null : null, cardId: params.get('card'), runId: params.get('run') };
}

function Transcript({ messages, pending }: { messages: SessionMessageLine[]; pending?: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);
  return (
    <Box sx={{ flex: 1, overflow: 'auto', p: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
      {messages.map((m) => {
        if (m.type === 'tool_use' || m.type === 'tool_result' || m.type === 'system') {
          return (
            <Box key={m.id} sx={{ fontFamily: mono, fontSize: 11.5, color: m.type === 'system' ? 'warning.main' : 'text.secondary', whiteSpace: 'pre-wrap', wordBreak: 'break-word', pl: 1, borderLeft: '2px solid', borderColor: m.type === 'tool_use' ? 'primary.main' : 'divider', maxHeight: 160, overflow: 'auto' }}>
              {m.type === 'tool_use' ? '→ ' : m.type === 'tool_result' ? '← ' : '· '}
              {m.text}
            </Box>
          );
        }
        const mine = m.type === 'user';
        return (
          <Box key={m.id} sx={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '85%', bgcolor: mine ? 'primary.dark' : 'background.default', color: mine ? 'primary.contrastText' : 'text.primary', borderRadius: 2, px: 1.5, py: 0.75, fontSize: 13, '& p': { my: 0.5 }, '& pre': { whiteSpace: 'pre-wrap', fontSize: 12 } }}>
            {m.type === 'question' && <Chip label="question for you → Requests tab" color="warning" size="small" sx={{ mb: 0.5 }} />}
            <ReactMarkdown>{m.text}</ReactMarkdown>
          </Box>
        );
      })}
      {pending && (
        <Typography variant="caption" color="text.secondary">
          working…
        </Typography>
      )}
      <div ref={endRef} />
    </Box>
  );
}

export function SessionsPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<'all' | 'live' | 'chat' | 'workflow' | 'brain' | 'history'>('all');
  const [selected, setSelected] = useState<string | null>(() => parseHash().sessionId);
  const [cardFilter, setCardFilter] = useState<string | null>(() => parseHash().cardId);
  const [externalSel, setExternalSel] = useState<ExternalSession | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onHash = () => {
      const p = parseHash();
      if (p.sessionId) setSelected(p.sessionId);
      setCardFilter(p.cardId);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const sessions = useQuery({ queryKey: ['sessions', cardFilter], queryFn: () => api.get<SessionRow[]>(`/api/sessions${cardFilter ? `?cardId=${cardFilter}` : ''}`), refetchInterval: 15_000 });
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.get<Project[]>('/api/projects') });
  const external = useQuery({ queryKey: ['sessions', 'external'], queryFn: () => api.get<ExternalSession[]>('/api/sessions/external?limit=60'), enabled: filter === 'history' });
  const detail = useQuery({ queryKey: ['session', selected], queryFn: () => api.get<{ session: SessionRow; messages: SessionMessageLine[] }>(`/api/sessions/${selected}`), enabled: !!selected && filter !== 'history' });
  const externalMsgs = useQuery({ queryKey: ['session-external', externalSel?.sessionId], queryFn: () => api.get<SessionMessageLine[]>(`/api/sessions/external/${externalSel!.sessionId}/messages${externalSel?.cwd ? `?dir=${encodeURIComponent(externalSel.cwd)}` : ''}`), enabled: !!externalSel });
  const [liveMessages, setLiveMessages] = useState<SessionMessageLine[]>([]);
  useEffect(() => {
    setLiveMessages(detail.data?.messages ?? []);
  }, [detail.data]);

  useServerEvents((e) => {
    if (e.type === 'session.changed') qc.invalidateQueries({ queryKey: ['sessions'] });
    if (e.type === 'session.message' && e.message.sessionId === selected) setLiveMessages((prev) => (prev.some((x) => x.id === e.message.id) ? prev : [...prev, e.message]));
    if (e.type === 'session.changed' && e.session.id === selected) qc.invalidateQueries({ queryKey: ['session', selected] });
  });

  const send = useMutation({
    mutationFn: () => api.post(`/api/sessions/${selected}/send`, { text: draft }),
    onSuccess: () => setDraft(''),
    onError: (e: Error) => setError(e.message),
  });
  const end = useMutation({ mutationFn: () => api.post(`/api/sessions/${selected}/end`), onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }) });
  const resumeOwn = useMutation({
    mutationFn: () => api.post<SessionSummary>(`/api/sessions/${selected}/resume`),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ['sessions'] });
      setSelected(s.id);
      location.hash = `sessions/${s.id}`;
    },
    onError: (e: Error) => setError(e.message),
  });
  const resume = useMutation({
    mutationFn: (s: ExternalSession) => api.post<SessionSummary>('/api/sessions/chat', { prompt: 'Continue where we left off. Summarize the current state in two lines, then wait for my instructions.', title: `Resumed: ${s.summary.slice(0, 50)}`, cwd: s.cwd, resume: s.sessionId }),
    onSuccess: (s) => {
      setFilter('all');
      setSelected(s.id);
      location.hash = `sessions/${s.id}`;
    },
    onError: (e: Error) => setError(e.message),
  });

  const list = useMemo(() => {
    const rows = sessions.data ?? [];
    if (filter === 'live') return rows.filter((s) => ['starting', 'running', 'waiting_human'].includes(s.status));
    if (filter === 'chat' || filter === 'workflow' || filter === 'brain') return rows.filter((s) => s.kind === filter);
    return rows;
  }, [sessions.data, filter]);
  const current = detail.data?.session ?? sessions.data?.find((s) => s.id === selected) ?? null;
  const currentLive = !!current && (current.live || ['starting', 'running', 'waiting_human'].includes(current.status));

  return (
    <Box sx={{ display: 'flex', gap: 2, height: '100%', minHeight: 0 }}>
      <Paper variant="outlined" sx={{ width: 380, minWidth: 320, display: 'flex', flexDirection: 'column' }}>
        <Box sx={{ p: 1.5, borderBottom: 1, borderColor: 'divider', display: 'flex', flexWrap: 'wrap', gap: 0.5, alignItems: 'center' }}>
          {(['all', 'live', 'chat', 'workflow', 'brain', 'history'] as const).map((f) => (
            <Chip key={f} label={f === 'history' ? 'Claude Code history' : f} size="small" variant={filter === f ? 'filled' : 'outlined'} color={filter === f ? 'primary' : 'default'} onClick={() => setFilter(f)} />
          ))}
          {cardFilter && <Chip label="card filter" size="small" onDelete={() => { setCardFilter(null); location.hash = 'sessions'; }} />}
          <Box sx={{ flex: 1 }} />
          <Button size="small" variant="contained" startIcon={<AddIcon />} onClick={() => setNewOpen(true)}>
            New session
          </Button>
        </Box>
        <List dense sx={{ flex: 1, overflow: 'auto' }}>
          {filter !== 'history' &&
            list.map((s) => (
              <ListItemButton key={s.id} selected={selected === s.id} onClick={() => { setSelected(s.id); setExternalSel(null); location.hash = `sessions/${s.id}`; }} sx={{ alignItems: 'flex-start' }}>
                <ListItemText
                  primary={
                    <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
                      <Chip label={s.status.replace('_', ' ')} size="small" color={statusColor[s.status]} sx={{ height: 18 }} />
                      <Chip label={s.kind} size="small" variant="outlined" sx={{ height: 18 }} />
                      <Typography variant="body2" noWrap sx={{ flex: 1 }}>
                        {s.title}
                      </Typography>
                    </Box>
                  }
                  secondary={`${s.model || ''} · ${timeAgo(s.startedAt)} · $${s.costUsd.toFixed(2)}${s.lastText ? ` · ${s.lastText.slice(0, 70)}` : ''}`}
                />
              </ListItemButton>
            ))}
          {filter !== 'history' && list.length === 0 && (
            <Typography color="text.secondary" sx={{ p: 2 }} variant="body2">
              No sessions yet. Workflow roles, brain jobs and chats show up here as they run.
            </Typography>
          )}
          {filter === 'history' &&
            external.data?.map((s) => (
              <ListItemButton key={s.sessionId} selected={externalSel?.sessionId === s.sessionId} onClick={() => setExternalSel(s)} sx={{ alignItems: 'flex-start' }}>
                <ListItemText primary={s.summary} secondary={`${s.cwd?.split('/').slice(-2).join('/') ?? ''}${s.gitBranch ? ` · ${s.gitBranch}` : ''} · ${timeAgo(s.lastModified)}`} />
              </ListItemButton>
            ))}
          {filter === 'history' && external.isLoading && <Typography color="text.secondary" sx={{ p: 2 }} variant="body2">Reading ~/.claude/projects…</Typography>}
        </List>
      </Paper>
      <Paper variant="outlined" sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}
        {filter === 'history' && externalSel ? (
          <>
            <Box sx={{ p: 1.5, borderBottom: 1, borderColor: 'divider', display: 'flex', gap: 1, alignItems: 'center' }}>
              <Typography variant="subtitle2" sx={{ flex: 1 }} noWrap>
                {externalSel.summary}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {externalSel.cwd}
              </Typography>
              <Button variant="outlined" size="small" onClick={() => resume.mutate(externalSel)} disabled={resume.isPending}>
                Resume as a new chat
              </Button>
            </Box>
            <Transcript messages={externalMsgs.data ?? []} />
          </>
        ) : current ? (
          <>
            <Box sx={{ p: 1.5, borderBottom: 1, borderColor: 'divider', display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
              <Chip label={current.status.replace('_', ' ')} color={statusColor[current.status]} />
              <Typography variant="subtitle2" sx={{ flex: 1 }} noWrap>
                {current.title}
              </Typography>
              <Tooltip title={current.cwd}>
                <Typography variant="caption" color="text.secondary" noWrap sx={{ maxWidth: 280 }}>
                  {current.cwd.split('/').slice(-3).join('/')}
                </Typography>
              </Tooltip>
              <Typography variant="caption" color="text.secondary">
                {current.model} · {current.turns} turns · ${current.costUsd.toFixed(3)} · {current.inputTokens + current.outputTokens} tokens
              </Typography>
              {current.cardId && (
                <Button size="small" onClick={() => { location.hash = 'board'; }}>
                  Board
                </Button>
              )}
              {currentLive && current.interactive && (
                <Button size="small" color="error" startIcon={<StopIcon />} onClick={() => end.mutate()}>
                  End
                </Button>
              )}
              {!currentLive && current.claudeSessionId && (
                <Tooltip title="Continue this Claude session as a chat (same context, same folder)">
                  <Button size="small" variant="outlined" color={current.status === 'interrupted' ? 'warning' : 'inherit'} onClick={() => resumeOwn.mutate()} disabled={resumeOwn.isPending}>
                    Resume
                  </Button>
                </Tooltip>
              )}
            </Box>
            {current.status === 'waiting_human' && (
              <Alert severity="warning" action={<Button color="inherit" size="small" onClick={() => { location.hash = 'requests'; }}>Open Requests</Button>}>
                This session is waiting for your answer in the Requests tab.
              </Alert>
            )}
            <Transcript messages={liveMessages} pending={currentLive && current.status === 'running'} />
            {current.interactive && currentLive && (
              <Box sx={{ p: 1.5, borderTop: 1, borderColor: 'divider', display: 'flex', gap: 1 }}>
                <TextField
                  fullWidth
                  multiline
                  minRows={1}
                  maxRows={6}
                  placeholder="Message (⌘/Ctrl+Enter to send)"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && draft.trim()) send.mutate();
                  }}
                />
                <Button variant="contained" endIcon={<SendIcon />} disabled={!draft.trim() || send.isPending} onClick={() => send.mutate()}>
                  Send
                </Button>
              </Box>
            )}
          </>
        ) : (
          <Typography color="text.secondary" sx={{ p: 3 }}>
            Pick a session on the left, or start a new one. Workflow roles link back to their card; "Claude Code history" lists the sessions on this machine and can resume any of them as a chat.
          </Typography>
        )}
      </Paper>
      <NewSessionDialog open={newOpen} projects={projects.data ?? []} onClose={() => setNewOpen(false)} onStarted={(s) => { setFilter('all'); setSelected(s.id); location.hash = `sessions/${s.id}`; }} onError={setError} />
    </Box>
  );
}

function NewSessionDialog({ open, projects, onClose, onStarted, onError }: { open: boolean; projects: Project[]; onClose: () => void; onStarted: (s: SessionSummary) => void; onError: (m: string) => void }) {
  const [projectId, setProjectId] = useState('');
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState('opus');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const project = projects.find((p) => p.id === projectId);
  const worktrees = project?.worktrees?.filter((w) => !w.isMain) ?? [];
  const start = useMutation({
    mutationFn: () => api.post<SessionSummary>('/api/sessions/chat', { prompt, title: title || undefined, model, projectId: projectId || null, cwd: cwd || null }),
    onSuccess: (s) => {
      onStarted(s);
      onClose();
      setPrompt('');
      setTitle('');
    },
    onError: (e: Error) => onError(e.message),
  });
  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>New session</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Stack direction="row" spacing={2}>
            <FormControl size="small" sx={{ minWidth: 240 }}>
              <InputLabel>Project</InputLabel>
              <Select label="Project" value={projectId} onChange={(e) => { setProjectId(e.target.value); setCwd(''); }}>
                <MenuItem value="">(custom folder)</MenuItem>
                {projects.map((p) => <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>)}
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 260 }} disabled={!project}>
              <InputLabel>Folder</InputLabel>
              <Select label="Folder" value={cwd} onChange={(e) => setCwd(e.target.value)}>
                <MenuItem value="">main checkout</MenuItem>
                {worktrees.map((w) => <MenuItem key={w.path} value={w.path}>{w.path.split('/').pop()} ({w.branch})</MenuItem>)}
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 140 }}>
              <InputLabel>Model</InputLabel>
              <Select label="Model" value={model} onChange={(e) => setModel(e.target.value)}>
                {['opus', 'sonnet', 'haiku'].map((m) => <MenuItem key={m} value={m}>{m}</MenuItem>)}
              </Select>
            </FormControl>
          </Stack>
          {!projectId && <TextField size="small" label="Folder path" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/Users/Developer/Desktop/indysoft/…" fullWidth />}
          <TextField size="small" label="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} fullWidth />
          <TextField label="First message" value={prompt} onChange={(e) => setPrompt(e.target.value)} fullWidth multiline minRows={4} autoFocus placeholder="What should this session do? It runs as a normal Claude Code session in that folder, with your skills and MCP servers." />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!prompt.trim() || (!projectId && !cwd) || start.isPending} onClick={() => start.mutate()}>
          {start.isPending ? 'Starting…' : 'Start'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
