// Resource diagnostics: per-container usage from the Docker stats API, and the
// host's process table (with container attribution) from a read-only /proc mount.

import { DockerClient } from '../docker-client.js';
import { HostProc, CLK_TCK, ProcSample } from '../host-proc.js';
import { ToolDef, ToolArgs, READ_ONLY, optStr, posInt } from './registry.js';
import { ownContainerId, primaryName, resolveContainer } from './containers.js';
import { formatBytes, formatDuration, mapLimit } from './utils.js';

type AnyObj = Record<string, unknown>;

const SAMPLE_MS = 1_500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round1 = (n: number) => Math.round(n * 10) / 10;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const rate = (bytesPerSec: number) => `${formatBytes(bytesPerSec)}/s`;

// Command lines are world-readable on Linux and sometimes carry credentials.
export function redactCommand(cmd: string): string {
  return cmd
    .replace(/(:\/\/[^:/\s@]+:)[^@\s]+@/g, '$1[redacted]@')
    .replace(/((?:^|\s)-{0,2}[\w.-]*(?:pass(?:word|wd)?|secret|token|api[-_]?key|auth)[\w.-]*[= ])(\S+)/gi, '$1[redacted]')
    .slice(0, 300);
}

// ── container_stats ────────────────────────────────────────────────────────────

function sumNet(s: AnyObj): { rx: number; tx: number } | null {
  const nets = s['networks'] as Record<string, AnyObj> | undefined;
  if (!nets) return null; // shares another container's network namespace
  return Object.values(nets).reduce<{ rx: number; tx: number }>((acc, n) => ({ rx: acc.rx + num(n['rx_bytes']), tx: acc.tx + num(n['tx_bytes']) }), { rx: 0, tx: 0 });
}

function sumBlk(s: AnyObj): { read: number; write: number } {
  const entries = ((s['blkio_stats'] as AnyObj | undefined)?.['io_service_bytes_recursive'] as AnyObj[] | null) ?? [];
  return entries.reduce<{ read: number; write: number }>((acc, e) => {
    const op = String(e['op']).toLowerCase();
    if (op === 'read') acc.read += num(e['value']);
    if (op === 'write') acc.write += num(e['value']);
    return acc;
  }, { read: 0, write: 0 });
}

function summarizeStats(name: string, a: AnyObj, b: AnyObj) {
  const cpu = (b['cpu_stats'] as AnyObj | undefined) ?? {};
  const pre = (b['precpu_stats'] as AnyObj | undefined) ?? {};
  const cpuDelta = num((cpu['cpu_usage'] as AnyObj | undefined)?.['total_usage']) - num((pre['cpu_usage'] as AnyObj | undefined)?.['total_usage']);
  const sysDelta = num(cpu['system_cpu_usage']) - num(pre['system_cpu_usage']);
  const cores = num(cpu['online_cpus']) || ((cpu['cpu_usage'] as AnyObj | undefined)?.['percpu_usage'] as unknown[] | undefined)?.length || 1;
  const cpuPercent = sysDelta > 0 && cpuDelta >= 0 ? (cpuDelta / sysDelta) * cores * 100 : 0;

  const mem = (b['memory_stats'] as AnyObj | undefined) ?? {};
  const ms = (mem['stats'] as AnyObj | undefined) ?? {};
  const usage = num(mem['usage']);
  const inactiveFile = num(ms['inactive_file'] ?? ms['total_inactive_file']);
  const workingSet = Math.max(0, usage - inactiveFile);
  const limit = num(mem['limit']);

  const dt = Math.max(0.001, (Date.parse(String(b['read'])) - Date.parse(String(a['read']))) / 1000);
  const netA = sumNet(a), netB = sumNet(b);
  const blkA = sumBlk(a), blkB = sumBlk(b);

  return {
    container: name,
    cpu_percent: round1(cpuPercent),
    memory: {
      working_set: formatBytes(workingSet),
      working_set_bytes: workingSet,
      page_cache: formatBytes(num(ms['file'] ?? ms['total_cache'] ?? ms['cache'])),
      anon: ms['anon'] != null ? formatBytes(num(ms['anon'])) : undefined,
      kernel: ms['kernel'] != null ? formatBytes(num(ms['kernel'])) : undefined,
      limit: formatBytes(limit),
      percent_of_limit: limit ? round1((workingSet / limit) * 100) : null,
    },
    pids: num((b['pids_stats'] as AnyObj | undefined)?.['current']),
    network: netA && netB ? {
      rx_rate: rate((netB.rx - netA.rx) / dt),
      tx_rate: rate((netB.tx - netA.tx) / dt),
      rx_total: formatBytes(netB.rx),
      tx_total: formatBytes(netB.tx),
    } : 'shares another container\'s network',
    block_io: {
      read_rate: rate((blkB.read - blkA.read) / dt),
      write_rate: rate((blkB.write - blkA.write) / dt),
      read_total: formatBytes(blkB.read),
      write_total: formatBytes(blkB.write),
    },
    _cores: cores,
  };
}

