# truenas-mcp

**Read-only MCP server for TrueNAS SCALE 25.10+** — connects via the JSON-RPC 2.0 WebSocket API.

> **Why this exists:** The official `truenas/truenas-mcp` binary uses the legacy DDP protocol, which was removed in TrueNAS 25.10. This server targets the new `wss://host/api/current` JSON-RPC 2.0 endpoint exclusively.

> **READ-ONLY**: This server performs zero write or mutating operations.

---

## Requirements

- TrueNAS SCALE 25.10 or later
- A TrueNAS API key (generate in **System → API Keys**)
- Node.js 18+

---

## Install

```bash
npm install -g @profanter-dev/truenas-mcp
```

Or run without installing:

```bash
npx @profanter-dev/truenas-mcp
```

---

## Configuration

### TrueNAS (required)

| Variable | Required | Description |
|---|---|---|
| `TRUENAS_HOST` | ✓ | `host:port`, e.g. `192.168.1.29:444` |
| `TRUENAS_API_KEY` | ✓ | TrueNAS API key |
| `TRUENAS_INSECURE` | | `true` to skip TLS certificate verification (self-signed certs) |

### Docker proxy (optional)

Enables `container_list`, `container_details`, and `container_logs`. See [Docker proxy setup](#docker-proxy-setup) below.

| Variable | Required | Description |
|---|---|---|
| `DOCKER_PROXY_URL` | ✓ | Base URL of the docker-socket-proxy, e.g. `https://docker.example.com` |
| `DOCKER_PROXY_USER` | ✓ | Basic auth username |
| `DOCKER_PROXY_PASS` | ✓ | Basic auth password |

Copy `.env.example` to `.env` and fill in your values, or pass as environment variables.

---

## Claude Code setup

```bash
claude mcp add truenas \
  -e TRUENAS_HOST=192.168.1.29:444 \
  -e TRUENAS_API_KEY=your-key \
  -e TRUENAS_INSECURE=true \
  -- npx @profanter-dev/truenas-mcp
```

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

> **Note:** These tools cover apps installed via the TrueNAS Apps UI (catalog apps). Docker Compose stacks managed by external tools such as Dockge are not accessible through the TrueNAS WebSocket API — use the Docker proxy tools below instead.

### Docker containers *(optional — requires Docker proxy)*

| Tool | Description |
|---|---|
| `container_list` | All Docker containers (running and stopped) — name, image, state, health |
| `container_details` | Single container: image, state, ports, mounts, networks, labels. Secret env vars are redacted. |
| `container_logs` | Recent log output for a container; configurable line count (default 100) |

These tools are only registered when `DOCKER_PROXY_URL` is set.

### Jobs & Alerts

| Tool | Description |
|---|---|
| `job_list` | Unique job types with last-run status and timestamp (cron jobs shown with human-readable description) |
| `job_history` | Full run history for a specific job; requires `description` (from `job_list`) and `limit` |
| `alert_list` | Active alerts sorted by severity: CRITICAL → ERROR → WARNING → NOTICE → INFO |

---

## Docker proxy setup

The Docker container tools connect to a `tecnativa/docker-socket-proxy` instance secured behind Traefik with basic auth. Deploy this as a Dockge stack on your TrueNAS:

```yaml
# docker-socket-proxy/compose.yml
services:
  docker-proxy:
    image: tecnativa/docker-socket-proxy:latest
    environment:
      CONTAINERS: "1"
      INFO: "1"
      IMAGES: "1"
      NETWORKS: "1"
      POST: "0"   # read-only — block all write operations
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - traefik_network
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.docker-proxy.rule=Host(`docker.example.com`)"
      - "traefik.http.routers.docker-proxy.entrypoints=websecure"
      - "traefik.http.routers.docker-proxy.tls.certresolver=letsencrypt"
      - "traefik.http.routers.docker-proxy.middlewares=docker-proxy-auth"
      - "traefik.http.middlewares.docker-proxy-auth.basicauth.users=admin:$$apr1$$..."
      - "traefik.http.services.docker-proxy.loadbalancer.server.port=2375"
    restart: unless-stopped

networks:
  traefik_network:
    external: true
```

Generate the htpasswd entry (double `$` signs are required in compose labels):

```bash
# Install apache2-utils if needed, then:
htpasswd -nb admin yourpassword | sed 's/\$/\$\$/g'
```

Then set the env vars when registering the MCP server:

```bash
claude mcp add truenas \
  -e TRUENAS_HOST=192.168.1.29:444 \
  -e TRUENAS_API_KEY=your-key \
  -e TRUENAS_INSECURE=true \
  -e DOCKER_PROXY_URL=https://docker.example.com \
  -e DOCKER_PROXY_USER=admin \
  -e DOCKER_PROXY_PASS=yourpassword \
  -- npx @profanter-dev/truenas-mcp
```

---

## Protocol details

- WebSocket URL: `wss://<host>/api/current`
- Auth: `auth.login_with_api_key` — called once on connect; never reconnects per-call
- Rate limit: TrueNAS enforces 20 auth attempts per 60 s; exceeding triggers a 10-minute lockout
- The server maintains a single persistent connection with exponential-backoff reconnection on unexpected disconnects
