// Image update checks and in-place container updates via the Docker API.
//
// Containers are recreated from their own inspect output (no compose files
// needed), like Dockhand/Watchtower, with two of their known pitfalls handled:
// auto-assigned MACs are never copied, and containers sharing the target's
// network namespace (network_mode: service:X / container:X) are recreated
// with it.
//
// Rollback rule: the old container is only restored automatically when the new
// version provably never ran (create or start refused by Docker). Once the new
// process has run it may have migrated data, so nothing is rolled back or
// stopped — the old container is kept and the decision is left to a human
// (container_rollback).

import { DockerClient, normalizeRef } from '../docker-client.js';
import { ToolDef, ToolArgs, str } from './registry.js';
import { isSelf, primaryName, resolveContainer } from './containers.js';
import { formatBytes } from './utils.js';

type AnyObj = Record<string, unknown>;

const DEFAULT_HEALTH_TIMEOUT_SEC = 120;
const STABLE_WITHOUT_HEALTHCHECK_MS = 10_000;

function log(msg: string) {
  process.stderr.write(`[truenas-mcp] [update] ${msg}\n`);
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isPinned = (ref: string) => ref.includes('@');
const isImageId = (ref: string) => /^(sha256:)?[0-9a-f]{12,64}$/.test(ref);
const nameOf = (ins: AnyObj) => String(ins['Name'] ?? '').replace(/^\//, '');
const shortImage = (id: string) => id.replace(/^sha256:/, '').slice(0, 12);
const timestamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ── update_check ───────────────────────────────────────────────────────────────

type CheckStatus = 'update_available' | 'up_to_date' | 'pinned' | 'local_only' | 'unknown' | 'error';
const CHECK_ORDER: CheckStatus[] = ['update_available', 'error', 'unknown', 'local_only', 'pinned', 'up_to_date'];

export async function updateCheck(docker: DockerClient): Promise<string> {
  const list = await docker.containers(true) as AnyObj[];
  const remote = new Map<string, Promise<string>>();

  const results = await mapLimit(list, 4, async (c) => {
    const ins = await docker.inspectContainer(String(c['Id'])) as AnyObj;
    const ref = String((ins['Config'] as AnyObj | undefined)?.['Image'] ?? '');
    const entry: AnyObj = {
      container: nameOf(ins),
      image: ref,
      state: (ins['State'] as AnyObj | undefined)?.['Status'],
    };
    const done = (status: CheckStatus, extra: AnyObj = {}): AnyObj & { status: CheckStatus } =>
      ({ ...entry, status, ...extra });

    if (isImageId(ref)) return done('unknown', { note: 'Created from an image ID, not a tag.' });
    if (isPinned(ref)) return done('pinned', { note: 'Pinned to a digest; it never changes.' });

    try {
      // Compare against the image the container actually runs, not whatever
      // the tag points to locally (it may have been pulled but not deployed).
      const img = await docker.inspectImage(String(ins['Image']));
      const local = ((img['RepoDigests'] as string[] | null) ?? []).map((d) => d.split('@')[1]);
      if (!local.length) return done('local_only', { note: 'Image has no registry digest (built or loaded locally).' });

      const key = normalizeRef(ref);
      if (!remote.has(key)) remote.set(key, docker.registryDigest(key));
      const digest = await remote.get(key)!;
      const status: CheckStatus = local.includes(digest) ? 'up_to_date' : 'update_available';
      return done(status, isSelf(String(ins['Id'])) && status === 'update_available'
        ? { note: 'This is the MCP server itself — update it via Dockge.' }
        : {});
    } catch (e) {
      return done('error', { error: errMsg(e) });
    }
  });

  results.sort((a, b) =>
    CHECK_ORDER.indexOf(a.status) - CHECK_ORDER.indexOf(b.status) ||
    String(a['container']).localeCompare(String(b['container'])));

  const summary = Object.fromEntries(CHECK_ORDER.map((s) => [s, results.filter((r) => r.status === s).length]).filter(([, n]) => n));
  return JSON.stringify({ summary, containers: results }, null, 2);
}

// ── create-body construction ──────────────────────────────────────────────────

function endpointConfig(network: string, ep: AnyObj, containerId: string): AnyObj {
  const out: AnyObj = {};
  if (ep['IPAMConfig']) out['IPAMConfig'] = ep['IPAMConfig'];
  if (ep['Links']) out['Links'] = ep['Links'];
  if (ep['DriverOpts']) out['DriverOpts'] = ep['DriverOpts'];
  // Never copy MacAddress: it is derived from the old IP (Dockhand #1618).
  const aliases = ((ep['Aliases'] as string[] | null) ?? [])
    .filter((a) => a !== containerId && a !== containerId.slice(0, 12));
  if (aliases.length && network !== 'bridge') out['Aliases'] = aliases;
  return out;
}

// Builds a /containers/create body that reproduces `ins` on its image tag.
// Inspect output has the *old image's* defaults merged in (ENV, labels, CMD, …);
// copying those would pin them onto the new image, so they are dropped and the
// new image supplies its own.
export function buildCreateBody(
  ins: AnyObj,
  oldImage: AnyObj,
  opts: { networkMode?: string; newImageId?: string } = {},
): AnyObj {
  const id = String(ins['Id']);
  const cfg = structuredClone((ins['Config'] as AnyObj | undefined) ?? {});
  const hc = structuredClone((ins['HostConfig'] as AnyObj | undefined) ?? {});
  const img = (oldImage['Config'] as AnyObj | undefined) ?? {};

  const imgEnv = new Set((img['Env'] as string[] | null) ?? []);
  cfg['Env'] = ((cfg['Env'] as string[] | null) ?? []).filter((e) => !imgEnv.has(e));

  const imgLabels = (img['Labels'] as Record<string, string> | null) ?? {};
  const labels = Object.fromEntries(
    Object.entries((cfg['Labels'] as Record<string, string> | null) ?? {}).filter(([k, v]) => imgLabels[k] !== v),
  );
  if (opts.newImageId && 'com.docker.compose.image' in labels) labels['com.docker.compose.image'] = opts.newImageId;
  cfg['Labels'] = labels;

  // A custom entrypoint stops Docker from inheriting the image CMD, so CMD may
  // only be dropped together with a default entrypoint.
  if (same(cfg['Entrypoint'], img['Entrypoint'])) {
    delete cfg['Entrypoint'];
    if (same(cfg['Cmd'], img['Cmd'])) delete cfg['Cmd'];
  }
  for (const k of ['WorkingDir', 'User', 'Healthcheck', 'StopSignal', 'Shell', 'OnBuild']) {
    if (same(cfg[k], img[k])) delete cfg[k];
  }
  for (const k of ['ExposedPorts', 'Volumes']) {
    const fromImage = (img[k] as AnyObj | null) ?? {};
    const own = Object.keys((cfg[k] as AnyObj | null) ?? {}).filter((p) => !(p in fromImage));
    if (own.length) cfg[k] = Object.fromEntries(own.map((p) => [p, {}]));
    else delete cfg[k];
  }
  if (cfg['Hostname'] === id.slice(0, 12)) delete cfg['Hostname'];
  delete cfg['MacAddress'];

  // Re-attach anonymous volumes by name; otherwise the new container would get
  // fresh empty ones (e.g. a database whose data dir is only an image VOLUME).
  const binds = (hc['Binds'] as string[] | null) ?? [];
  const mounts = (hc['Mounts'] as AnyObj[] | null) ?? [];
  const covered = new Set([...binds.map((b) => b.split(':')[1]), ...mounts.map((m) => m['Target'])]);
  const anonymous = ((ins['Mounts'] as AnyObj[] | null) ?? []).filter((m) =>
    m['Type'] === 'volume' && /^[0-9a-f]{64}$/.test(String(m['Name'])) && !covered.has(m['Destination']));
  if (anonymous.length) {
    hc['Mounts'] = [...mounts, ...anonymous.map((m) => ({ Type: 'volume', Source: m['Name'], Target: m['Destination'] }))];
  }

  const mode = opts.networkMode ?? String(hc['NetworkMode'] ?? 'default');
  hc['NetworkMode'] = mode;
  let networking: AnyObj | undefined;

  if (mode.startsWith('container:')) {
    // Docker rejects these together with a shared network namespace.
    for (const k of ['Hostname', 'Domainname', 'ExposedPorts']) delete cfg[k];
    for (const k of ['PortBindings', 'Links', 'Dns', 'DnsSearch', 'DnsOptions', 'ExtraHosts']) delete hc[k];
    hc['PublishAllPorts'] = false;
  } else if (mode !== 'host' && mode !== 'none') {
    const nets = ((ins['NetworkSettings'] as AnyObj | undefined)?.['Networks'] as Record<string, AnyObj> | null) ?? {};
    networking = {
      EndpointsConfig: Object.fromEntries(Object.entries(nets).map(([n, ep]) => [n, endpointConfig(n, ep, id)])),
    };
  }

  return { ...cfg, HostConfig: hc, ...(networking ? { NetworkingConfig: networking } : {}) };
}

// ── health verification ────────────────────────────────────────────────────────

async function waitHealthy(docker: DockerClient, id: string, timeoutSec: number): Promise<{ ok: boolean; reason: string }> {
  const start = Date.now();
  for (;;) {
    await sleep(2_000);
    const ins = await docker.inspectContainer(id) as AnyObj;
    const st = (ins['State'] as AnyObj | undefined) ?? {};
    const health = (st['Health'] as AnyObj | undefined)?.['Status'] as string | undefined;
    const elapsed = Date.now() - start;

    if (st['Status'] === 'exited' || st['Status'] === 'dead') {
      return { ok: false, reason: `exited with code ${st['ExitCode']}` };
    }
    if (st['Restarting'] || Number(ins['RestartCount'] ?? 0) > 0) {
      return { ok: false, reason: 'crash-looping (restarted by its restart policy)' };
    }
    if (health === 'healthy') return { ok: true, reason: 'healthy' };
    if (health === 'unhealthy') return { ok: false, reason: 'healthcheck reports unhealthy' };
    if (!health && elapsed >= STABLE_WITHOUT_HEALTHCHECK_MS) {
      return { ok: true, reason: `running for ${STABLE_WITHOUT_HEALTHCHECK_MS / 1000}s (no healthcheck)` };
    }
    if (elapsed >= timeoutSec * 1000) {
      return { ok: false, reason: `not healthy after ${timeoutSec}s (health: ${health ?? 'n/a'})` };
    }
  }
}

// ── container_update ───────────────────────────────────────────────────────────

type Outcome = 'updated' | 'up_to_date' | 'skipped' | 'failed' | 'failed_rolled_back' | 'failed_after_start';

interface UpdateResult {
  container: string;
  outcome: Outcome;
  detail: string;
  old_image?: string;
  new_image?: string;
  old_container_kept_as?: string;
  logs_tail?: string;
  dependents?: UpdateResult[];
}

interface UpdateOptions {
  force: boolean;
  keepOld: boolean;
  healthTimeoutSec: number;
}

// Recreates a container that shares `providerId`'s network namespace.
async function recreateDependent(
  docker: DockerClient,
  dep: AnyObj,
  providerId: string,
  opts: UpdateOptions,
): Promise<UpdateResult & { oldId?: string }> {
  const name = nameOf(dep);
  const id = String(dep['Id']);
  const wasRunning = Boolean((dep['State'] as AnyObj | undefined)?.['Running']);
  const body = buildCreateBody(dep, await docker.inspectImage(String(dep['Image'])), {
    networkMode: `container:${providerId}`,
  });

  const oldName = `${name}-old-${timestamp()}`;
  await docker.renameContainer(id, oldName);

  let newId: string;
  try {
    newId = await docker.createContainer(name, body);
  } catch (e) {
    await docker.renameContainer(id, name).catch(() => {});
    return { container: name, outcome: 'failed', detail: `Creating the replacement failed (${errMsg(e)}). The old container is kept but stays stopped: its network provider was replaced.` };
  }

  if (wasRunning) {
    try {
      await docker.start(newId);
    } catch (e) {
      await docker.removeContainer(newId).catch(() => {});
      await docker.renameContainer(id, name).catch(() => {});
      return { container: name, outcome: 'failed', detail: `Starting the replacement failed (${errMsg(e)}); it never ran and was removed. The old container is kept but stays stopped: its network provider was replaced.` };
    }
    const health = await waitHealthy(docker, newId, opts.healthTimeoutSec);
    if (!health.ok) {
      return {
        container: name,
        outcome: 'failed_after_start',
        detail: `${health.reason}. Left as-is; old container kept as "${oldName}".`,
        old_container_kept_as: oldName,
        logs_tail: await docker.logs(newId, 30).catch(() => ''),
      };
    }
  }

  return { container: name, outcome: 'updated', detail: 'Recreated on the new network namespace.', oldId: id };
}

async function updateOne(docker: DockerClient, id: string, opts: UpdateOptions): Promise<UpdateResult> {
  const ins = await docker.inspectContainer(id) as AnyObj;
  const name = nameOf(ins);
  const cfg = (ins['Config'] as AnyObj | undefined) ?? {};
  const ref = String(cfg['Image'] ?? '');
  const skip = (detail: string): UpdateResult => ({ container: name, outcome: 'skipped', detail });

  if (isSelf(id)) return skip('This is the MCP server\'s own container — update it via Dockge.');
  if (isImageId(ref)) return skip(`Created from an image ID (${ref}), not a tag; nothing to pull.`);

  const oldImageId = String(ins['Image']);
  if (!isPinned(ref)) await docker.pullImage(ref);
  const newImageId = String((await docker.inspectImage(normalizeRef(ref)))['Id']);

  if (newImageId === oldImageId && !opts.force) {
    return { container: name, outcome: 'up_to_date', detail: 'Already running the latest image.' };
  }

  const images = { old_image: shortImage(oldImageId), new_image: shortImage(newImageId) };
  const body = buildCreateBody(ins, await docker.inspectImage(oldImageId), { newImageId });

  // Containers sharing this one's network namespace must follow it (Dockhand #991).
  const all = await docker.containers(true) as AnyObj[];
  const deps = await Promise.all(
    all.filter((c) => (c['HostConfig'] as AnyObj | undefined)?.['NetworkMode'] === `container:${id}`)
      .map((c) => docker.inspectContainer(String(c['Id'])) as Promise<AnyObj>),
  );
  const depRunning = deps.map((d) => Boolean((d['State'] as AnyObj | undefined)?.['Running']));
  const wasRunning = Boolean((ins['State'] as AnyObj | undefined)?.['Running']);
  const oldName = `${name}-old-${timestamp()}`;

  const startDeps = async () => {
    for (const [i, d] of deps.entries()) {
      if (depRunning[i]) await docker.start(String(d['Id'])).catch(() => {});
    }
  };

  // Every step up to a successful `start` leaves the new version un-run, so a
  // failure there is undone completely; `phase` records how far we got.
  let phase: 'running' | 'stopped' | 'renamed' | 'created' = 'running';
  let newId = '';
  try {
    log(`${name}: ${images.old_image} → ${images.new_image}${deps.length ? ` (+${deps.length} dependent)` : ''}`);
    for (const [i, d] of deps.entries()) {
      if (depRunning[i]) await docker.stop(String(d['Id']), (d['Config'] as AnyObj | undefined)?.['StopTimeout'] as number | undefined);
    }
    if (wasRunning) await docker.stop(id, cfg['StopTimeout'] as number | undefined);
    phase = 'stopped';

    await docker.renameContainer(id, oldName);
    phase = 'renamed';

    newId = await docker.createContainer(name, body);
    phase = 'created';

    if (wasRunning) await docker.start(newId);
  } catch (e) {
    const reason = errMsg(e);
    try {
      if (phase === 'created') await docker.removeContainer(newId);
      if (phase === 'created' || phase === 'renamed') await docker.renameContainer(id, name);
      if (phase !== 'running' && wasRunning) await docker.start(id);
      await startDeps();
    } catch (restoreErr) {
      log(`${name}: RESTORE FAILED: ${errMsg(restoreErr)}`);
      return { container: name, outcome: 'failed', ...images, detail: `Update failed (${reason}) and restoring the old container also failed (${errMsg(restoreErr)}). Check "${name}" / "${oldName}" manually.` };
    }
    log(`${name}: failed before the new version ran (${reason}); old container restored`);
    return {
      container: name,
      outcome: phase === 'running' ? 'failed' : 'failed_rolled_back',
      ...images,
      detail: phase === 'running'
        ? `Stopping failed (${reason}); nothing was changed.`
        : `The new version never ran (${reason}), so the old container was restored safely.`,
    };
  }

  if (!wasRunning) {
    // Nothing ran; mirror the old state (stopped) and don't touch dependents.
    if (!opts.keepOld) await docker.removeContainer(id).catch(() => {});
    return { container: name, outcome: 'updated', ...images, detail: 'Recreated on the new image but not started (it was stopped before).', ...(opts.keepOld ? { old_container_kept_as: oldName } : {}) };
  }

  const health = await waitHealthy(docker, newId, opts.healthTimeoutSec);
  if (!health.ok) {
    // The new version has run and may already have migrated data: leave it
    // exactly as it is (not even stopped — it might still be migrating).
    log(`${name}: new version ${health.reason}; NOT rolling back, old kept as ${oldName}`);
    return {
      container: name,
      outcome: 'failed_after_start',
      ...images,
      detail: `New version ${health.reason}. It was NOT rolled back or stopped, because it has already run and may have migrated data. The old container is kept (stopped) as "${oldName}". Check the logs, then fix forward or use container_rollback deliberately.`,
      old_container_kept_as: oldName,
      logs_tail: await docker.logs(newId, 30).catch(() => ''),
      ...(deps.length ? { dependents: deps.map((d) => ({ container: nameOf(d), outcome: 'skipped' as const, detail: 'Left stopped: its network provider failed to come up.' })) } : {}),
    };
  }

  const depResults: Array<UpdateResult & { oldId?: string }> = [];
  for (const d of deps) {
    depResults.push(await recreateDependent(docker, d, newId, opts).catch((e) =>
      ({ container: nameOf(d), outcome: 'failed' as const, detail: errMsg(e) })));
  }
  const depsOk = depResults.every((r) => r.outcome === 'updated');

  // Old containers are only deleted once everything is confirmed working.
  const keep = opts.keepOld || !depsOk;
  if (!keep) {
    await docker.removeContainer(id).catch((e) => log(`${name}: could not remove ${oldName}: ${errMsg(e)}`));
    for (const r of depResults) if (r.oldId) await docker.removeContainer(r.oldId).catch(() => {});
  }

  log(`${name}: updated (${health.reason})`);
  return {
    container: name,
    outcome: 'updated',
    ...images,
    detail: `Updated; ${health.reason}.${depsOk ? '' : ' Some dependents failed — see below.'}`,
    ...(keep ? { old_container_kept_as: oldName } : {}),
    ...(depResults.length ? { dependents: depResults.map(({ oldId: _, ...r }) => r) } : {}),
  };
}

let updateInProgress = false;

async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (updateInProgress) throw new Error('Another update or rollback is already running; try again when it has finished.');
  updateInProgress = true;
  try {
    return await fn();
  } finally {
    updateInProgress = false;
  }
}

export async function containerUpdate(
  docker: DockerClient,
  target: string,
  opts: UpdateOptions,
  exclude: string[] = [],
): Promise<string> {
  return exclusive(async () => {
    if (target !== 'all') {
      const match = await resolveContainer(docker, target);
      if (!match) return JSON.stringify({ error: `Container '${target}' not found.` }, null, 2);
      return JSON.stringify(await updateOne(docker, String(match['Id']), opts), null, 2);
    }

    const list = await docker.containers(true) as AnyObj[];
    const running = list.filter((c) => c['State'] === 'running');
    const sharesNetwork = (c: AnyObj) => String((c['HostConfig'] as AnyObj | undefined)?.['NetworkMode'] ?? '').startsWith('container:');
    // Network providers first; dependents are looked up again by name afterwards
    // because recreating their provider gives them new IDs.
    const names = [...running.filter((c) => !sharesNetwork(c)), ...running.filter(sharesNetwork)]
      .map((c) => primaryName(c['Names']));

    const skipNames = new Set(exclude);
    const results: UpdateResult[] = [];
    for (const name of names) {
      if (skipNames.has(name)) {
        results.push({ container: name, outcome: 'skipped', detail: 'Excluded.' });
        continue;
      }
      const match = await resolveContainer(docker, name);
      if (!match) continue;
      results.push(await updateOne(docker, String(match['Id']), opts).catch((e) =>
        ({ container: name, outcome: 'failed' as const, detail: errMsg(e) })));
    }

    const counts = results.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {});
    const order: Outcome[] = ['failed_after_start', 'failed', 'failed_rolled_back', 'updated', 'skipped', 'up_to_date'];
    results.sort((a, b) => order.indexOf(a.outcome) - order.indexOf(b.outcome));
    return JSON.stringify({ summary: counts, containers: results }, null, 2);
  });
}

