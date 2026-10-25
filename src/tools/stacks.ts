// Compose stacks: what each stack's compose file declares vs. the containers
// that actually exist, and the compose file itself with secrets redacted.
//
// Files are read from a read-only bind mount of the stacks directory, mounted
// at the same path as on the host so the paths in compose labels resolve.
// Only compose files and .env (key names only) are ever read, and only after
// their real path is confirmed to be inside STACKS_DIR; tool arguments are
// never used as paths.

import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import { DockerClient } from '../docker-client.js';
import { ToolDef, READ_ONLY, str } from './registry.js';
import { HASH_VALUE, primaryName } from './containers.js';
import { redactInlineSecrets } from './utils.js';

type AnyObj = Record<string, unknown>;

const COMPOSE_FILE = /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/;
const DEFAULT_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
// `_USER` / `USERNAME` catch generated credentials such as OPENVPN_USER without
// touching compose's own `user:` key.
const SECRET_KEY = /(pass|pwd|secret|token|key|credential|(basic|digest)auth\.users|_user$|username)/i;

interface Stack {
  name: string;
  files: string[];      // compose files as recorded by compose / found on disk
  envFile: string | null;
  containers: AnyObj[];
}

const label = (c: AnyObj, key: string) => ((c['Labels'] as Record<string, string> | null) ?? {})[key];

// Resolves a file inside the stacks root, or null if it is missing, outside
// the root (also via symlinks) or not an allowed file name.
async function safeFile(root: string, file: string, allowed: (base: string) => boolean): Promise<string | null> {
  try {
    const [real, realRoot] = await Promise.all([realpath(file), realpath(root)]);
    return real.startsWith(realRoot + path.sep) && allowed(path.basename(real)) ? real : null;
  } catch {
    return null;
  }
}

async function discoverStacks(docker: DockerClient, root: string): Promise<Stack[]> {
  const stacks = new Map<string, Stack>();

  for (const c of await docker.containers(true) as AnyObj[]) {
    const project = label(c, 'com.docker.compose.project');
    if (!project) continue;
    let s = stacks.get(project);
    if (!s) {
      const files = (label(c, 'com.docker.compose.project.config_files') ?? '').split(',').filter(Boolean);
      const workDir = label(c, 'com.docker.compose.project.working_dir');
      const envFile = label(c, 'com.docker.compose.project.environment_file') || (workDir ? path.join(workDir, '.env') : null);
      stacks.set(project, s = { name: project, files, envFile, containers: [] });
    }
    s.containers.push(c);
  }

  // Stacks on disk that have no containers at all would otherwise be invisible.
  const known = new Set([...stacks.values()].flatMap((s) => s.files.map((f) => path.resolve(f))));
  const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    const entries = await readdir(dir).catch(() => [] as string[]);
    const file = DEFAULT_FILES.find((f) => entries.includes(f));
    if (!file || known.has(path.join(dir, file))) continue;
    const name = d.name.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!stacks.has(name)) stacks.set(name, { name, files: [path.join(dir, file)], envFile: path.join(dir, '.env'), containers: [] });
  }

  return [...stacks.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function readCompose(root: string, s: Stack): Promise<Array<{ file: string; doc: AnyObj | null; error?: string }>> {
  return Promise.all(s.files.map(async (file) => {
    const real = await safeFile(root, file, (b) => COMPOSE_FILE.test(b));
    if (!real) return { file, doc: null, error: `not readable (outside ${root} or missing)` };
    try {
      return { file, doc: (YAML.parse(await readFile(real, 'utf8'), { merge: true }) ?? {}) as AnyObj };
    } catch (e) {
      return { file, doc: null, error: `invalid YAML: ${e instanceof Error ? e.message : String(e)}` };
    }
  }));
}

// ── stack_list ─────────────────────────────────────────────────────────────────

export async function stackList(docker: DockerClient, root: string): Promise<string> {
  const stacks = await discoverStacks(docker, root);
  if (!stacks.length) return JSON.stringify({ message: 'No compose stacks found.' }, null, 2);

  const result = await Promise.all(stacks.map(async (s) => {
    const files = await readCompose(root, s);
    const readable = files.some((f) => f.doc);
    const declared = new Map<string, AnyObj>();
    for (const f of files) {
      for (const [svc, def] of Object.entries((f.doc?.['services'] as AnyObj | undefined) ?? {})) {
        declared.set(svc, { ...(declared.get(svc) ?? {}), ...(def as AnyObj ?? {}) });
      }
    }

    const byService = new Map<string, AnyObj[]>();
    for (const c of s.containers) {
      const svc = label(c, 'com.docker.compose.service') ?? '?';
      byService.set(svc, [...(byService.get(svc) ?? []), c]);
    }
    const describe = (c: AnyObj) => ({ container: primaryName(c['Names']), state: c['State'], status: c['Status'] });

    const services = [...new Set([...declared.keys(), ...byService.keys()])].sort().map((svc) => {
      const def = declared.get(svc);
      const profiles = def?.['profiles'] as string[] | undefined;
      const containers = byService.get(svc) ?? [];
      return {
        service: svc,
        ...(profiles?.length ? { profiles } : {}),
        containers: containers.map(describe),
      };
    });

    // Services with profiles are not started by default, so they are not "missing".
    const missing = readable
      ? [...declared.entries()].filter(([svc, def]) =>
        !byService.has(svc) && !((def?.['profiles'] as unknown[] | undefined)?.length)).map(([svc]) => svc)
      : [];
    const orphans = readable ? [...byService.keys()].filter((svc) => !declared.has(svc)) : [];

    return {
      stack: s.name,
      compose_files: files.map((f) => (f.error ? `${f.file} (${f.error})` : f.file)),
      services,
      ...(missing.length ? { missing_containers: missing } : {}),
      ...(orphans.length ? { orphan_containers: orphans } : {}),
    };
  }));

  return JSON.stringify(result, null, 2);
}

// ── stack_compose ──────────────────────────────────────────────────────────────

// Masks scalar values under secret-looking keys (environment, labels, …),
// `KEY=value` list entries with secret-looking keys, password hashes, URL
// credentials and `--password x` style arguments. Pure `${VAR}` references
// are kept: they only name a variable from .env.
function redact(val: unknown, key = ''): unknown {
  if (Array.isArray(val)) {
    return val.map((v) => {
      if (typeof v !== 'string') return redact(v);
      const eq = v.indexOf('=');
      return eq > 0 && SECRET_KEY.test(v.slice(0, eq)) && !/^\$\{[^}]+\}$/.test(v.slice(eq + 1))
        ? `${v.slice(0, eq)}=[redacted]` : redact(v);
    });
  }
  if (val && typeof val === 'object') {
    return Object.fromEntries(Object.entries(val as AnyObj).map(([k, v]) => [k, redact(v, k)]));
  }
  if (typeof val === 'string' || typeof val === 'number') {
    const s = String(val);
    if (/^\$\{[^}]+\}$/.test(s)) return val;
    if ((key && SECRET_KEY.test(key)) || HASH_VALUE.test(s)) return '[redacted]';
    return typeof val === 'string' ? redactInlineSecrets(val) : val;
  }
  return val;
}

