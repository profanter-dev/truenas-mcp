import { TrueNASClient } from '../truenas-client.js';
import { formatBytes } from './utils.js';

type AnyObj = Record<string, unknown>;

function parseTimestamp(val: unknown): string | null {
  if (val == null) return null;
  if (typeof val === 'string') { const d = new Date(val); return isNaN(d.getTime()) ? val : d.toISOString(); }
  if (typeof val === 'number') return new Date(val * 1000).toISOString();
  if (typeof val === 'object' && '$date' in (val as object)) return new Date((val as { $date: number }).$date).toISOString();
  return null;
}

// ── Pool topology helpers ─────────────────────────────────────────────────────

interface DiskVdevInfo {
  pool: string;
  vdev_name: string;
  vdev_type: string;
  status: string;
  read_errors: number;
  write_errors: number;
  checksum_errors: number;
}

function collectVdevNode(
  node: AnyObj,
  poolName: string,
  vdevLabel: string,
  out: Map<string, DiskVdevInfo>,
): void {
  const type = ((node['type'] as string) ?? '').toUpperCase();
  const children = node['children'] as AnyObj[] | undefined;

  if (type === 'DISK') {
    const name = (node['disk'] as string) ?? (node['name'] as string) ?? '';
    if (name) {
      const stats = node['stats'] as AnyObj | undefined;
      out.set(name, {
        pool: poolName,
        vdev_name: vdevLabel,
        vdev_type: type,
        status: (node['status'] as string) ?? 'UNKNOWN',
        read_errors: (stats?.['read_errors'] as number) ?? 0,
        write_errors: (stats?.['write_errors'] as number) ?? 0,
        checksum_errors: (stats?.['checksum_errors'] as number) ?? 0,
      });
    }
  } else if (children?.length) {
    const label = (node['name'] as string) ?? type;
    for (const child of children) {
      collectVdevNode(child, poolName, label, out);
    }
  }
}

function buildDiskVdevMap(pools: AnyObj[]): Map<string, DiskVdevInfo> {
  const map = new Map<string, DiskVdevInfo>();
  for (const pool of pools) {
    const poolName = pool['name'] as string;
    const topology = pool['topology'] as AnyObj | undefined;
    if (!topology) continue;
    for (const section of ['data', 'special', 'cache', 'log', 'spare', 'dedup']) {
      const nodes = topology[section] as AnyObj[] | undefined;
      if (nodes?.length) {
        for (const node of nodes) collectVdevNode(node, poolName, (node['name'] as string) ?? section, map);
      }
    }
  }
  return map;
}

function dsCapacity(ds: AnyObj): { used: unknown; available: unknown; total: unknown } {
  const usedBytes = (ds['used'] as AnyObj | undefined)?.['parsed'] as number | undefined;
  const availBytes = (ds['available'] as AnyObj | undefined)?.['parsed'] as number | undefined;
  const totalBytes = usedBytes != null && availBytes != null ? usedBytes + availBytes : undefined;
  return {
    used: usedBytes != null ? { bytes: usedBytes, human: formatBytes(usedBytes) } : 'N/A',
    available: availBytes != null ? { bytes: availBytes, human: formatBytes(availBytes) } : 'N/A',
    total: totalBytes != null ? { bytes: totalBytes, human: formatBytes(totalBytes) } : 'N/A',
  };
}

// ── pool_list ─────────────────────────────────────────────────────────────────

export async function poolList(client: TrueNASClient): Promise<string> {
  const [pools, rootDatasets] = await Promise.all([
    client.call<AnyObj[]>('pool.query'),
    client.call<AnyObj[]>('pool.dataset.query', [[['type', '=', 'FILESYSTEM']]]),
  ]);

  // root dataset has the same name as the pool
  const rootDsByPool = new Map<string, AnyObj>();
  for (const ds of rootDatasets) {
    const name = ds['name'] as string;
    if (name && !name.includes('/')) rootDsByPool.set(name, ds);
  }

  const result = pools.map((pool) => {
    const name = pool['name'] as string;
    const root = rootDsByPool.get(name);
    const cap = root ? dsCapacity(root) : { used: 'N/A', available: 'N/A', total: 'N/A' };
    return {
      name,
      status: pool['status'],
      healthy: pool['healthy'],
      warning: pool['warning'],
      ...cap,
    };
  });

  return JSON.stringify(result, null, 2);
}