export async function containerStats(docker: DockerClient, nameOrId?: string): Promise<string> {
  let targets = await docker.containers(false) as AnyObj[];
  if (nameOrId) {
    const match = await resolveContainer(docker, nameOrId);
    if (!match) return JSON.stringify({ error: `Container '${nameOrId}' not found.` }, null, 2);
    if (match['State'] !== 'running') return JSON.stringify({ error: `Container '${nameOrId}' is not running.` }, null, 2);
    targets = [match];
  }

  const rows = await mapLimit(targets, 8, async (c) => {
    const name = primaryName(c['Names']);
    try {
      const [a, b] = await docker.statsSamples(String(c['Id']), 2);
      return summarizeStats(name, a, b ?? a);
    } catch (e) {
      return { container: name, error: e instanceof Error ? e.message : String(e) };
    }
  });

  const ok = rows.filter((r): r is ReturnType<typeof summarizeStats> => 'cpu_percent' in r);
  ok.sort((x, y) => y.cpu_percent - x.cpu_percent);
  const cores = ok[0]?._cores ?? null;

  return JSON.stringify({
    note: 'cpu_percent: 100 = one full core. working_set excludes reclaimable page cache. Rates are measured over ~1 s. '
      + 'Block writes to ZFS are flushed by kernel threads and are not attributed to containers (write counters stay near 0); see process_list for ZFS threads. '
      + 'Containers sharing a network namespace report the same network counters.',
    host_cores: cores,
    totals: {
      cpu_percent: round1(ok.reduce((a, r) => a + r.cpu_percent, 0)),
      working_set: formatBytes(ok.reduce((a, r) => a + r.memory.working_set_bytes, 0)),
    },
    containers: [
      ...ok.map(({ _cores, memory: { working_set_bytes, ...memory }, ...r }) => ({ ...r, memory })),
      ...rows.filter((r) => 'error' in r),
    ],
  }, null, 2);
}

// ── process_list ───────────────────────────────────────────────────────────────

const STATE_NAMES: Record<string, string> = {
  R: 'running', S: 'sleeping', D: 'uninterruptible (usually waiting on disk IO)', Z: 'zombie',
  T: 'stopped', t: 'traced', I: 'idle kernel thread', X: 'dead',
};

async function containerNames(docker: DockerClient | null): Promise<Map<string, string>> {
  if (!docker) return new Map();
  const list = await docker.containers(true).catch(() => [] as unknown[]) as AnyObj[];
  return new Map(list.map((c) => [String(c['Id']), primaryName(c['Names'])]));
}

