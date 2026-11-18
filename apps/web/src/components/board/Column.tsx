import type { ReactNode } from 'react';
import { Box, Paper, Typography } from '@mui/material';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { Card, ColumnId, Project } from '@sf/shared';
import { COLUMN_LABELS } from '@sf/shared';
import { CardItem } from './CardItem';

const accents: Record<ColumnId, string> = { backlog: '#565f89', in_progress: '#7aa2f7', human_review: '#e0af68', pull_request: '#bb9af7', done: '#9ece6a' };

export function Column({ id, cards, projects, onOpen, onOpenVsCode, onTakeOver, extra }: { id: ColumnId; cards: Card[]; projects: Map<string, Project>; onOpen: (c: Card) => void; onOpenVsCode: (c: Card) => void; onTakeOver?: (c: Card) => void; extra?: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id, data: { column: id } });
  return (
    <Paper ref={setNodeRef} variant="outlined" sx={{ flex: '1 1 260px', minWidth: 260, maxWidth: 420, display: 'flex', flexDirection: 'column', bgcolor: isOver ? 'action.hover' : 'background.paper', borderTop: 3, borderTopColor: accents[id] }}>
      <Box sx={{ p: 1.25, display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="subtitle2">{COLUMN_LABELS[id]}</Typography>
        <Typography variant="caption" color="text.secondary">
          {cards.length}
        </Typography>
        {id === 'in_progress' && (
          <Typography variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
            · drop to start the workflow
          </Typography>
        )}
        <Box sx={{ flex: 1 }} />
        {extra}
      </Box>
      <SortableContext id={id} items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <Box sx={{ flex: 1, overflowY: 'auto', p: 1, pt: 0, display: 'flex', flexDirection: 'column', gap: 1, minHeight: 120 }}>
          {cards.map((c) => (
            <CardItem key={c.id} card={c} project={c.projectId ? projects.get(c.projectId) : undefined} onOpen={onOpen} onOpenVsCode={onOpenVsCode} onTakeOver={onTakeOver} />
          ))}
        </Box>
      </SortableContext>
    </Paper>
  );
}
