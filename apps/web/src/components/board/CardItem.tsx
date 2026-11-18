import { Box, Chip, IconButton, Paper, Tooltip, Typography } from '@mui/material';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import CodeIcon from '@mui/icons-material/Code';
import ForumIcon from '@mui/icons-material/Forum';
import QuestionAnswerIcon from '@mui/icons-material/QuestionAnswer';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import AutorenewIcon from '@mui/icons-material/Autorenew';
import type { Card, Project } from '@sf/shared';

export const sourceColor: Record<Card['source'], 'primary' | 'secondary' | 'default'> = { jira: 'primary', llama: 'secondary', local: 'default' };

export function runStatusColor(status: Card['runStatus']): 'default' | 'info' | 'warning' | 'success' | 'error' {
  switch (status) {
    case 'running':
    case 'queued':
      return 'info';
    case 'waiting_human':
    case 'interrupted':
      return 'warning';
    case 'succeeded':
      return 'success';
    case 'failed':
      return 'error';
    default:
      return 'default';
  }
}

export function CardItem({ card, project, onOpen, onOpenVsCode, onTakeOver, dragging }: { card: Card; project?: Project; onOpen: (card: Card) => void; onOpenVsCode: (card: Card) => void; onTakeOver?: (card: Card) => void; dragging?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id, data: { column: card.column } });
  const style = { transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };
  const busy = card.runStatus === 'running' || card.runStatus === 'queued';
  return (
    <Paper
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      variant="outlined"
      onClick={() => onOpen(card)}
      sx={{
        p: 1.25,
        cursor: dragging ? 'grabbing' : 'grab',
        borderColor: card.pendingRequests ? 'warning.main' : busy ? 'info.main' : 'divider',
        borderWidth: card.pendingRequests || busy ? 2 : 1,
        '&:hover': { borderColor: 'primary.main' },
        position: 'relative',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
        {card.key ? <Chip label={card.key} color={sourceColor[card.source]} size="small" variant="outlined" sx={{ fontWeight: 600, height: 20 }} /> : <Chip label="local" size="small" variant="outlined" sx={{ height: 20 }} />}
        {card.issueType && (
          <Typography variant="caption" color="text.secondary" noWrap>
            {card.issueType}
          </Typography>
        )}
        <Box sx={{ flex: 1 }} />
        {card.pendingRequests > 0 && (
          <Tooltip title={`${card.pendingRequests} pending request(s) for you`}>
            <Chip icon={<QuestionAnswerIcon />} label={card.pendingRequests} color="warning" size="small" sx={{ height: 20 }} />
          </Tooltip>
        )}
        {busy && (
          <Tooltip title="Workflow running">
            <AutorenewIcon fontSize="small" color="info" sx={{ animation: 'spin 2s linear infinite', '@keyframes spin': { to: { transform: 'rotate(360deg)' } } }} />
          </Tooltip>
        )}
      </Box>
      <Typography variant="body2" sx={{ fontWeight: 500, lineHeight: 1.3, mb: 0.75 }}>
        {card.title}
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
        {project && <Chip label={project.name.replace('IndySoft.', '')} size="small" sx={{ height: 20 }} />}
        {card.baseBranch && <Chip label={card.baseBranch} size="small" variant="outlined" sx={{ height: 20 }} />}
        {card.runStatus && card.runStatus !== 'succeeded' && <Chip label={card.runStatus.replace('_', ' ')} size="small" color={runStatusColor(card.runStatus)} sx={{ height: 20 }} />}
        {card.externalStatus && card.column !== 'in_progress' && (
          <Typography variant="caption" color="text.secondary">
            {card.externalStatus}
          </Typography>
        )}
        <Box sx={{ flex: 1 }} />
        {card.prUrl && (
          <Tooltip title="Open pull request">
            <IconButton size="small" onClick={(e) => { e.stopPropagation(); window.open(card.prUrl!, '_blank'); }} onPointerDown={(e) => e.stopPropagation()}>
              <OpenInNewIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        )}
        {onTakeOver && card.projectId && (
          <Tooltip title="Take over in a chat: a new session in this ticket's worktree, briefed with the ticket, design docs and the last run">
            <IconButton size="small" onClick={(e) => { e.stopPropagation(); onTakeOver(card); }} onPointerDown={(e) => e.stopPropagation()}>
              <ForumIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title={card.worktreePath ? `Open worktree in VS Code (${card.branch})` : 'Open in VS Code — creates the ticket worktree first'}>
          <IconButton size="small" onClick={(e) => { e.stopPropagation(); onOpenVsCode(card); }} onPointerDown={(e) => e.stopPropagation()}>
            <CodeIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      </Box>
    </Paper>
  );
}
