import { Box, LinearProgress, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import type { SystemStats } from '@sf/shared';
import { api } from '../api/client';
import { useConnection } from '../api/ws';
import { formatBytes, formatDuration } from '../components/common/format';

function Meter({ label, value, detail, color }: { label: string; value: number; detail?: string; color?: 'primary' | 'warning' | 'error' | 'success' | 'info' }) {
  const c = color ?? (value > 85 ? 'error' : value > 65 ? 'warning' : 'primary');
  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
        <Typography variant="body2">{label}</Typography>
        <Typography variant="body2" color="text.secondary">
          {detail ?? `${Math.round(value)}%`}
        </Typography>
      </Box>
      <LinearProgress variant="determinate" value={Math.min(100, Math.max(0, value))} color={c} sx={{ height: 8, borderRadius: 4 }} />
    </Box>
  );
}

export function SystemPage() {
  const live = useConnection().stats;
  const polled = useQuery({ queryKey: ['system'], queryFn: () => api.get<SystemStats>('/api/system/stats'), refetchInterval: live ? false : 3000 });
  const s = live ?? polled.data;
  if (!s) return <Typography color="text.secondary">Waiting for system stats…</Typography>;
  const memPct = (s.memory.usedBytes / s.memory.totalBytes) * 100;
  return (
    <Stack spacing={2} sx={{ maxWidth: 1100 }}>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle2" gutterBottom>
            CPU · {s.cpu.model} · {s.cpu.cores} cores{s.cpu.tempC ? ` · ${s.cpu.tempC}°C` : ''}
          </Typography>
          <Stack spacing={1.5}>
            <Meter label="Total load" value={s.cpu.loadPercent} />
            <Box sx={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(8, s.cpu.perCorePercent.length)}, 1fr)`, gap: 1 }}>
              {s.cpu.perCorePercent.map((p, i) => (
                <Box key={i} sx={{ textAlign: 'center' }}>
                  <Box sx={{ height: 48, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
                    <Box sx={{ width: 14, height: `${Math.max(4, p)}%`, bgcolor: p > 85 ? 'error.main' : p > 60 ? 'warning.main' : 'primary.main', borderRadius: 1 }} />
                  </Box>
                  <Typography variant="caption" color="text.secondary">
                    {Math.round(p)}
                  </Typography>
                </Box>
              ))}
            </Box>
            <Typography variant="caption" color="text.secondary">
              load avg {s.cpu.load1} / {s.cpu.load5} / {s.cpu.load15} · uptime {formatDuration(s.uptimeSec)} · {s.platform}
            </Typography>
          </Stack>
        </Paper>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle2" gutterBottom>
            Memory
          </Typography>
          <Stack spacing={1.5}>
            <Meter label="Used" value={memPct} detail={`${formatBytes(s.memory.usedBytes)} / ${formatBytes(s.memory.totalBytes)}`} />
            <Meter label="Available" value={(s.memory.availableBytes / s.memory.totalBytes) * 100} detail={formatBytes(s.memory.availableBytes)} color="success" />
            <Meter label="Swap" value={s.memory.swapTotalBytes ? (s.memory.swapUsedBytes / s.memory.swapTotalBytes) * 100 : 0} detail={`${formatBytes(s.memory.swapUsedBytes)} / ${formatBytes(s.memory.swapTotalBytes)}`} color="info" />
            <Typography variant="caption" color="text.secondary">
              network ↓ {formatBytes(s.network.rxBytesPerSec)}/s ↑ {formatBytes(s.network.txBytesPerSec)}/s
              {s.battery?.hasBattery ? ` · battery ${s.battery.percent}%${s.battery.isCharging ? ' (charging)' : ''}` : ''}
            </Typography>
          </Stack>
        </Paper>
      </Box>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle2" gutterBottom>
          Disks
        </Typography>
        <Stack spacing={1.5}>
          {s.disks.map((d) => (
            <Meter key={d.mount} label={`${d.mount} (${d.type})`} value={d.usePercent} detail={`${formatBytes(d.usedBytes)} / ${formatBytes(d.sizeBytes)} · ${d.usePercent}%`} />
          ))}
        </Stack>
      </Paper>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle2" gutterBottom>
          Top processes · {s.claudeProcesses} Claude process{s.claudeProcesses === 1 ? '' : 'es'}
        </Typography>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>PID</TableCell>
              <TableCell>Name</TableCell>
              <TableCell align="right">CPU %</TableCell>
              <TableCell align="right">Mem %</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {s.topProcesses.map((p) => (
              <TableRow key={p.pid}>
                <TableCell>{p.pid}</TableCell>
                <TableCell>{p.name}</TableCell>
                <TableCell align="right">{p.cpuPercent}</TableCell>
                <TableCell align="right">{p.memPercent}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>
    </Stack>
  );
}
