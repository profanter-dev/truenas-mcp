import { TrueNASClient } from '../truenas-client.js';
import { ToolDef, READ_ONLY } from './registry.js';
import { formatBytes, formatTs, nasTimezone } from './utils.js';

type AnyObj = Record<string, unknown>;

export async function systemInfo(client: TrueNASClient): Promise<string> {
  const [info, tz] = await Promise.all([client.call<AnyObj>('system.info'), nasTimezone(client)]);

  const loadavg = info['loadavg'] as number[] | undefined;
  const physmem = info['physmem'] as number | null | undefined;

  return JSON.stringify({
    hostname: info['hostname'],
    version: info['version'],
    product: info['system_product'],
    manufacturer: info['system_manufacturer'],
    cpu_model: info['model'],
    cpu_cores: info['cores'],
    cpu_physical_cores: info['physical_cores'],
    memory: { bytes: physmem ?? null, human: formatBytes(physmem) },
    ecc_memory: info['ecc_memory'],
    uptime: info['uptime'],
    load_avg: loadavg && loadavg.length >= 3 ? {
      '1min': parseFloat(loadavg[0].toFixed(2)),
      '5min': parseFloat(loadavg[1].toFixed(2)),
      '15min': parseFloat(loadavg[2].toFixed(2)),
    } : null,
    boot_time: formatTs(info['boottime'], tz),
    timezone: info['timezone'],
  }, null, 2);
}

// ── registry ───────────────────────────────────────────────────────────────────

export function systemTools(client: TrueNASClient): ToolDef[] {
  return [
    {
      tool: {
        name: 'system_info',
        description: 'Get TrueNAS system information: hostname, version, CPU, memory, uptime, load average, and timezone.',
        inputSchema: { type: 'object', properties: {} },
        annotations: READ_ONLY,
      },
      handler: () => systemInfo(client),
    },
  ];
}
