import { TrueNASClient } from '../truenas-client.js';

type AnyObj = Record<string, unknown>;

function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = bytes; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(2)} ${units[i]}`;
}

function getCreationMs(raw: AnyObj): number {
  const p = raw['properties'] as AnyObj ?? {};
  const creation = (p['creation'] as AnyObj | undefined)?.['parsed'];
  if (typeof creation === 'object' && creation !== null && '$date' in (creation as object)) {
    return (creation as { $date: number }).$date;
  }
  return 0;
}

function prop(properties: AnyObj, key: string): unknown {
  const v = properties[key] as AnyObj | undefined;
  return v?.['parsed'] ?? null;
}

function parseCreation(properties: AnyObj): string | null {
  const creation = (properties['creation'] as AnyObj | undefined)?.['parsed'];
  if (!creation) return null;
  if (typeof creation === 'object' && '$date' in (creation as object)) {
    return new Date((creation as { $date: number }).$date).toISOString();
  }
  return null;
}

function summarise(raw: AnyObj): object {
  const p = raw['properties'] as AnyObj ?? {};
  const usedBytes = prop(p, 'used') as number | null;
  const refBytes = prop(p, 'referenced') as number | null;
  return {
    id: raw['id'],
    dataset: raw['dataset'],
    snapshot_name: raw['snapshot_name'],
    pool: raw['pool'],
    created: parseCreation(p),
    used: usedBytes != null ? { bytes: usedBytes, human: formatBytes(usedBytes) } : null,
    referenced: refBytes != null ? { bytes: refBytes, human: formatBytes(refBytes) } : null,
  };
}

export async function snapshotList(
  client: TrueNASClient,
  datasetId?: string,
  limit = 20,
  ignoreBootPool = true,
): Promise<string> {
  const conditions: unknown[] = [];
  if (datasetId) conditions.push(['dataset', '=', datasetId]);
  if (ignoreBootPool) conditions.push(['pool', '!=', 'boot-pool']);

  const snapshots = await client.call<AnyObj[]>('zfs.snapshot.query', [
    conditions,
    { order_by: ['-createtxg'], limit },
  ]);

  if (!snapshots.length) {
    const ctx = datasetId ? `dataset '${datasetId}'` : 'any dataset';
    return JSON.stringify({ message: `No snapshots found for ${ctx}.` }, null, 2);
  }

  snapshots.sort((a, b) => getCreationMs(b) - getCreationMs(a));

  return JSON.stringify(snapshots.map(summarise), null, 2);
}

export async function snapshotDetails(client: TrueNASClient, snapshotId: string): Promise<string> {
  const snapshots = await client.call<AnyObj[]>('zfs.snapshot.query', [[['id', '=', snapshotId]]]);

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
    created: parseCreation(p),
    used: fmtProp('used'),
    referenced: fmtProp('referenced'),
    logical_referenced: fmtProp('logicalreferenced'),
    unique: fmtProp('unique'),
    compressratio: prop(p, 'compressratio'),
    clones: prop(p, 'clones') || null,
  }, null, 2);
}
