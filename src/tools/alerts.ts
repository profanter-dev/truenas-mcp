import { TrueNASClient } from '../truenas-client.js';
import { ToolDef, READ_ONLY } from './registry.js';
import { formatTs, nasTimezone } from './utils.js';

type AnyObj = Record<string, unknown>;

const SEVERITY_ORDER: Record<string, number> = {
  CRITICAL: 0,
  ERROR: 1,
  WARNING: 2,
  NOTICE: 3,
  INFO: 4,
  DEBUG: 5,
};

export async function alertList(client: TrueNASClient): Promise<string> {
  const [alerts, tz] = await Promise.all([client.call<AnyObj[]>('alert.list'), nasTimezone(client)]);

  if (!alerts.length) {
    return JSON.stringify({ message: 'No active alerts.', alerts: [] }, null, 2);
  }

  const sorted = [...alerts].sort((a, b) => {
    const aScore = SEVERITY_ORDER[(a['level'] as string) ?? ''] ?? 99;
    const bScore = SEVERITY_ORDER[(b['level'] as string) ?? ''] ?? 99;
    return aScore - bScore;
  });

  const formatted = sorted.map((alert) => ({
    uuid: alert['uuid'],
    source: alert['source'],
    level: alert['level'],
    message: typeof alert['formatted'] === 'string' ? alert['formatted'] : alert['text'],
    dismissed: alert['dismissed'] ?? false,
    datetime: formatTs(alert['datetime'], tz),
  }));

  return JSON.stringify(formatted, null, 2);
}

// ── registry ───────────────────────────────────────────────────────────────────

export function alertTools(client: TrueNASClient): ToolDef[] {
  return [
    {
      tool: {
        name: 'alert_list',
        description: 'List all active TrueNAS alerts sorted by severity (CRITICAL → WARNING → INFO). Only currently active alerts: cleared alerts are not kept. Times are in the NAS timezone with UTC offset.',
        inputSchema: { type: 'object', properties: {} },
        annotations: READ_ONLY,
      },
      handler: () => alertList(client),
    },
  ];
}
