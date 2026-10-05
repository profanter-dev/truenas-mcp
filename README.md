# truenas-mcp

**MCP server for TrueNAS SCALE 25.10+ and the Docker containers running on it.** Runs as a container on the NAS and serves MCP over Streamable HTTP. Talks to TrueNAS via the JSON-RPC 2.0 WebSocket API and to Docker via the local socket.

> **Why this exists:** The official `truenas/truenas-mcp` binary uses the legacy DDP protocol, which was removed in TrueNAS 25.10. This server targets the new `wss://host/api/current` JSON-RPC 2.0 endpoint exclusively.

> **Read-only by default.** All TrueNAS tools are read-only. Docker write tools (start/stop/restart, update/rollback, image pull/prune) exist but are only registered when `DOCKER_WRITE_TOOLS=true`.

> **Upgrading from 1.x?** The npm package `@profanter-dev/truenas-mcp` (stdio, `npx`) is deprecated. 2.x ships only as the container image `ghcr.io/profanter-dev/truenas-mcp` — see [Migrating from 1.x](#migrating-from-1x).

---

## Requirements

- TrueNAS SCALE 25.10 or later, with Docker (e.g. stacks managed by Dockge)
- A TrueNAS API key (generate in **System → API Keys**)

---

## Deploy

Deploy as a Dockge stack (or plain `docker compose`) on the NAS. A full example with Traefik labels is in [`compose.example.yml`](compose.example.yml):

```yaml
services:
  truenas-mcp:
    image: ghcr.io/profanter-dev/truenas-mcp:latest
    restart: unless-stopped
    environment:
      TRUENAS_HOST: 192.168.1.29:444
      TRUENAS_API_KEY: ${TRUENAS_API_KEY}
      TRUENAS_INSECURE: "true"
      MCP_AUTH_TOKEN: ${MCP_AUTH_TOKEN}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /proc:/host/proc:ro   # optional: host processes for process_list
    group_add:
      - ${DOCKER_GID}   # stat -c %g /var/run/docker.sock
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
```

The image runs as the unprivileged `node` user; `group_add` gives it access to the Docker socket. Generate the bearer token with `openssl rand -hex 32`.

`GET /healthz` (unauthenticated) reports `{ truenas, docker, version }` and backs the image's `HEALTHCHECK`.

---

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `TRUENAS_HOST` | ✓ | | `host:port` of the TrueNAS web UI, e.g. `192.168.1.29:444` |
| `TRUENAS_API_KEY` | ✓ | | TrueNAS API key |
| `TRUENAS_INSECURE` | | `false` | `true` to skip TLS certificate verification (self-signed certs) |
| `MCP_AUTH_TOKEN` | ✓ | | Bearer token clients must send to `/mcp` |
| `PORT` | | `3000` | HTTP port |
| `DOCKER_SOCKET` | | `/var/run/docker.sock` | Container tools are disabled if the socket is missing |
| `DOCKER_WRITE_TOOLS` | | `false` | `true` registers the Docker write tools (see below) |
| `HOST_PROC` | | `/host/proc` | Where the host's `/proc` is mounted read-only; enables host-wide `process_list` |

---

## Claude Code setup

```bash
claude mcp add --transport http truenas https://truenas-mcp.example.com/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

Or on the LAN without Traefik, publish the port (`ports: ["3000:3000"]`) and use `http://<nas-ip>:3000/mcp`.

---

## Tools

All entities follow a consistent **list / details** pattern.

### Storage

| Tool | Description |
|---|---|
| `pool_list` | All ZFS pools — health, status, usable capacity (used + available) |
| `pool_details` | Single pool: health, capacity, last scrub |
| `disk_list` | All disks — model, type, pool assignment, temperature, SMART result, ZFS error counts |
| `disk_details` | Single disk: serial, size, temperature, full SMART history, vdev assignment, ZFS errors |
| `dataset_list` | All ZFS datasets with used/available space; optionally filter by pool |
| `dataset_details` | Full properties for a single dataset: compression, dedup, quota, and more |
| `snapshot_list` | ZFS snapshots ordered newest-first; filter by dataset, configurable limit, boot-pool excluded by default |
| `snapshot_details` | Single snapshot: size, referenced, compression ratio, clones |

### Shares

| Tool | Description |
|---|---|
| `share_list` | All SMB and NFS shares — path, enabled state, comment |
| `share_details` | Full config for a single SMB or NFS share |

### Services

| Tool | Description |
|---|---|
| `service_list` | All TrueNAS services with running state and boot-enable flag |
| `service_details` | Single service state plus service-specific config (e.g. SSH port and auth settings, SMB workgroup, NFS settings). Private/public key material is stripped. |

### System

| Tool | Description |
|---|---|
| `system_info` | Hostname, version, CPU, memory, uptime, load average (1/5/15 min), timezone |

### Apps

| Tool | Description |
|---|---|
| `app_list` | All installed TrueNAS catalog apps with state, version, and update availability |
| `app_details` | Single app: state, version, portals, active workloads, notes |
| `app_logs` | Recent log output for a TrueNAS catalog app |

> **Note:** These tools cover apps installed via the TrueNAS Apps UI (catalog apps). Docker Compose stacks managed by external tools such as Dockge are not visible through the TrueNAS WebSocket API — use the container tools below instead.

### Docker containers

| Tool | Description |
|---|---|
| `container_list` | All Docker containers (running and stopped) — name, image, state, health |
| `container_details` | Single container: image, state, ports, mounts, networks, labels. Secret env vars are redacted. |
| `container_logs` | Recent log output for a container; configurable line count (default 100) |

Registered when the Docker socket is mounted.

### Updates

| Tool | Description |
|---|---|
| `update_check` | For every container, compares the digest of the image it runs with the registry's current digest for its tag. Read-only. |

### Diagnostics

| Tool | Description |
|---|---|
| `container_stats` | Live usage per running container, sorted by CPU: CPU % (100 = one core), memory working set / page cache / limit, PIDs, network and disk IO rates and totals |
| `process_list` | Top processes by current CPU or memory, each attributed to its container or `host`; CPU summed per container; host summary with CPU breakdown (user/system/iowait/steal), load, memory incl. **ZFS ARC**, swap, pressure stall info, uninterruptible/zombie counts. Command lines are redacted. |

`process_list` needs the host's `/proc` mounted read-only (`/proc:/host/proc:ro`). Without it, it falls back to per-container `ps` output (container processes only, lifetime-average CPU).

### Docker write tools *(opt-in: `DOCKER_WRITE_TOOLS=true`)*

| Tool | Description |
|---|---|
| `container_start` | Start a stopped container |
| `container_stop` | Stop a container (optional graceful `timeout`) |
| `container_restart` | Restart a container (optional graceful `timeout`) |
| `image_pull` | Pull the latest version of a container's image without recreating it |
| `container_update` | Update one container or `all` running ones: pull, recreate with the same configuration, verify health (see below) |
| `container_rollback` | Swap back to the old container kept by a failed update (or `keep_old`). Deletes nothing. |
| `image_prune` | Delete dangling images, or with `all=true` every unused image |

Stop/restart/update refuse to act on the MCP server's own container. Write tools carry MCP `destructiveHint` annotations so clients can ask for confirmation.

#### How `container_update` works

Containers are recreated from their own configuration via the Docker API — no compose files needed, and Dockge still sees them as part of their stack:

1. Pull the tag; stop if the image is unchanged (unless `force`).
2. Build the new container from the old one's config, dropping values inherited from the *old* image (ENV, labels, CMD, …) so the new image's defaults apply. Auto-assigned MAC addresses and hostnames are not copied; anonymous volumes are re-attached by name.
3. Stop dependents sharing its network (`network_mode: service:X`), stop it, rename it to `<name>-old-<timestamp>`, create and start the new one.
4. Wait until it is healthy (healthcheck) or stays up for 10 s (no healthcheck).
5. Recreate the dependents against the new container, then delete the old containers.

**Rollback is only automatic when the new version never ran** — Docker refused to create or start it (port in use, missing mount, …). If it started and then crashed, turned unhealthy or timed out, it may already have migrated data, so it is **left untouched (not even stopped)** and the old container is kept stopped as `<name>-old-<timestamp>`. Inspect its logs (included in the result) and fix forward, or call `container_rollback` deliberately.

### Jobs & Alerts

| Tool | Description |
|---|---|
| `job_list` | Unique job types with last-run status and timestamp (cron jobs shown with human-readable description) |
| `job_history` | Full run history for a specific job; requires `description` (from `job_list`) and `limit` |
| `alert_list` | Active alerts sorted by severity: CRITICAL → ERROR → WARNING → NOTICE → INFO |

---

## Security

Access to the Docker socket is root-equivalent on the host, and mounting it `:ro` does **not** change that — it only protects the socket file, not the API behind it. This server is therefore the security boundary:

- [`src/docker-client.ts`](src/docker-client.ts) checks every request against a fixed allowlist of method + path (read endpoints, start/stop/restart, image pull/prune, and the create/rename/delete steps of an update). Query strings are built internally; there is no generic passthrough, exec, build, volume or network access.
- `/containers/create` is only reached through the update path, whose body is always derived from an existing container's inspect output — tool arguments can't supply container configuration, mounts or privileges. Containers are never deleted with their volumes.
- The `/proc` mount is read-only; process command lines are redacted for passwords, tokens and URL credentials.
- `/mcp` requires the bearer token; comparison is constant-time.
- Run the container read-only, without capabilities, as non-root (see the compose example), and keep it behind TLS (e.g. Traefik) if it is reachable beyond the LAN.

---

## Development

```bash
cp .env.example .env   # fill in values
yarn install
yarn dev               # tsx src/index.ts, serves on :3000
docker build --build-arg APP_VERSION=dev -t truenas-mcp:dev .
```

Releases: pushing a `v*` tag builds and publishes `ghcr.io/profanter-dev/truenas-mcp` (`X.Y.Z`, `X.Y`, `X`, `latest`) and creates a GitHub release.

---

## Migrating from 1.x

1. Deploy the container as above (the docker-socket-proxy stack is no longer needed).
2. Replace the stdio registration:
   ```bash
   claude mcp remove truenas
   claude mcp add --transport http truenas https://truenas-mcp.example.com/mcp \
     --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
   ```
3. `DOCKER_PROXY_URL` / `DOCKER_PROXY_USER` / `DOCKER_PROXY_PASS` are gone; the socket mount replaces them.

---

## Protocol details

- WebSocket URL: `wss://<host>/api/current`
- Auth: `auth.login_with_api_key` — called once on connect; never reconnects per-call
- Rate limit: TrueNAS enforces 20 auth attempts per 60 s; exceeding triggers a 10-minute lockout
- The server maintains a single persistent connection, shared by all MCP clients, with exponential-backoff reconnection on unexpected disconnects