export async function stackCompose(docker: DockerClient, root: string, name: string): Promise<string> {
  const stacks = await discoverStacks(docker, root);
  const s = stacks.find((x) => x.name === name) ?? stacks.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!s) throw new Error(`Stack '${name}' not found. Available: ${stacks.map((x) => x.name).join(', ') || 'none'}`);

  const parts: string[] = [];
  for (const f of await readCompose(root, s)) {
    if (!f.doc) {
      parts.push(`# ${f.file}: ${f.error}`);
      continue;
    }
    parts.push(`# ${f.file} (secret values redacted, comments not shown)\n${YAML.stringify(redact(f.doc), { lineWidth: 0 })}`);
  }

  const env = s.envFile ? await safeFile(root, s.envFile, (b) => b === '.env') : null;
  if (env) {
    const keys = (await readFile(env, 'utf8')).split('\n')
      .map((l) => l.trim().replace(/^export\s+/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1])
      .filter(Boolean);
    parts.push(`# ${s.envFile}: values are never shown; defined variables:\n# ${keys.join(', ') || '(none)'}`);
  }

  return parts.join('\n\n');
}

// ── registry ───────────────────────────────────────────────────────────────────

export function stackTools(docker: DockerClient, root: string): ToolDef[] {
  return [
    {
      tool: {
        name: 'stack_list',
        description: 'All Docker Compose stacks (from container labels and the stacks directory): each declared service with its container(s) and state, `missing_containers` (declared in the compose file but no container exists, e.g. lost during a redeploy) and `orphan_containers` (container of the stack whose service is no longer declared). Services with profiles are not counted as missing.',
        inputSchema: { type: 'object', properties: {} },
        annotations: READ_ONLY,
      },
      handler: () => stackList(docker, root),
    },
    {
      tool: {
        name: 'stack_compose',
        description: 'The compose file(s) of one stack as YAML, with secret values (passwords, tokens, keys, htpasswd hashes, URL credentials) redacted and ${VAR} references kept. For the stack\'s .env file only the variable names are listed, never values.',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string', description: 'Stack (compose project) name as shown in stack_list' } },
          required: ['name'],
        },
        annotations: READ_ONLY,
      },
      handler: (args) => stackCompose(docker, root, str(args, 'name')),
    },
  ];
}
