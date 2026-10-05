// Reads the NAS's process table and kernel counters from a read-only bind
// mount of the host's /proc (`/proc:/host/proc:ro`). Without that mount the
// container only sees its own PID namespace.

import { readFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';

const CLK_TCK = 100;   // USER_HZ; 100 on every mainstream Linux build
const PAGE_SIZE = 4096;

export interface ProcSample {
  pid: number;
  ppid: number;
  comm: string;
  state: string;
  ticks: number;       // utime + stime
  threads: number;
  startTicks: number;
  rssBytes: number;
}

export interface CpuTimes {
  total: number;
  fields: Record<string, number>;
  cores: number;
}

const CPU_FIELDS = ['user', 'nice', 'system', 'idle', 'iowait', 'irq', 'softirq', 'steal'];

export class HostProc {
  constructor(readonly root: string) {}

  // Only a host-namespace /proc contains kthreadd (PID 2); a container's own
  // /proc never does, so this also catches a missing or wrong mount.
  static detect(root: string): HostProc | null {
    try {
      return readFileSync(`${root}/2/stat`, 'utf8').includes('(kthreadd)') ? new HostProc(root) : null;
    } catch {
      return null;
    }
  }

  private read(path: string): Promise<string> {
    return readFile(`${this.root}/${path}`, 'utf8');
  }

  async cpuTimes(): Promise<CpuTimes> {
    const stat = await this.read('stat');
    const lines = stat.split('\n');
    const values = lines[0].trim().split(/\s+/).slice(1, 9).map(Number);
    const fields = Object.fromEntries(CPU_FIELDS.map((f, i) => [f, values[i] ?? 0]));
    return {
      total: values.reduce((a, b) => a + b, 0),
      fields,
      cores: lines.filter((l) => /^cpu\d+ /.test(l)).length,
    };
  }

  async processes(): Promise<Map<number, ProcSample>> {
    const out = new Map<number, ProcSample>();
    const pids = (await readdir(this.root)).filter((d) => /^\d+$/.test(d));
    await Promise.all(pids.map(async (pid) => {
      try {
        const [stat, statm] = await Promise.all([this.read(`${pid}/stat`), this.read(`${pid}/statm`)]);
        // comm may contain spaces and parentheses; fields resume after the last ')'.
        const open = stat.indexOf('(');
        const close = stat.lastIndexOf(')');
        const f = stat.slice(close + 2).split(' ');
        out.set(Number(pid), {
          pid: Number(pid),
          comm: stat.slice(open + 1, close),
          state: f[0],
          ppid: Number(f[1]),
          ticks: Number(f[11]) + Number(f[12]),
          threads: Number(f[17]),
          startTicks: Number(f[19]),
          rssBytes: Number(statm.split(' ')[1]) * PAGE_SIZE,
        });
      } catch {
        // process exited between readdir and read
      }
    }));
    return out;
  }

  async cmdline(pid: number): Promise<string> {
    const raw = await this.read(`${pid}/cmdline`).catch(() => '');
    return raw.replace(/\0+$/, '').replace(/\0/g, ' ');
  }

  async uid(pid: number): Promise<number | null> {
    const status = await this.read(`${pid}/status`).catch(() => '');
    const m = /^Uid:\s+(\d+)/m.exec(status);
    return m ? Number(m[1]) : null;
  }

  // Docker container ID from the process's cgroup. Paths vary by cgroup driver
  // ("/system.slice/docker-<id>.scope" vs "/docker/<id>") and, because we run
  // in our own cgroup namespace, are shown relative to our cgroup: siblings
  // appear as "/../<id>" and our own processes as just "/" (returned as 'self').
  async containerId(pid: number): Promise<string | 'self' | null> {
    const cg = await this.read(`${pid}/cgroup`).catch(() => '');
    const v2 = cg.split('\n').find((l) => l.startsWith('0::'))?.slice(3).trim();
    const id = /([0-9a-f]{64})/.exec(cg)?.[1];
    if (id) return id;
    return v2 === '/' ? 'self' : null;
  }

  async uptimeSec(): Promise<number> {
    return Number((await this.read('uptime')).split(' ')[0]);
  }

  async loadavg(): Promise<number[]> {
    return (await this.read('loadavg')).split(' ').slice(0, 3).map(Number);
  }

  async meminfo(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const line of (await this.read('meminfo')).split('\n')) {
      const m = /^(\w+):\s+(\d+)(?: kB)?/.exec(line);
      if (m) out[m[1]] = Number(m[2]) * 1024;
    }
    return out;
  }

  // ZFS ARC counters; null when ZFS isn't loaded.
  async arcstats(): Promise<Record<string, number> | null> {
    const raw = await this.read('spl/kstat/zfs/arcstats').catch(() => null);
    if (!raw) return null;
    const out: Record<string, number> = {};
    for (const line of raw.split('\n').slice(2)) {
      const [name, , value] = line.trim().split(/\s+/);
      if (name && value) out[name] = Number(value);
    }
    return out;
  }

  // Pressure stall information: share of time tasks waited on a resource.
  async pressure(): Promise<Record<string, Record<string, number>> | null> {
    const out: Record<string, Record<string, number>> = {};
    for (const res of ['cpu', 'memory', 'io']) {
      const raw = await this.read(`pressure/${res}`).catch(() => null);
      if (!raw) continue;
      for (const line of raw.split('\n')) {
        const m = /^(some|full) avg10=([\d.]+) avg60=([\d.]+) avg300=([\d.]+)/.exec(line);
        if (m) out[`${res}_${m[1]}`] = { avg10: Number(m[2]), avg60: Number(m[3]), avg300: Number(m[4]) };
      }
    }
    return Object.keys(out).length ? out : null;
  }
}

export { CLK_TCK };
