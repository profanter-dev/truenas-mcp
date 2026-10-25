// Metric history from TrueNAS's netdata-backed reporting (the graphs in the
// Reports UI). Read-only: reporting.netdata_graphs / reporting.netdata_get_data.

import { TrueNASClient } from '../truenas-client.js';
import { ToolDef, READ_ONLY, str, optStr, optDate, posInt } from './registry.js';
import { formatTs, nasTimezone } from './utils.js';

type AnyObj = Record<string, unknown>;
type Row = Array<number | null>;

const DEFAULT_WINDOW_SEC = 24 * 3600;
const MAX_POINTS = 500;

const round = (v: number) => Math.round(v * 100) / 100;

// Identifiers look like "sda | Type: HDD | Model: … | Serial: …"; accept the
// leading device name on its own.
function resolveIdentifier(graph: AnyObj, wanted: string | undefined): string | null {
  const ids = (graph['identifiers'] as string[] | null) ?? null;
  if (!ids) return null;
  const short = ids.map((id) => id.split(' | ')[0]);
  if (wanted === undefined) {
    if (ids.length === 1) return ids[0];
    throw new Error(`Graph '${graph['name']}' needs an identifier: ${short.join(', ')}`);
  }
  const i = ids.findIndex((id, n) => id === wanted || short[n] === wanted);
  if (i < 0) throw new Error(`Unknown identifier '${wanted}' for graph '${graph['name']}'. Available: ${short.join(', ')}`);
  return ids[i];
}

// netdata fills the time the NAS was off with zeros, so outages show up as a
// drop in the uptime series rather than as missing samples.
function findReboots(uptime: Row[]): Array<{ last_sample: number; booted_at: number }> {
  const out: Array<{ last_sample: number; booted_at: number }> = [];
  for (let i = 1; i < uptime.length; i++) {
    const prev = uptime[i - 1][1], cur = uptime[i][1];
    if (prev == null || cur == null || cur >= prev) continue;
    let j = i;
    while (j < uptime.length && !(Number(uptime[j][1]) > 0)) j++;
    const booted = j < uptime.length ? Number(uptime[j][0]) - Number(uptime[j][1]) : Number(uptime[i][0]);
    out.push({ last_sample: Number(uptime[i - 1][0]), booted_at: booted });
    i = j;
  }
  return out;
}

