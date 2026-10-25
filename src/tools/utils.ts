import { TrueNASClient } from '../truenas-client.js';

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || isNaN(bytes)) return 'N/A';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let v = bytes; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(2)} ${units[i]}`;
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// Command lines are world-readable on Linux and sometimes carry credentials.
export function redactCommand(cmd: string): string {
  return cmd
    .replace(/(:\/\/[^:/\s@]+:)[^@\s]+@/g, '$1[redacted]@')
    .replace(/((?:^|\s)-{0,2}[\w.-]*(?:pass(?:word|wd)?|secret|token|api[-_]?key|auth)[\w.-]*[= ])(\S+)/gi, '$1[redacted]')
    .slice(0, 300);
}

// Escapes a literal for use in a TrueNAS `~` (Python re) query filter.
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Timestamps ────────────────────────────────────────────────────────────────

// TrueNAS returns timestamps as {$date: ms}, epoch seconds or ISO strings.
export function parseTs(val: unknown): Date | null {
  let d: Date;
  if (val == null) return null;
  if (typeof val === 'object' && '$date' in (val as object)) d = new Date((val as { $date: number }).$date);
  else if (typeof val === 'number') d = new Date(val * 1000);
  else if (typeof val === 'string') d = new Date(val);
  else return null;
  return isNaN(d.getTime()) ? null : d;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

// ISO 8601 in the NAS's local time with its UTC offset, e.g.
// "2026-10-25T03:00:12+01:00": readable as local time, unambiguous across DST.
export function formatTs(val: unknown, tz: string): string | null {
  const d = parseTs(val);
  if (!d) return null;
  let fmt = formatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23', timeZoneName: 'longOffset',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  const offset = p['timeZoneName'].replace('GMT', '') || '+00:00';
  return `${p['year']}-${p['month']}-${p['day']}T${p['hour']}:${p['minute']}:${p['second']}${offset}`;
}

const TZ_TTL_MS = 60 * 60 * 1000;
let tzCache: { tz: string; at: number } | null = null;

// The timezone configured on the NAS (System → General), cached for an hour.
export async function nasTimezone(client: TrueNASClient): Promise<string> {
  if (tzCache && Date.now() - tzCache.at < TZ_TTL_MS) return tzCache.tz;
  try {
    const cfg = await client.call<{ timezone?: string }>('system.general.config');
    const tz = cfg.timezone || 'UTC';
    new Intl.DateTimeFormat('en', { timeZone: tz }); // throws on unknown zones
    tzCache = { tz, at: Date.now() };
    return tz;
  } catch {
    return 'UTC';
  }
}

// ── Secret redaction for API payloads ─────────────────────────────────────────

const SENSITIVE_KEY = /(password|passwd|pass|secret|token|key|credential|private)/i;
const MAX_STRING = 2000;

// Recursively masks values under secret-looking keys and truncates long strings.
// TrueNAS already masks its own Secret-typed params as "********".
export function redactArgs(val: unknown, key = ''): unknown {
  if (key && SENSITIVE_KEY.test(key) && val != null && typeof val !== 'boolean') return '[redacted]';
  if (typeof val === 'string') return val.length > MAX_STRING ? `${val.slice(0, MAX_STRING)}… [truncated]` : val;
  if (Array.isArray(val)) return val.map((v) => redactArgs(v));
  if (val && typeof val === 'object') {
    return Object.fromEntries(Object.entries(val as Record<string, unknown>).map(([k, v]) => [k, redactArgs(v, k)]));
  }
  return val;
}