// ── container_rollback ─────────────────────────────────────────────────────────

export async function containerRollback(docker: DockerClient, nameOrId: string): Promise<string> {
  return exclusive(async () => {
    const match = await resolveContainer(docker, nameOrId);
    if (!match) return JSON.stringify({ error: `Container '${nameOrId}' not found.` }, null, 2);

    const curId = String(match['Id']);
    const name = primaryName(match['Names']);
    if (isSelf(curId)) throw new Error('Refusing to roll back the container running this MCP server.');
    if (/-(old|failed)-\d{8}T\d{6}$/.test(name)) {
      throw new Error(`Pass the current container's name (e.g. "${name.replace(/-(old|failed)-\d{8}T\d{6}$/, '')}"), not a kept old/failed one.`);
    }

    const pattern = new RegExp(`^${escapeRegex(name)}-old-(\\d{8}T\\d{6})$`);
    const all = await docker.containers(true) as AnyObj[];
    const old = all
      .filter((c) => pattern.test(primaryName(c['Names'])))
      .sort((a, b) => primaryName(b['Names']).localeCompare(primaryName(a['Names'])))[0];
    if (!old) {
      throw new Error(`No "${name}-old-<timestamp>" container to roll back to. Old containers are only kept after a failed update or with keep_old.`);
    }

    const oldId = String(old['Id']);
    const oldName = primaryName(old['Names']);
    const failedName = `${name}-failed-${timestamp()}`;
    const steps: string[] = [];
    try {
      if (match['State'] === 'running') {
        await docker.stop(curId);
        steps.push(`stopped ${name}`);
      }
      await docker.renameContainer(curId, failedName);
      steps.push(`renamed ${name} → ${failedName}`);
      await docker.renameContainer(oldId, name);
      steps.push(`renamed ${oldName} → ${name}`);
      await docker.start(oldId);
      steps.push(`started ${name}`);
      // Dependents still attached to the old container's namespace.
      for (const c of all.filter((c) => (c['HostConfig'] as AnyObj | undefined)?.['NetworkMode'] === `container:${oldId}`)) {
        await docker.start(String(c['Id'])).catch(() => {});
        steps.push(`started dependent ${primaryName(c['Names'])}`);
      }
    } catch (e) {
      throw new Error(`Rollback stopped after: ${steps.join('; ') || 'nothing'}. Error: ${errMsg(e)}. Nothing was deleted.`);
    }

    log(`${name}: rolled back to ${oldName}; failed version kept as ${failedName}`);
    const health = await waitHealthy(docker, oldId, DEFAULT_HEALTH_TIMEOUT_SEC);
    return JSON.stringify({
      container: name,
      rolled_back_to: oldName,
      failed_version_kept_as: failedName,
      steps,
      health: health.reason,
      note: 'Nothing was deleted. If the failed version migrated data, the old version may not work with it — check its logs.',
    }, null, 2);
  });
}