async function hostProcessList(hp: HostProc, docker: DockerClient | null, sort: 'cpu' | 'memory', limit: number, container?: string): Promise<string> {
  const [cpu1, procs1] = await Promise.all([hp.cpuTimes(), hp.processes()]);
  await sleep(SAMPLE_MS);
  const [cpu2, procs2, names, uptime, load, mem, arc, psi] = await Promise.all([
    hp.cpuTimes(), hp.processes(), containerNames(docker), hp.uptimeSec(), hp.loadavg(), hp.meminfo(), hp.arcstats(), hp.pressure(),
  ]);

  const totalDelta = Math.max(1, cpu2.total - cpu1.total);
  const cores = cpu2.cores || 1;

  // Attribute every process to a container (or the host) for the per-container rollup.
  const owners = new Map<number, string>();
  await mapLimit([...procs2.keys()], 64, async (pid) => {
    const found = await hp.containerId(pid);
    const id = found === 'self' ? ownContainerId() : found;
    owners.set(pid, id ? names.get(id) ?? names.get([...names.keys()].find((k) => k.startsWith(id)) ?? '') ?? id.slice(0, 12)
      : found === 'self' ? 'truenas-mcp' : 'host');
  });

  const cpuOf = (p: ProcSample) => {
    const prev = procs1.get(p.pid);
    const delta = prev && prev.startTicks === p.startTicks ? p.ticks - prev.ticks : 0;
    return (delta / totalDelta) * cores * 100;
  };

  let all = [...procs2.values()].map((p) => ({ p, cpu: cpuOf(p), owner: owners.get(p.pid) ?? 'host' }));

  const byOwner = new Map<string, { cpu: number; rss: number; processes: number }>();
  for (const r of all) {
    const o = byOwner.get(r.owner) ?? { cpu: 0, rss: 0, processes: 0 };
    o.cpu += r.cpu; o.rss += r.p.rssBytes; o.processes += 1;
    byOwner.set(r.owner, o);
  }

  if (container) all = all.filter((r) => r.owner === container);
  all.sort((x, y) => (sort === 'memory' ? y.p.rssBytes - x.p.rssBytes : y.cpu - x.cpu || y.p.rssBytes - x.p.rssBytes));
  const top = all.slice(0, limit);

  const processes = await Promise.all(top.map(async ({ p, cpu, owner }) => {
    const [cmd, uid] = await Promise.all([hp.cmdline(p.pid), hp.uid(p.pid)]);
    return {
      pid: p.pid,
      ppid: p.ppid,
      container: owner,
      cpu_percent: round1(cpu),
      rss: formatBytes(p.rssBytes),
      threads: p.threads,
      state: STATE_NAMES[p.state] ?? p.state,
      uid,
      running_for: formatDuration(uptime - p.startTicks / CLK_TCK),
      command: cmd ? redactCommand(cmd) : `[${p.comm}]`,
    };
  }));

  const d = (k: string) => (cpu2.fields[k] ?? 0) - (cpu1.fields[k] ?? 0);
  const pct = (v: number) => round1((v / totalDelta) * 100);
  const states = [...procs2.values()].reduce<Record<string, number>>((acc, p) => ({ ...acc, [p.state]: (acc[p.state] ?? 0) + 1 }), {});
  const total = mem['MemTotal'] ?? 0;
  const available = mem['MemAvailable'] ?? 0;
  const arcSize = arc?.['size'] ?? 0;

  return JSON.stringify({
    note: 'cpu_percent: 100 = one full core, measured over ~1.5 s. RSS counts shared memory in every process that maps it, so sums overstate usage.',
    host: {
      cores,
      cpu_breakdown_percent: {
        user: pct(d('user') + d('nice')),
        system: pct(d('system')),
        iowait: pct(d('iowait')),
        irq: pct(d('irq') + d('softirq')),
        steal: pct(d('steal')),
        idle: pct(d('idle')),
      },
      load_avg: { '1min': load[0], '5min': load[1], '15min': load[2] },
      uptime: formatDuration(uptime),
      memory: {
        total: formatBytes(total),
        used: formatBytes(total - available),
        available: formatBytes(available),
        page_cache: formatBytes((mem['Cached'] ?? 0) + (mem['Buffers'] ?? 0)),
        shmem: formatBytes(mem['Shmem'] ?? 0),
        swap_used: formatBytes((mem['SwapTotal'] ?? 0) - (mem['SwapFree'] ?? 0)),
        ...(arc ? {
          zfs_arc: {
            size: formatBytes(arcSize),
            target: formatBytes(arc['c'] ?? 0),
            max: formatBytes(arc['c_max'] ?? 0),
            hit_ratio_percent: arc['hits'] != null ? round1((arc['hits'] / Math.max(1, arc['hits'] + (arc['misses'] ?? 0))) * 100) : null,
            note: 'ARC is ZFS read cache; it shrinks on memory pressure and is counted as "used" here.',
          },
          used_excluding_arc: formatBytes(Math.max(0, total - available - arcSize)),
        } : {}),
      },
      ...(psi ? { pressure_percent: psi } : {}),
      processes: {
        total: procs2.size,
        running: states['R'] ?? 0,
        uninterruptible: states['D'] ?? 0,
        zombie: states['Z'] ?? 0,
      },
    },
    cpu_by_container: [...byOwner.entries()]
      .map(([name, o]) => ({ container: name, cpu_percent: round1(o.cpu), rss: formatBytes(o.rss), processes: o.processes }))
      .sort((x, y) => y.cpu_percent - x.cpu_percent)
      .slice(0, 15),
    [`top_processes_by_${sort}`]: processes,
  }, null, 2);
}

