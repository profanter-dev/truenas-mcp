import { TrueNASClient } from '../truenas-client.js';

type AnyObj = Record<string, unknown>;

const SEVERITY_ORDER: Record<string, number> = {
  CRITICAL: 0,
  ERROR: 1,
  WARNING: 2,
  NOTICE: 3,
  INFO: 4,
  DEBUG: 5,
};

function formatDateRome(val: unknown): string {
  if (val == null) return 'N/A';
  let d: Date;
  if (typeof val === 'string') {
    d = new Date(val);
  } else if (typeof val === 'number') {
    d = new Date(val * 1000);
  } else if (typeof val === 'object' && '$date' in (val as object)) {
    d = new Date((val as { $date: number }).$date);
  } else {
    return String(val);
  }
  if (isNaN(d.getTime())) return String(val);
  return d.toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
}

export async function alertList(client: TrueNASClient): Promise<string> {
  const alerts = await client.call<AnyObj[]>('alert.list');

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
    datetime: formatDateRome(alert['datetime']),
  }));

  return JSON.stringify(formatted, null, 2);
}
