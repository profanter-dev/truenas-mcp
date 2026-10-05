import { TrueNASClient } from '../truenas-client.js';
import { ToolDef, READ_ONLY, str, posInt } from './registry.js';

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

// ── registry ───────────────────────────────────────────────────────────────────

export function appTools(client: TrueNASClient): ToolDef[] {
  return [
    {
      tool: {
        name: 'app_list',
        description: 'List all installed TrueNAS apps with their state, version, and whether an update is available.',
        inputSchema: { type: 'object', properties: {} },
        annotations: READ_ONLY,
      },
      handler: () => appList(client),
    },
    {
      tool: {
        name: 'app_details',
        description: 'Get full details for a single TrueNAS app: state, version, portals, active workloads, and notes.',
        inputSchema: {
          type: 'object',
          properties: {
            app_name: { type: 'string', description: 'App name as shown in app_list, e.g. "actual-budget"' },
          },
          required: ['app_name'],
        },
        annotations: READ_ONLY,
      },
      handler: (args) => appDetails(client, str(args, 'app_name')),
    },
    {
      tool: {
        name: 'app_logs',
        description: 'Retrieve recent log output for a TrueNAS app.',
        inputSchema: {
          type: 'object',
          properties: {
            app_name: { type: 'string', description: 'App name as shown in app_list' },
            tail_lines: { type: 'number', description: 'Number of log lines to return (default 100)', default: 100 },
          },
          required: ['app_name'],
        },
        annotations: READ_ONLY,
      },
      handler: (args) => appLogs(client, str(args, 'app_name'), posInt(args, 'tail_lines', 100)),
    },
  ];
}
