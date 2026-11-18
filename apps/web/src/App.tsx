import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AppBar, Badge, Box, Chip, Snackbar, Alert, Tab, Tabs, Toolbar, Tooltip, Typography } from '@mui/material';
import ViewKanbanIcon from '@mui/icons-material/ViewKanban';
import PsychologyIcon from '@mui/icons-material/Psychology';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive';
import MonitorHeartIcon from '@mui/icons-material/MonitorHeart';
import SettingsIcon from '@mui/icons-material/Settings';
import TerminalIcon from '@mui/icons-material/Terminal';
import ScheduleIcon from '@mui/icons-material/Schedule';
import type { HumanRequest, ServerEvent } from '@sf/shared';
import { api } from './api/client';
import { useConnection, useServerEvents } from './api/ws';
import { BoardPage } from './pages/BoardPage';
import { SecondBrainPage } from './pages/SecondBrainPage';
import { WorkflowsPage } from './pages/WorkflowsPage';
import { RequestsPage } from './pages/RequestsPage';
import { SystemPage } from './pages/SystemPage';
import { SettingsPage } from './pages/SettingsPage';
import { SessionsPage } from './pages/SessionsPage';
import { LoggerPage } from './pages/LoggerPage';
import { formatBytes } from './components/common/format';

const TABS = ['board', 'brain', 'workflows', 'sessions', 'logger', 'requests', 'system', 'settings'] as const;
type TabId = (typeof TABS)[number];
const tabFromHash = (): TabId => {
  const h = location.hash.replace('#', '').split(/[/?]/)[0] as TabId;
  return TABS.includes(h) ? h : 'board';
};

export function App() {
  const [tab, setTab] = useState<TabId>(tabFromHash);
  const [toast, setToast] = useState<{ level: 'info' | 'success' | 'warning' | 'error'; message: string } | null>(null);
  const { connected, stats } = useConnection();
  const pending = useQuery({ queryKey: ['requests', 'pending'], queryFn: () => api.get<HumanRequest[]>('/api/requests?status=pending'), refetchInterval: 15_000 });

  useServerEvents((event: ServerEvent) => {
    if (event.type === 'toast') setToast({ level: event.level, message: event.message });
    if (event.type === 'request.created') setToast({ level: 'warning', message: `${event.request.cardKey || event.request.cardTitle}: ${event.request.kind === 'permission' ? 'permission needed' : 'question for you'}` });
  });

  useEffect(() => {
    if (tabFromHash() !== tab) location.hash = tab;
  }, [tab]);
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const pendingCount = pending.data?.length ?? 0;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <AppBar position="static" color="transparent" elevation={0} sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Toolbar variant="dense" sx={{ gap: 2 }}>
          <Typography variant="h6" sx={{ fontWeight: 700, letterSpacing: 0.2 }}>
            Software Factory
          </Typography>
          <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ flex: 1, minHeight: 48 }} textColor="inherit">
            <Tab value="board" icon={<ViewKanbanIcon fontSize="small" />} iconPosition="start" label="Board" />
            <Tab value="brain" icon={<PsychologyIcon fontSize="small" />} iconPosition="start" label="Second Brain" />
            <Tab value="workflows" icon={<AccountTreeIcon fontSize="small" />} iconPosition="start" label="Workflows" />
            <Tab value="sessions" icon={<TerminalIcon fontSize="small" />} iconPosition="start" label="Sessions" />
            <Tab value="logger" icon={<ScheduleIcon fontSize="small" />} iconPosition="start" label="Logger" />
            <Tab
              value="requests"
              icon={
                <Badge color="warning" badgeContent={pendingCount} max={99}>
                  <NotificationsActiveIcon fontSize="small" />
                </Badge>
              }
              iconPosition="start"
              label="Requests"
            />
            <Tab value="system" icon={<MonitorHeartIcon fontSize="small" />} iconPosition="start" label="System" />
            <Tab value="settings" icon={<SettingsIcon fontSize="small" />} iconPosition="start" label="Settings" />
          </Tabs>
          {stats && (
            <Box sx={{ display: 'flex', gap: 1 }}>
              <Tooltip title={`${stats.cpu.model} · ${stats.cpu.cores} cores · load ${stats.cpu.load1}`}>
                <Chip label={`CPU ${stats.cpu.loadPercent}%`} color={stats.cpu.loadPercent > 85 ? 'error' : stats.cpu.loadPercent > 60 ? 'warning' : 'default'} variant="outlined" />
              </Tooltip>
              <Tooltip title={`${formatBytes(stats.memory.usedBytes)} used of ${formatBytes(stats.memory.totalBytes)}`}>
                <Chip label={`RAM ${Math.round((stats.memory.usedBytes / stats.memory.totalBytes) * 100)}%`} variant="outlined" />
              </Tooltip>
              <Tooltip title="Claude Code processes running">
                <Chip label={`claude ×${stats.claudeProcesses}`} variant="outlined" color={stats.claudeProcesses ? 'info' : 'default'} />
              </Tooltip>
            </Box>
          )}
          <Tooltip title={connected ? 'Connected to the local server' : 'Server unreachable — start it with npm run dev'}>
            <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: connected ? 'success.main' : 'error.main' }} />
          </Tooltip>
        </Toolbar>
      </AppBar>
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', p: 2 }}>
        {tab === 'board' && <BoardPage />}
        {tab === 'brain' && <SecondBrainPage />}
        {tab === 'workflows' && <WorkflowsPage />}
        {tab === 'sessions' && <SessionsPage />}
        {tab === 'logger' && <LoggerPage />}
        {tab === 'requests' && <RequestsPage />}
        {tab === 'system' && <SystemPage />}
        {tab === 'settings' && <SettingsPage />}
      </Box>
      <Snackbar open={!!toast} autoHideDuration={6000} onClose={() => setToast(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}>
        <Alert severity={toast?.level ?? 'info'} variant="filled" onClose={() => setToast(null)}>
          {toast?.message}
        </Alert>
      </Snackbar>
    </Box>
  );
}
