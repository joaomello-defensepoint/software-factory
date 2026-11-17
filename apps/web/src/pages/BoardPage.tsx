import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Box, Button, Chip, Dialog, DialogContent, DialogTitle, List, ListItem, ListItemText, Stack, Tooltip, Typography } from '@mui/material';
import SyncIcon from '@mui/icons-material/Sync';
import AddIcon from '@mui/icons-material/Add';
import ArchiveIcon from '@mui/icons-material/Archive';
import { DndContext, DragOverlay, PointerSensor, closestCorners, useSensor, useSensors, type DragEndEvent, type DragOverEvent, type DragStartEvent } from '@dnd-kit/core';
import type { Card, ColumnId, Project, SyncState, WorkflowDefinition } from '@sf/shared';
import { COLUMNS } from '@sf/shared';
import { api } from '../api/client';
import { useServerEvents } from '../api/ws';
import { timeAgo } from '../components/common/format';
import { Column } from '../components/board/Column';
import { CardItem } from '../components/board/CardItem';
import { CardDialog } from '../components/board/CardDialog';
import { NewTicketDialog } from '../components/board/NewTicketDialog';

export function BoardPage() {
  const qc = useQueryClient();
  const cardsQuery = useQuery({ queryKey: ['cards'], queryFn: () => api.get<Card[]>('/api/cards'), refetchInterval: 30_000 });
  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: () => api.get<Project[]>('/api/projects') });
  const workflowsQuery = useQuery({ queryKey: ['workflows'], queryFn: () => api.get<WorkflowDefinition[]>('/api/workflows') });
  const [cards, setCards] = useState<Card[]>([]);
  const [active, setActive] = useState<Card | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (cardsQuery.data && !active) setCards(cardsQuery.data);
  }, [cardsQuery.data, active]);

  const projects = projectsQuery.data ?? [];
  const projectMap = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const selected = cards.find((c) => c.id === selectedId) ?? cardsQuery.data?.find((c) => c.id === selectedId) ?? null;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const move = useMutation({
    mutationFn: ({ id, column, index }: { id: string; column: ColumnId; index: number }) => api.post(`/api/cards/${id}/move`, { column, index }),
    onError: (e: Error) => {
      setMessage({ ok: false, text: e.message });
      qc.invalidateQueries({ queryKey: ['cards'] });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['cards'] }),
  });
  useServerEvents((e) => {
    if (e.type === 'sync.changed') qc.invalidateQueries({ queryKey: ['sync-state'] });
  });
  const syncQuery = useQuery({ queryKey: ['sync-state'], queryFn: () => api.get<{ jira: SyncState; llama: SyncState }>('/api/sync/state'), refetchInterval: 60_000 });
  const refreshSync = () => qc.invalidateQueries({ queryKey: ['sync-state'] });
  const syncJira = useMutation({ mutationFn: () => api.post<{ imported: number; updated: number; total: number }>('/api/jira/sync'), onSuccess: (r) => setMessage({ ok: true, text: `Jira: ${r.total} issues, ${r.imported} new, ${r.updated} updated` }), onError: (e: Error) => setMessage({ ok: false, text: e.message }), onSettled: refreshSync });
  const syncLlama = useMutation({ mutationFn: () => api.post<{ imported: number; updated: number; total: number }>('/api/llama/sync'), onSuccess: (r) => setMessage({ ok: true, text: `Llama: ${r.total} issues, ${r.imported} new, ${r.updated} updated` }), onError: (e: Error) => setMessage({ ok: false, text: e.message }), onSettled: refreshSync });
  const jiraSync = syncQuery.data?.jira;
  const llamaSync = syncQuery.data?.llama;
  const syncHint = (s: SyncState | undefined) => {
    if (!s) return '';
    const parts: string[] = [];
    if (s.lastSync) parts.push(`last sync ${timeAgo(s.lastSync)}`);
    if (s.lastResult) parts.push(`${s.lastResult.total} issues, ${s.lastResult.imported} new`);
    parts.push(s.intervalMinutes > 0 ? `auto every ${s.intervalMinutes} min` : 'auto sync off');
    if (s.lastError) parts.push(`last error: ${s.lastError}`);
    return parts.join(' · ');
  };
  const archive = useMutation({ mutationFn: () => api.post<{ archived: number }>('/api/cards/archive-done'), onSuccess: (r) => setMessage({ ok: true, text: `${r.archived} card(s) archived` }) });
  const openVsCode = useMutation({ mutationFn: (card: Card) => api.post<{ ok: boolean; message: string }>(`/api/cards/${card.id}/open`), onSuccess: (r) => setMessage({ ok: r.ok, text: r.message }), onError: (e: Error) => setMessage({ ok: false, text: e.message }) });
  const archived = useQuery({ queryKey: ['cards', 'archived'], queryFn: () => api.get<Card[]>('/api/cards?archived=1'), enabled: archivedOpen });
  const restore = useMutation({ mutationFn: (id: string) => api.post(`/api/cards/${id}/restore`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['cards'] }); } });

  const visible = projectFilter ? cards.filter((c) => c.projectId === projectFilter) : cards;
  const byColumn = (col: ColumnId) => visible.filter((c) => c.column === col).sort((a, b) => a.position - b.position);

  const findColumn = (id: string): ColumnId | null => {
    if ((COLUMNS as readonly string[]).includes(id)) return id as ColumnId;
    return cards.find((c) => c.id === id)?.column ?? null;
  };

  const onDragStart = (e: DragStartEvent) => setActive(cards.find((c) => c.id === e.active.id) ?? null);
  const onDragOver = (e: DragOverEvent) => {
    const { active: a, over } = e;
    if (!over) return;
    const from = findColumn(String(a.id));
    const to = findColumn(String(over.id));
    if (!from || !to || from === to) return;
    setCards((prev) => {
      const moving = prev.find((c) => c.id === a.id);
      if (!moving) return prev;
      const targetCards = prev.filter((c) => c.column === to && c.id !== a.id).sort((x, y) => x.position - y.position);
      const overIndex = targetCards.findIndex((c) => c.id === over.id);
      const insertAt = overIndex >= 0 ? overIndex : targetCards.length;
      const next = prev.map((c) => (c.id === a.id ? { ...c, column: to, position: insertAt + 0.5 } : c));
      return next;
    });
  };
  const onDragEnd = (e: DragEndEvent) => {
    const { active: a, over } = e;
    setActive(null);
    if (!over) return;
    const column = findColumn(String(over.id)) ?? findColumn(String(a.id));
    if (!column) return;
    const colCards = cards.filter((c) => c.column === column && c.id !== a.id).sort((x, y) => x.position - y.position);
    const overIndex = colCards.findIndex((c) => c.id === over.id);
    const moving = cards.find((c) => c.id === a.id);
    let index = overIndex >= 0 ? overIndex : colCards.length;
    if (moving && over.id !== a.id && overIndex >= 0 && moving.column === column && moving.position > colCards[overIndex].position) index = overIndex + 1;
    if (moving && over.id !== a.id && overIndex >= 0 && moving.column === column && moving.position < colCards[overIndex].position) index = overIndex;
    setCards((prev) => {
      const next = prev.map((c) => (c.id === a.id ? { ...c, column, position: index + 0.5 } : c));
      return next;
    });
    move.mutate({ id: String(a.id), column, index });
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 1.5 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setNewOpen(true)}>
          New ticket
        </Button>
        <Tooltip title={syncHint(jiraSync)}>
          <span>
            <Button variant="outlined" color={jiraSync?.lastError ? 'warning' : 'primary'} startIcon={<SyncIcon />} onClick={() => syncJira.mutate()} disabled={syncJira.isPending || !!jiraSync?.running}>
              {syncJira.isPending || jiraSync?.running ? 'Syncing Jira…' : 'Sync Jira'}
            </Button>
          </span>
        </Tooltip>
        <Tooltip title={syncHint(llamaSync)}>
          <span>
            <Button variant="outlined" color={llamaSync?.lastError ? 'warning' : 'primary'} startIcon={<SyncIcon />} onClick={() => syncLlama.mutate()} disabled={syncLlama.isPending || !!llamaSync?.running}>
              {syncLlama.isPending || llamaSync?.running ? 'Syncing Llama…' : 'Sync Llama'}
            </Button>
          </span>
        </Tooltip>
        {jiraSync?.lastSync && (
          <Typography variant="caption" color={jiraSync.lastError ? 'warning.main' : 'text.secondary'}>
            synced {timeAgo(jiraSync.lastSync)}{jiraSync.intervalMinutes > 0 ? ` · auto every ${jiraSync.intervalMinutes} min` : ''}
          </Typography>
        )}
        <Box sx={{ flex: 1 }} />
        <Chip label="All projects" variant={projectFilter ? 'outlined' : 'filled'} onClick={() => setProjectFilter(null)} />
        {projects.map((p) => (
          <Chip key={p.id} label={p.name.replace('IndySoft.', '')} variant={projectFilter === p.id ? 'filled' : 'outlined'} color={projectFilter === p.id ? 'primary' : 'default'} onClick={() => setProjectFilter(projectFilter === p.id ? null : p.id)} />
        ))}
        <Button onClick={() => setArchivedOpen(true)}>Archived</Button>
      </Stack>
      {message && (
        <Alert severity={message.ok ? 'success' : 'error'} onClose={() => setMessage(null)}>
          {message.text}
        </Alert>
      )}
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => setActive(null)}>
        <Box sx={{ display: 'flex', gap: 1.5, flex: 1, minHeight: 0, overflowX: 'auto', pb: 1 }}>
          {COLUMNS.map((col) => (
            <Column
              key={col}
              id={col}
              cards={byColumn(col)}
              projects={projectMap}
              onOpen={(c) => setSelectedId(c.id)}
              onOpenVsCode={(c) => openVsCode.mutate(c)}
              extra={
                col === 'done' ? (
                  <Tooltip title="Move everything in Done to the archive">
                    <Button size="small" startIcon={<ArchiveIcon />} onClick={() => archive.mutate()} disabled={archive.isPending}>
                      Archive
                    </Button>
                  </Tooltip>
                ) : undefined
              }
            />
          ))}
        </Box>
        <DragOverlay>{active ? <CardItem card={active} project={active.projectId ? projectMap.get(active.projectId) : undefined} onOpen={() => undefined} onOpenVsCode={() => undefined} dragging /> : null}</DragOverlay>
      </DndContext>
      <CardDialog card={selected} projects={projects} workflows={workflowsQuery.data ?? []} onClose={() => setSelectedId(null)} />
      <NewTicketDialog open={newOpen} projects={projects} onClose={() => setNewOpen(false)} />
      <Dialog open={archivedOpen} onClose={() => setArchivedOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Archived cards</DialogTitle>
        <DialogContent>
          {archived.data?.length === 0 && <Typography color="text.secondary">Nothing archived yet.</Typography>}
          <List dense>
            {archived.data?.map((c) => (
              <ListItem key={c.id} secondaryAction={<Button onClick={() => restore.mutate(c.id)}>Restore</Button>}>
                <ListItemText primary={`${c.key ? `${c.key} · ` : ''}${c.title}`} secondary={c.externalStatus || c.source} />
              </ListItem>
            ))}
          </List>
        </DialogContent>
      </Dialog>
    </Box>
  );
}