// ── pool_details ──────────────────────────────────────────────────────────────

export async function poolDetails(client: TrueNASClient, poolName: string): Promise<string> {
  const [pools, rootDatasets] = await Promise.all([
    client.call<AnyObj[]>('pool.query', [[['name', '=', poolName]]]),
    client.call<AnyObj[]>('pool.dataset.query', [[['id', '=', poolName]]]),
  ]);

  if (!pools.length) return JSON.stringify({ error: `Pool '${poolName}' not found.` }, null, 2);

  const pool = pools[0];
  const scan = pool['scan'] as AnyObj | null | undefined;
  const rootDs = rootDatasets[0];
  const cap = rootDs ? dsCapacity(rootDs) : { used: 'N/A', available: 'N/A', total: 'N/A' };

  const result = {
    name: pool['name'],
    status: pool['status'],
    healthy: pool['healthy'],
    warning: pool['warning'],
    ...cap,
    last_scrub: scan ? {
      state: scan['state'],
      start_time: parseTimestamp(scan['start_time']),
      end_time: parseTimestamp(scan['end_time']),
      errors: scan['errors'] ?? 0,
      bytes_processed: scan['bytes_processed'] != null ? formatBytes(scan['bytes_processed'] as number) : null,
    } : null,
  };

  return JSON.stringify(result, null, 2);
}

// ── disk_status ───────────────────────────────────────────────────────────────

export async function diskList(client: TrueNASClient): Promise<string> {
  const [disks, pools, smartTests] = await Promise.all([
    client.call<AnyObj[]>('disk.query'),
    client.call<AnyObj[]>('pool.query'),
    client.call<AnyObj[]>('smart.test.query', [[], { order_by: ['-ended'], limit: 500 }])
      .catch(() => [] as AnyObj[]),
  ]);

  const diskNames = disks.map((d) => d['name'] as string).filter(Boolean);
  const temps = await client
    .call<Record<string, number | null>>('disk.temperatures', [diskNames])
    .catch(() => ({}) as Record<string, number | null>);

  const vdevMap = buildDiskVdevMap(pools);

  const lastSmartByDisk = new Map<string, AnyObj>();
  for (const t of smartTests) {
    const dn = t['disk'] as string | undefined;
    if (dn && !lastSmartByDisk.has(dn)) lastSmartByDisk.set(dn, t);
  }

  const result = disks.map((disk) => {
    const name = disk['name'] as string;
    const vdev = vdevMap.get(name);
    const lastTest = lastSmartByDisk.get(name);
    const hasZfsErrors = vdev && (vdev.read_errors > 0 || vdev.write_errors > 0 || vdev.checksum_errors > 0);

    return {
      name,
      model: disk['model'] ?? 'N/A',
      type: disk['type'] ?? 'Unknown',
      pool: vdev?.pool ?? null,
      temperature_c: temps[name] ?? null,
      smart_status: lastTest ? (lastTest['result'] as string) : (disk['smart_enabled'] ? 'no_tests_run' : 'disabled'),
      zfs_errors: hasZfsErrors ? {
        read: vdev!.read_errors,
        write: vdev!.write_errors,
        checksum: vdev!.checksum_errors,
      } : null,
    };
  });

  return JSON.stringify(result, null, 2);
}

// ── disk_details ──────────────────────────────────────────────────────────────

export async function diskDetails(client: TrueNASClient, diskName: string): Promise<string> {
  const [disks, pools, smartTests] = await Promise.all([
    client.call<AnyObj[]>('disk.query', [[['name', '=', diskName]]]),
    client.call<AnyObj[]>('pool.query'),
    client.call<AnyObj[]>('smart.test.query', [
      [['disk', '=', diskName]],
      { order_by: ['-ended'], limit: 20 },
    ]).catch(() => [] as AnyObj[]),
  ]);

  if (!disks.length) return JSON.stringify({ error: `Disk '${diskName}' not found.` }, null, 2);

  const disk = disks[0];
  const temp = await client
    .call<Record<string, number | null>>('disk.temperatures', [[diskName]])
    .catch(() => ({}) as Record<string, number | null>);

  const vdevMap = buildDiskVdevMap(pools);
  const vdev = vdevMap.get(diskName);
  const size = disk['size'] as number | null | undefined;

  return JSON.stringify({
    name: diskName,
    serial: disk['serial'] ?? 'N/A',
    model: disk['model'] ?? 'N/A',
    size: size ? { bytes: size, human: formatBytes(size) } : null,
    type: disk['type'] ?? 'Unknown',
    rotation_rpm: disk['rotationrate'] ?? 'SSD/NVMe',
    bus: disk['bus'] ?? null,
    temperature_c: temp[diskName] ?? null,
    smart_enabled: disk['smart_enabled'] ?? false,
    pool: vdev?.pool ?? null,
    vdev: vdev ? { name: vdev.vdev_name, status: vdev.status } : null,
    zfs_errors: vdev ? { read: vdev.read_errors, write: vdev.write_errors, checksum: vdev.checksum_errors } : null,
    smart_tests: smartTests.map((t) => ({
      type: t['type'],
      result: t['result'],
      ended: t['ended'] ?? null,
      lifetime_hours: t['lifetime'] ?? null,
    })),
  }, null, 2);
}

