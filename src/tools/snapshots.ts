import { TrueNASClient } from '../truenas-client.js';
import { ToolDef, READ_ONLY, str, optStr, optDate, posInt } from './registry.js';
import { escapeRegex, formatBytes, formatTs, nasTimezone, parseTs } from './utils.js';

type AnyObj = Record<string, unknown>;

function prop(properties: AnyObj, key: string): unknown {
  const v = properties[key] as AnyObj | undefined;
  return v?.['parsed'] ?? null;
}

function creation(properties: AnyObj): unknown {
  return (properties['creation'] as AnyObj | undefined)?.['parsed'];
}

function summarise(raw: AnyObj, tz: string): object {
  const p = raw['properties'] as AnyObj ?? {};
  const usedBytes = prop(p, 'used') as number | null;
  const refBytes = prop(p, 'referenced') as number | null;
  return {
    id: raw['id'],
    dataset: raw['dataset'],
    snapshot_name: raw['snapshot_name'],
    pool: raw['pool'],
    created: formatTs(creation(p), tz),
    used: usedBytes != null ? { bytes: usedBytes, human: formatBytes(usedBytes) } : null,
    referenced: refBytes != null ? { bytes: refBytes, human: formatBytes(refBytes) } : null,
  };
}

export interface SnapshotFilter {
  datasetId?: string;
  nameContains?: string;
  since?: Date;
  ignoreBootPool: boolean;
}

export async function snapshotList(client: TrueNASClient, filter: SnapshotFilter, limit = 20): Promise<string> {
  const conditions: unknown[] = [];
  if (filter.datasetId) conditions.push(['dataset', '=', filter.datasetId]);
  if (filter.ignoreBootPool) conditions.push(['pool', '!=', 'boot-pool']);
  if (filter.nameContains) conditions.push(['snapshot_name', '~', `.*${escapeRegex(filter.nameContains)}`]);

  // createtxg only orders snapshots within one pool, so a date cutoff needs the
  // full (server-filtered) list, sorted by creation time here.
  const since = filter.since;
  const [raw, tz] = await Promise.all([
    client.call<AnyObj[]>('zfs.snapshot.query', [
      conditions,
      since ? {} : { order_by: ['-createtxg'], limit },
    ]),
    nasTimezone(client),
  ]);

  let snapshots = raw;
  if (since) {
    const createdMs = (s: AnyObj) => parseTs(creation(s['properties'] as AnyObj ?? {}))?.getTime() ?? 0;
    snapshots = raw
      .filter((s) => createdMs(s) >= since.getTime())
      .sort((a, b) => createdMs(b) - createdMs(a))
      .slice(0, limit);
  }

  if (!snapshots.length) {
    const ctx = filter.datasetId ? `dataset '${filter.datasetId}'` : 'any dataset';
    return JSON.stringify({ message: `No matching snapshots found for ${ctx}.` }, null, 2);
  }

  return JSON.stringify(snapshots.map((s) => summarise(s, tz)), null, 2);
}

export async function snapshotDetails(client: TrueNASClient, snapshotId: string): Promise<string> {
  const [snapshots, tz] = await Promise.all([
    client.call<AnyObj[]>('zfs.snapshot.query', [[['id', '=', snapshotId]]]),
    nasTimezone(client),
  ]);

  if (!snapshots.length) {
    return JSON.stringify({ error: `Snapshot '${snapshotId}' not found.` }, null, 2);
  }

  const raw = snapshots[0];
  const p = raw['properties'] as AnyObj ?? {};

  function fmtProp(key: string): unknown {
    const v = p[key] as AnyObj | undefined;
    const parsed = v?.['parsed'];
    if (parsed == null) return null;
    if (typeof parsed === 'number' && ['used', 'referenced', 'logicalreferenced', 'unique'].includes(key)) {
      return { bytes: parsed, human: formatBytes(parsed) };
    }
    return parsed;
  }

  return JSON.stringify({
    id: raw['id'],
    dataset: raw['dataset'],
    snapshot_name: raw['snapshot_name'],
    pool: raw['pool'],
    created: formatTs(creation(p), tz),
    used: fmtProp('used'),
    referenced: fmtProp('referenced'),
    logical_referenced: fmtProp('logicalreferenced'),
    unique: fmtProp('unique'),
    compressratio: prop(p, 'compressratio'),
    clones: prop(p, 'clones') || null,
  }, null, 2);
}

// ── registry ───────────────────────────────────────────────────────────────────

export function snapshotTools(client: TrueNASClient): ToolDef[] {
  return [
    {
      tool: {
        name: 'snapshot_list',
        description: 'List ZFS snapshots ordered by most recent. Optionally filter by dataset, by a substring of the snapshot name (e.g. "_00-00" for the midnight ones), or by creation date.',
        inputSchema: {
          type: 'object',
          properties: {
            dataset_id: { type: 'string', description: 'Optional dataset to filter by, e.g. "media/tv"' },
            name_contains: { type: 'string', description: 'Only snapshots whose name (the part after @) contains this text, e.g. "_00-00"' },
            since: { type: 'string', description: 'Only snapshots created at or after this ISO date/time, e.g. "2026-10-25T00:00:00+02:00" (a date alone means midnight UTC)' },
            limit: { type: 'number', description: 'Max number of snapshots to return (default 20)', default: 20 },
            ignore_boot_pool: { type: 'boolean', description: 'Exclude boot-pool snapshots (default true)', default: true },
          },
        },
        annotations: READ_ONLY,
      },
      handler: (args) => snapshotList(client, {
        datasetId: optStr(args, 'dataset_id'),
        nameContains: optStr(args, 'name_contains'),
        since: optDate(args, 'since'),
        ignoreBootPool: args['ignore_boot_pool'] !== false,
      }, posInt(args, 'limit', 20)),
    },
    {
      tool: {
        name: 'snapshot_details',
        description: 'Get full details for a specific ZFS snapshot.',
        inputSchema: {
          type: 'object',
          properties: {
            snapshot_id: { type: 'string', description: 'Snapshot ID as returned by snapshot_list, e.g. "media/tv@auto-2026-06-01"' },
          },
          required: ['snapshot_id'],
        },
        annotations: READ_ONLY,
      },
      handler: (args) => snapshotDetails(client, str(args, 'snapshot_id')),
    },
  ];
}
