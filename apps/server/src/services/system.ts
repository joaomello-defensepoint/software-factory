import os from 'node:os';
import si from 'systeminformation';
import type { SystemStats } from '@sf/shared';

let cached: SystemStats | null = null;
let lastProcessesAt = 0;
let lastProcesses: SystemStats['topProcesses'] = [];
let lastClaudeCount = 0;
let cpuModel = '';

export async function getSystemStats(): Promise<SystemStats> {
  const now = Date.now();
  const [load, mem, fs, net, battery, temp] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.fsSize().catch(() => []),
    si.networkStats().catch(() => []),
    si.battery().catch(() => null),
    si.cpuTemperature().catch(() => ({ main: null as number | null })),
  ]);
  if (!cpuModel) {
    const cpu = await si.cpu().catch(() => null);
    cpuModel = cpu ? `${cpu.manufacturer} ${cpu.brand}`.trim() : os.cpus()[0]?.model || 'unknown';
  }
  // Process listing is expensive; refresh every 5s.
  if (now - lastProcessesAt > 5000) {
    try {
      const procs = await si.processes();
      lastProcesses = procs.list
        .filter((p) => p.cpu > 0.5 || p.mem > 1)
        .sort((a, b) => b.cpu - a.cpu)
        .slice(0, 8)
        .map((p) => ({ pid: p.pid, name: p.name, cpuPercent: round(p.cpu), memPercent: round(p.mem) }));
      lastClaudeCount = procs.list.filter((p) => /claude/i.test(p.name) || /claude/i.test(p.command)).length;
    } catch {
      /* ignore */
    }
    lastProcessesAt = now;
  }
  const [l1, l5, l15] = os.loadavg();
  const rx = net.reduce((s, n) => s + (n.rx_sec || 0), 0);
  const tx = net.reduce((s, n) => s + (n.tx_sec || 0), 0);
  const mainDisks = fs
    .filter((d) => d.size > 10 * 1024 ** 3 && !/^\/System\/Volumes\/(VM|Preboot|Update|xarts|iSCPreboot|Hardware)/.test(d.mount))
    .filter((d, i, arr) => arr.findIndex((x) => x.mount === d.mount) === i)
    .map((d) => ({ fs: d.fs, mount: d.mount, type: d.type, sizeBytes: d.size, usedBytes: d.used, usePercent: round(d.use) }));

  cached = {
    ts: new Date(now).toISOString(),
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    uptimeSec: os.uptime(),
    cpu: {
      model: cpuModel,
      cores: os.cpus().length,
      loadPercent: round(load.currentLoad),
      perCorePercent: load.cpus.map((c) => round(c.load)),
      load1: round(l1),
      load5: round(l5),
      load15: round(l15),
      tempC: typeof temp?.main === 'number' && temp.main > 0 ? round(temp.main) : null,
    },
    memory: {
      totalBytes: mem.total,
      usedBytes: mem.active,
      freeBytes: mem.free,
      availableBytes: mem.available,
      swapUsedBytes: mem.swapused,
      swapTotalBytes: mem.swaptotal,
    },
    disks: mainDisks,
    network: { rxBytesPerSec: Math.round(rx), txBytesPerSec: Math.round(tx) },
    battery: battery ? { hasBattery: battery.hasBattery, percent: battery.hasBattery ? battery.percent : null, isCharging: battery.hasBattery ? battery.isCharging : null } : null,
    topProcesses: lastProcesses,
    claudeProcesses: lastClaudeCount,
  };
  return cached;
}

export const lastSystemStats = (): SystemStats | null => cached;

const round = (n: number): number => Math.round(n * 10) / 10;