// ── dataset_list ──────────────────────────────────────────────────────────────

export async function datasetList(client: TrueNASClient, poolName?: string): Promise<string> {
  const filters: unknown[] = poolName ? [[['pool', '=', poolName]]] : [[]];
  const datasets = await client.call<AnyObj[]>('pool.dataset.query', [...filters, { order_by: ['name'] }]);

  if (!datasets.length) {
    const ctx = poolName ? `pool '${poolName}'` : 'any pool';
    return JSON.stringify({ message: `No datasets found for ${ctx}.` }, null, 2);
  }

  const result = datasets.map((ds) => {
    const used = ds['used'] as AnyObj | undefined;
    const avail = ds['available'] as AnyObj | undefined;
    const usedBytes = used?.['parsed'] as number | undefined;
    const availBytes = avail?.['parsed'] as number | undefined;
    return {
      id: ds['id'],
      pool: ds['pool'],
      type: ds['type'],
      used: usedBytes != null ? { bytes: usedBytes, human: formatBytes(usedBytes) } : (used?.['value'] ?? 'N/A'),
      available: availBytes != null ? { bytes: availBytes, human: formatBytes(availBytes) } : (avail?.['value'] ?? 'N/A'),
    };
  });

  return JSON.stringify(result, null, 2);
}

// ── dataset_details ───────────────────────────────────────────────────────────

export async function datasetDetails(client: TrueNASClient, datasetId: string): Promise<string> {
  const datasets = await client.call<AnyObj[]>('pool.dataset.query', [[['id', '=', datasetId]]]);

  if (!datasets.length) return JSON.stringify({ error: `Dataset '${datasetId}' not found.` }, null, 2);

  const ds = datasets[0];

  function prop(key: string): unknown {
    const v = ds[key] as AnyObj | undefined;
    if (v == null) return null;
    const parsed = v['parsed'];
    const value = v['value'];
    if (parsed != null) return parsed;
    if (value != null) return value;
    return null;
  }

  const usedBytes = (ds['used'] as AnyObj | undefined)?.['parsed'] as number | undefined;
  const availBytes = (ds['available'] as AnyObj | undefined)?.['parsed'] as number | undefined;
  const usedBySnapshots = (ds['usedbysnapshots'] as AnyObj | undefined)?.['parsed'] as number | undefined;

  return JSON.stringify({
    id: ds['id'],
    name: ds['name'],
    pool: ds['pool'],
    type: ds['type'],
    used: usedBytes != null ? { bytes: usedBytes, human: formatBytes(usedBytes) } : null,
    available: availBytes != null ? { bytes: availBytes, human: formatBytes(availBytes) } : null,
    used_by_snapshots: usedBySnapshots != null ? { bytes: usedBySnapshots, human: formatBytes(usedBySnapshots) } : null,
    compression: prop('compression'),
    compressratio: prop('compressratio'),
    deduplication: prop('deduplication'),
    recordsize: (() => { const v = prop('recordsize'); return typeof v === 'number' ? formatBytes(v) : v; })(),
    quota: prop('quota'),
    refquota: prop('refquota'),
    reservation: prop('reservation'),
    refreservation: prop('refreservation'),
    readonly: prop('readonly'),
    snapdir: prop('snapdir'),
    atime: prop('atime'),
    mountpoint: ds['mountpoint'] ?? null,
  }, null, 2);
}
