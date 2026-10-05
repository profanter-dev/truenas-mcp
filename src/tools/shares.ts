import { TrueNASClient } from '../truenas-client.js';
import { ToolDef, READ_ONLY, str } from './registry.js';

type AnyObj = Record<string, unknown>;

// ── share_list ────────────────────────────────────────────────────────────────

export async function shareList(client: TrueNASClient): Promise<string> {
  const [smb, nfs] = await Promise.all([
    client.call<AnyObj[]>('sharing.smb.query').catch(() => [] as AnyObj[]),
    client.call<AnyObj[]>('sharing.nfs.query').catch(() => [] as AnyObj[]),
  ]);

  const result = [
    ...smb.map((s) => ({
      id: s['id'],
      type: 'smb',
      name: s['name'],
      path: s['path'],
      enabled: s['enabled'],
      comment: (s['comment'] as string) || null,
    })),
    ...nfs.map((s) => ({
      id: s['id'],
      type: 'nfs',
      name: null,
      path: s['path'],
      enabled: s['enabled'],
      comment: (s['comment'] as string) || null,
    })),
  ];

  if (!result.length) return JSON.stringify({ message: 'No shares configured.' }, null, 2);

  return JSON.stringify(result, null, 2);
}

// ── share_details ─────────────────────────────────────────────────────────────

export async function shareDetails(client: TrueNASClient, type: string, id: number): Promise<string> {
  if (type !== 'smb' && type !== 'nfs') {
    return JSON.stringify({ error: 'type must be "smb" or "nfs"' }, null, 2);
  }

  const method = type === 'smb' ? 'sharing.smb.query' : 'sharing.nfs.query';
  const shares = await client.call<AnyObj[]>(method, [[['id', '=', id]]]);

  if (!shares.length) {
    return JSON.stringify({ error: `${type.toUpperCase()} share with id ${id} not found.` }, null, 2);
  }

  return JSON.stringify({ type, ...shares[0] }, null, 2);
}

// ── registry ───────────────────────────────────────────────────────────────────

export function shareTools(client: TrueNASClient): ToolDef[] {
  return [
    {
      tool: {
        name: 'share_list',
        description: 'List all configured SMB and NFS shares with their path, enabled state, and comment.',
        inputSchema: { type: 'object', properties: {} },
        annotations: READ_ONLY,
      },
      handler: () => shareList(client),
    },
    {
      tool: {
        name: 'share_details',
        description: 'Get full details for a specific SMB or NFS share.',
        inputSchema: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['smb', 'nfs'], description: 'Share protocol type' },
            id: { type: 'number', description: 'Share ID as returned by share_list' },
          },
          required: ['type', 'id'],
        },
        annotations: READ_ONLY,
      },
      handler: (args) => shareDetails(client, str(args, 'type'), Number(args['id'])),
    },
  ];
}
