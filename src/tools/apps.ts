import { TrueNASClient } from '../truenas-client.js';

type AnyObj = Record<string, unknown>;

function summarise(app: AnyObj): object {
  return {
    name: app['name'],
    state: app['state'],
    version: app['version'],
    human_version: app['human_version'],
    update_available: app['update_available'] ?? null,
  };
}

// ── app_list ──────────────────────────────────────────────────────────────────

export async function appList(client: TrueNASClient): Promise<string> {
  const apps = await client.call<AnyObj[]>('app.query');

  if (!apps.length) return JSON.stringify({ message: 'No apps installed.' }, null, 2);

  const result = apps.map(summarise).sort((a, b) =>
    String((a as AnyObj)['name']).localeCompare(String((b as AnyObj)['name'])),
  );

  return JSON.stringify(result, null, 2);
}

// ── app_details ───────────────────────────────────────────────────────────────

export async function appDetails(client: TrueNASClient, appName: string): Promise<string> {
  const apps = await client.call<AnyObj[]>('app.query', [[['name', '=', appName]]]);

  if (!apps.length) return JSON.stringify({ error: `App '${appName}' not found.` }, null, 2);

  const app = apps[0];

  return JSON.stringify({
    name: app['name'],
    state: app['state'],
    version: app['version'],
    human_version: app['human_version'],
    update_available: app['update_available'] ?? null,
    migrated: app['migrated'] ?? null,
    train: app['metadata'] ? (app['metadata'] as AnyObj)['train'] : null,
    icon_url: app['metadata'] ? (app['metadata'] as AnyObj)['icon'] : null,
    notes: app['notes'] ?? null,
    portals: app['portals'] ?? null,
    active_workloads: app['active_workloads'] ?? null,
  }, null, 2);
}

// ── app_logs ──────────────────────────────────────────────────────────────────

export async function appLogs(client: TrueNASClient, appName: string, tailLines = 100): Promise<string> {
  // app.logs is a subscription/event API on TrueNAS; the closest single-call
  // equivalent is app.get_logs which returns a snapshot of recent log lines.
  const result = await client.call<unknown>('app.get_logs', [appName, { tail_lines: tailLines }])
    .catch(() => null);

  if (result === null) {
    // Fallback: try the older container_logs style
    const fallback = await client.call<unknown>('app.logs', [appName, { tail_lines: tailLines }])
      .catch((e: Error) => { throw new Error(`Logs unavailable for '${appName}': ${e.message}`); });
    if (typeof fallback === 'string') return fallback;
    return JSON.stringify(fallback, null, 2);
  }

  if (typeof result === 'string') return result;
  if (Array.isArray(result)) return result.join('\n');
  return JSON.stringify(result, null, 2);
}
