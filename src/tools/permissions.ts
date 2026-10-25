// Folder ownership and ACLs as the NAS itself sees them (SMB/NFS clients only
// see their own mapped view). Read-only: filesystem.stat / filesystem.getacl.

import path from 'node:path';
import { TrueNASClient } from '../truenas-client.js';
import { ToolDef, READ_ONLY, str, optStr } from './registry.js';

type AnyObj = Record<string, unknown>;

function checkPath(p: string): string {
  if (!p.startsWith('/mnt/') || p.split('/').includes('..')) {
    throw new Error(`Path must be absolute and under /mnt/ (got '${p}').`);
  }
  return path.posix.normalize(p).replace(/(.)\/$/, '$1');
}

const mode = (m: unknown) => typeof m === 'number' ? (m & 0o7777).toString(8).padStart(4, '0') : null;

// POSIX1E entries in getfacl notation, "[default:]tag:who:rwx", e.g.
// "user:smb:r-x"; the owner and owning group are "user::" and "group::".
function posixEntry(e: AnyObj): string {
  const p = (e['perms'] as Record<string, boolean> | undefined) ?? {};
  const rwx = `${p['READ'] ? 'r' : '-'}${p['WRITE'] ? 'w' : '-'}${p['EXECUTE'] ? 'x' : '-'}`;
  const isObj = String(e['tag']).endsWith('_OBJ');
  const who = isObj ? '' : e['who'] ?? (Number(e['id']) >= 0 ? e['id'] : '');
  const tag = String(e['tag']).toLowerCase().replace('_obj', '');
  return `${e['default'] ? 'default:' : ''}${tag}:${who}:${rwx}`;
}

// NFSv4 entries with simplified perms/flags carry a BASIC level (e.g. MODIFY).
function nfs4Entry(e: AnyObj): object {
  const basic = (v: unknown) => {
    const o = (v as Record<string, unknown> | undefined) ?? {};
    return o['BASIC'] ?? Object.keys(o).filter((k) => o[k] === true);
  };
  const who = e['who'] ?? (Number(e['id']) >= 0 ? e['id'] : undefined);
  return { tag: e['tag'], ...(who != null ? { who } : {}), type: e['type'], perms: basic(e['perms']), flags: basic(e['flags']) };
}

function formatAcl(acl: AnyObj, includeDefault: boolean): object {
  const entries = (acl['acl'] as AnyObj[] | undefined) ?? [];
  const posix = acl['acltype'] === 'POSIX1E';
  return {
    acltype: acl['acltype'],
    ...(acl['trivial'] != null ? { trivial: acl['trivial'] } : {}),
    entries: entries
      .filter((e) => includeDefault || !e['default'])
      .map((e) => (posix ? posixEntry(e) : nfs4Entry(e))),
  };
}

function owner(st: AnyObj): object {
  return {
    owner: st['user'] ?? st['uid'],
    group: st['group'] ?? st['gid'],
    uid: st['uid'],
    gid: st['gid'],
    mode: mode(st['mode']),
  };
}

async function lookupUser(client: TrueNASClient, username: string): Promise<object> {
  // Fields are selected explicitly: the full record carries password hashes.
  const users = await client.call<AnyObj[]>('user.query', [
    [['username', '=', username]],
    { select: ['username', 'uid', 'group', 'groups', 'smb', 'locked', 'password_disabled'] },
  ]);
  const u = users[0];
  if (!u) throw new Error(`User '${username}' not found on the NAS.`);

  // `groups` holds group database IDs, not GIDs.
  const groupIds = (u['groups'] as number[] | undefined) ?? [];
  const groups = groupIds.length
    ? await client.call<AnyObj[]>('group.query', [[['id', 'in', groupIds]], { select: ['gid', 'name'] }])
    : [];
  const primary = (u['group'] as AnyObj | undefined) ?? {};

  return {
    username: u['username'],
    uid: u['uid'],
    primary_group: { gid: primary['bsdgrp_gid'], name: primary['bsdgrp_group'] },
    groups: groups.map((g) => ({ gid: g['gid'], name: g['name'] })),
    smb: u['smb'],
    locked: u['locked'],
    password_disabled: u['password_disabled'],
  };
}

export async function pathPermissions(client: TrueNASClient, rawPath: string, username?: string): Promise<string> {
  const target = checkPath(rawPath);

  // Every directory above the target must be traversable (x) for the user too.
  const parents: string[] = [];
  for (let p = path.posix.dirname(target); p !== '/mnt' && p !== '/'; p = path.posix.dirname(p)) parents.unshift(p);

  const [st, acl, user, parentInfo] = await Promise.all([
    client.call<AnyObj>('filesystem.stat', [target]),
    client.call<AnyObj>('filesystem.getacl', [target, true, true]),
    username ? lookupUser(client, username) : Promise.resolve(undefined),
    Promise.all(parents.map(async (p) => {
      const pst = await client.call<AnyObj>('filesystem.stat', [p]);
      const pacl = pst['acl'] ? await client.call<AnyObj>('filesystem.getacl', [p, true, true]) : null;
      return { path: p, ...owner(pst), ...(pacl ? { acl: formatAcl(pacl, false) } : {}) };
    })),
  ]);

  return JSON.stringify({
    path: target,
    type: st['type'],
    ...owner(st),
    acl: formatAcl(acl, true),
    parents: parentInfo,
    ...(user ? { user } : {}),
  }, null, 2);
}

// ── registry ───────────────────────────────────────────────────────────────────

export function permissionTools(client: TrueNASClient): ToolDef[] {
  return [
    {
      tool: {
        name: 'path_permissions',
        description: 'Ownership, mode and ACL of a path under /mnt as the NAS sees it (not the SMB/NFS client view), plus owner/mode/ACL of every parent directory, since each must be traversable. POSIX entries use getfacl notation "[default:]tag:who:rwx" ("user::"/"group::" are the owner and owning group). Optionally include a user\'s UID and group memberships to compare against the ACL, e.g. to explain why an SMB user cannot see a folder.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path under /mnt, e.g. "/mnt/media/download/tv"' },
            user: { type: 'string', description: 'Optional NAS username to include, e.g. "smb"' },
          },
          required: ['path'],
        },
        annotations: READ_ONLY,
      },
      handler: (args) => pathPermissions(client, str(args, 'path'), optStr(args, 'user')),
    },
  ];
}