// Fallback without the host /proc mount: Docker runs `ps` per container.
async function dockerProcessList(docker: DockerClient, sort: 'cpu' | 'memory', limit: number, container?: string): Promise<string> {
  let targets = await docker.containers(false) as AnyObj[];
  if (container) targets = targets.filter((c) => primaryName(c['Names']) === container);

  const perContainer = await mapLimit(targets, 6, async (c) => {
    const name = primaryName(c['Names']);
    try {
      const top = await docker.top(String(c['Id']));
      const col = (t: string) => top.Titles.indexOf(t);
      return top.Processes.map((row) => ({
        container: name,
        pid: Number(row[col('PID')]),
        ppid: Number(row[col('PPID')]),
        user: row[col('USER')],
        cpu_percent_lifetime_avg: Number(row[col('%CPU')]),
        mem_percent: Number(row[col('%MEM')]),
        rss_bytes: Number(row[col('RSS')]) * 1024,
        threads: Number(row[col('NLWP')]),
        running_for: row[col('ELAPSED')],
        state: row[col('STAT')],
        command: redactCommand(row[col('COMMAND')] ?? row[row.length - 1] ?? ''),
      }));
    } catch {
      return [];
    }
  });

  const rows = perContainer.flat();
  rows.sort((x, y) => (sort === 'memory'
    ? y.rss_bytes - x.rss_bytes
    : y.cpu_percent_lifetime_avg - x.cpu_percent_lifetime_avg || y.rss_bytes - x.rss_bytes));

  return JSON.stringify({
    note: 'Host /proc is not mounted, so only container processes are shown and %CPU is ps\'s average over each process\'s lifetime, not current usage. Mount /proc:/host/proc:ro for current CPU, host processes (ZFS, SMB, middleware) and memory/ARC details.',
    [`top_processes_by_${sort}`]: rows.slice(0, limit).map(({ rss_bytes, ...r }) => ({ ...r, rss: formatBytes(rss_bytes) })),
  }, null, 2);
}

export async function processList(hp: HostProc | null, docker: DockerClient | null, args: ToolArgs): Promise<string> {
  const sort = args['sort'] === 'memory' ? 'memory' : 'cpu';
  const limit = Math.min(posInt(args, 'limit', 25), 200);
  const container = optStr(args, 'container');
  if (hp) return hostProcessList(hp, docker, sort, limit, container);
  if (docker) return dockerProcessList(docker, sort, limit, container);
  throw new Error('Neither the host /proc mount nor the Docker socket is available.');
}

// ── registry ───────────────────────────────────────────────────────────────────

export function diagnosticsTools(docker: DockerClient | null, hp: HostProc | null): ToolDef[] {
  const defs: ToolDef[] = [];
  if (docker) {
    defs.push({
      tool: {
        name: 'container_stats',
        description: 'Live resource usage per running container, sorted by CPU: CPU % (100 = one core), memory working set vs. page cache vs. limit, PIDs, network and disk IO rates (sampled over ~1 s) and totals. Use to find which container is using CPU, memory or IO.',
        inputSchema: {
          type: 'object',
          properties: { name_or_id: { type: 'string', description: 'Optional: only this container' } },
        },
        annotations: READ_ONLY,
      },
      handler: (args) => containerStats(docker, optStr(args, 'name_or_id')),
    });
  }
  if (docker || hp) {
    defs.push({
      tool: {
        name: 'process_list',
        description: 'Top processes on the NAS by current CPU or memory, each attributed to its container or "host" (ZFS, SMB, middleware, kernel threads), plus CPU summed per container and a host summary: CPU breakdown (user/system/iowait/steal), load, memory incl. ZFS ARC, swap, pressure stall info and process states (uninterruptible = IO wait, zombies). Use together with container_stats to explain high CPU or memory usage.',
        inputSchema: {
          type: 'object',
          properties: {
            sort: { type: 'string', enum: ['cpu', 'memory'], description: 'Sort by current CPU (default) or resident memory', default: 'cpu' },
            limit: { type: 'number', description: 'Number of processes to return (default 25, max 200)', default: 25 },
            container: { type: 'string', description: 'Optional: only processes of this container (name), or "host" for non-container processes' },
          },
        },
        annotations: READ_ONLY,
      },
      handler: (args) => processList(hp, docker, args),
    });
  }
  return defs;
}