// ── image_prune ────────────────────────────────────────────────────────────────

export async function imagePrune(docker: DockerClient, all: boolean): Promise<string> {
  const res = await docker.pruneImages(all);
  const deleted = res.ImagesDeleted ?? [];
  const untagged = deleted.map((d) => d['Untagged']).filter(Boolean);
  return JSON.stringify({
    mode: all ? 'all unused images' : 'dangling images only',
    images_deleted: deleted.filter((d) => d['Deleted']).length,
    untagged: untagged.slice(0, 50),
    space_reclaimed: formatBytes(res.SpaceReclaimed ?? 0),
  }, null, 2);
}

// ── registry ───────────────────────────────────────────────────────────────────

function updateOptions(args: ToolArgs): UpdateOptions {
  const t = Number(args['health_timeout']);
  return {
    force: args['force'] === true,
    keepOld: args['keep_old'] === true,
    healthTimeoutSec: Number.isFinite(t) && t > 0 ? Math.min(Math.floor(t), 900) : DEFAULT_HEALTH_TIMEOUT_SEC,
  };
}

export function updateTools(docker: DockerClient, opts: { write: boolean }): ToolDef[] {
  const read: ToolDef[] = [
    {
      tool: {
        name: 'update_check',
        description: 'Check every Docker container for a newer image: compares the digest of the image each container runs with the registry\'s current digest for its tag. Read-only.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      handler: () => updateCheck(docker),
    },
  ];

  if (!opts.write) return read;

  return [
    ...read,
    {
      tool: {
        name: 'container_update',
        description: 'Update a container (or "all" running containers) to the newest image of its tag: pull, recreate with the same configuration, verify it comes up healthy. Containers sharing its network (network_mode: service:X) are recreated with it. If Docker refuses to create/start the new version it never ran, so the old container is restored. If the new version starts and then fails, it is NOT rolled back (it may have migrated data); the old container is kept stopped as "<name>-old-<timestamp>" for container_rollback. Skips the MCP server\'s own container. Updating the reverse proxy in front of this server drops the MCP connection; results are also written to the truenas-mcp container log.',
        inputSchema: {
          type: 'object',
          properties: {
            name_or_id: { type: 'string', description: 'Container name or short ID, or "all" for every running container' },
            force: { type: 'boolean', description: 'Recreate even if the image is unchanged (default false)', default: false },
            keep_old: { type: 'boolean', description: 'Keep the old container (stopped) after a successful update, enabling container_rollback (default false)', default: false },
            health_timeout: { type: 'number', description: `Seconds to wait for a healthcheck to pass (default ${DEFAULT_HEALTH_TIMEOUT_SEC}, max 900)`, default: DEFAULT_HEALTH_TIMEOUT_SEC },
            exclude: { type: 'array', items: { type: 'string' }, description: 'Container names to skip when name_or_id is "all"' },
          },
          required: ['name_or_id'],
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      handler: (args) => containerUpdate(
        docker,
        str(args, 'name_or_id'),
        updateOptions(args),
        Array.isArray(args['exclude']) ? args['exclude'].map(String) : [],
      ),
    },
    {
      tool: {
        name: 'container_rollback',
        description: 'Roll a container back to the "<name>-old-<timestamp>" container kept by container_update. Deletes nothing: the current container is stopped and kept as "<name>-failed-<timestamp>". WARNING: if the newer version already migrated data (e.g. a database schema), the old version may fail or damage that data — only use this when you know the data is compatible.',
        inputSchema: {
          type: 'object',
          properties: { name_or_id: { type: 'string', description: 'Name or short ID of the current (new) container' } },
          required: ['name_or_id'],
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      handler: (args) => containerRollback(docker, str(args, 'name_or_id')),
    },
    {
      tool: {
        name: 'image_prune',
        description: 'Delete unused Docker images. By default only dangling (untagged) images; with all=true every image not used by any container. Images built locally cannot be pulled back.',
        inputSchema: {
          type: 'object',
          properties: { all: { type: 'boolean', description: 'Remove all unused images, not just dangling ones (default false)', default: false } },
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      handler: (args) => imagePrune(docker, args['all'] === true),
    },
  ];
}