export async function metricsHistory(
  client: TrueNASClient,
  name: string,
  identifier: string | undefined,
  since: Date | undefined,
  until: Date | undefined,
  points: number,
): Promise<string> {
  const [graphs, tz] = await Promise.all([client.call<AnyObj[]>('reporting.netdata_graphs'), nasTimezone(client)]);
  const graph = graphs.find((g) => g['name'] === name);
  if (!graph) throw new Error(`Unknown graph '${name}'. Available: ${graphs.map((g) => g['name']).join(', ')}`);

  const id = resolveIdentifier(graph, identifier);
  const end = Math.floor((until ?? new Date()).getTime() / 1000);
  const start = since ? Math.floor(since.getTime() / 1000) : end - DEFAULT_WINDOW_SEC;
  if (start >= end) throw new Error('`since` must be before `until`.');

  const requests = [{ name, identifier: id }];
  if (name !== 'uptime') requests.push({ name: 'uptime', identifier: null });
  const res = await client.call<AnyObj[]>('reporting.netdata_get_data', [requests, { start, end, aggregate: true }]);

  const main = res[0];
  const legend = ((main?.['legend'] as string[] | undefined) ?? []).slice(1);
  const rows = ((main?.['data'] as Row[] | undefined) ?? []).filter((r) => r[0] != null);
  const reboots = findReboots(((res[res.length - 1]?.['data'] as Row[] | undefined) ?? []));

  const down = (t: number) => reboots.some((r) => t > r.last_sample && t < r.booted_at);
  const live = rows.filter((r) => !down(Number(r[0])));
  if (!live.length) {
    return JSON.stringify({ graph: name, identifier: id, message: 'No data in this time range (netdata retention may not reach back that far).' }, null, 2);
  }

  // Per-column min/mean/max and when the peak happened, over samples while the NAS was up.
  const summary: AnyObj = {};
  legend.forEach((col, c) => {
    let min = Infinity, max = -Infinity, sum = 0, n = 0, peakAt = 0;
    for (const r of live) {
      const v = r[c + 1];
      if (v == null) continue;
      if (v < min) min = v;
      if (v > max) { max = v; peakAt = Number(r[0]); }
      sum += v; n++;
    }
    if (n) summary[col] = { min: round(min), mean: round(sum / n), max: round(max), max_at: formatTs(peakAt, tz) };
  });

  // Time buckets with the mean of each column; buckets without samples are skipped.
  const first = Number(live[0][0]), last = Number(live[live.length - 1][0]);
  const width = Math.max(1, (last - first + 1) / points);
  const buckets = new Map<number, { sums: number[]; counts: number[] }>();
  for (const r of live) {
    const b = Math.min(points - 1, Math.floor((Number(r[0]) - first) / width));
    let acc = buckets.get(b);
    if (!acc) buckets.set(b, acc = { sums: legend.map(() => 0), counts: legend.map(() => 0) });
    legend.forEach((_, c) => {
      const v = r[c + 1];
      if (v != null) { acc!.sums[c] += v; acc!.counts[c]++; }
    });
  }
  const series = [...buckets.entries()].sort(([a], [b]) => a - b).map(([b, acc]) => [
    formatTs(first + b * width, tz),
    ...acc.sums.map((s, c) => (acc.counts[c] ? round(s / acc.counts[c]) : null)),
  ]);

  return JSON.stringify({
    graph: name,
    title: String(graph['title'] ?? '').replace('{identifier}', identifier ?? id ?? '').trim(),
    identifier: id,
    unit: graph['vertical_label'],
    data_from: formatTs(first, tz),
    data_to: formatTs(last, tz),
    bucket_seconds: Math.round(width),
    reboots: reboots.map((r) => ({
      last_sample_before: formatTs(r.last_sample, tz),
      booted_at: formatTs(r.booted_at, tz),
      down_minutes: Math.round((r.booted_at - r.last_sample) / 60),
    })),
    summary,
    columns: ['bucket_start', ...legend],
    series,
  }, null, 2);
}

// ── registry ───────────────────────────────────────────────────────────────────

export function reportingTools(client: TrueNASClient): ToolDef[] {
  return [
    {
      tool: {
        name: 'metrics_history',
        description: 'History of a TrueNAS reporting graph (the Reports UI): per-column min/mean/max with the time of the peak, a downsampled series (bucket means), and reboots detected from uptime with the downtime window (samples while the NAS was down are excluded). Common graphs: cpu (%), cputemp (°C), memory, load, uptime, arcsize, disk (I/O, needs identifier e.g. "sda"), disktemp (needs identifier), interface (e.g. "enp3s0"). An unknown graph or identifier returns the available ones. Retention is set in TrueNAS reporting settings (by default about a week at full resolution, a month aggregated).',
        inputSchema: {
          type: 'object',
          properties: {
            graph: { type: 'string', description: 'Graph name, e.g. "cpu", "cputemp", "disktemp"' },
            identifier: { type: 'string', description: 'Device for per-device graphs, e.g. "sda" or "enp3s0"' },
            since: { type: 'string', description: 'ISO date/time to start from (default: 24 h before `until`)' },
            until: { type: 'string', description: 'ISO date/time to end at (default: now)' },
            points: { type: 'number', description: `Number of time buckets in the series (default 60, max ${MAX_POINTS})`, default: 60 },
          },
          required: ['graph'],
        },
        annotations: READ_ONLY,
      },
      handler: (args) => metricsHistory(
        client,
        str(args, 'graph'),
        optStr(args, 'identifier'),
        optDate(args, 'since'),
        optDate(args, 'until'),
        Math.min(MAX_POINTS, posInt(args, 'points', 60)),
      ),
    },
  ];
}
