import { TrueNASClient } from '../truenas-client.js';

type AnyObj = Record<string, unknown>;

function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = bytes; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(2)} ${units[i]}`;
}

function parseTs(val: unknown): string | null {
  if (val == null) return null;
  if (typeof val === 'object' && '$date' in (val as object)) return new Date((val as { $date: number }).$date).toISOString();
  if (typeof val === 'number') return new Date(val * 1000).toISOString();
  if (typeof val === 'string') { const d = new Date(val); return isNaN(d.getTime()) ? null : d.toISOString(); }
  return null;
}

export async function systemInfo(client: TrueNASClient): Promise<string> {
  const info = await client.call<AnyObj>('system.info');

  const loadavg = info['loadavg'] as number[] | undefined;

  return JSON.stringify({
    hostname: info['hostname'],
    version: info['version'],
    product: info['system_product'],
    manufacturer: info['system_manufacturer'],
    cpu_model: info['model'],
    cpu_cores: info['cores'],
    cpu_physical_cores: info['physical_cores'],
    memory: { bytes: info['physmem'], human: formatBytes(info['physmem'] as number) },
    ecc_memory: info['ecc_memory'],
    uptime: info['uptime'],
    load_avg: loadavg ? {
      '1min': parseFloat(loadavg[0].toFixed(2)),
      '5min': parseFloat(loadavg[1].toFixed(2)),
      '15min': parseFloat(loadavg[2].toFixed(2)),
    } : null,
    boot_time: parseTs(info['boottime']),
    timezone: info['timezone'],
  }, null, 2);
}
