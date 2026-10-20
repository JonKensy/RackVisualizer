# Air-Gapped Migration Guide

How to move the Rack Visualizer to a host with Docker but **no internet/registry
access** (e.g. the Oracle Linux 9 VM). The approach: build the image on a
connected machine, export it with `docker save`, transfer files via SCP, and
import them with `docker load`.

The source code alone is **not** enough on the target host — rebuilding the
image there would require pulling `node:20-alpine` and running `npm ci`
against the npm registry, neither of which is possible offline. The pre-built
image contains the app code, the Node 20 runtime, and all dependencies.

## 1. On the source machine (has internet)

```bash
cd powerflex-visualizer

# Build the current source into the image
docker compose build

# Tag it with a stable, explicit name (the compose-generated name depends on
# the directory name, so don't rely on it for transfer)
docker tag powerflex-visualizer_rack-visualizer:latest rack-visualizer:1.2.0

# Export the image (compressed) and record a checksum
docker save rack-visualizer:1.2.0 | gzip > rack-visualizer-1.2.0.tar.gz
sha256sum rack-visualizer-1.2.0.tar.gz
```

Bump the version tag (`1.1.0` → `1.1.1` …) on each migration so the target
host can tell which build it has.

## 2. Files to transfer (SCP to the target, e.g. `~/powerflex-visualizer/`)

| File | Required? | Why |
|---|---|---|
| `rack-visualizer-<ver>.tar.gz` | **Yes** | The complete container image — app code, Node 20 runtime, all npm deps. Cannot be rebuilt on the target. |
| `docker-compose.offline.yml` | **Yes** | Same as `docker-compose.yml` but references the pre-built image (`image:`) instead of `build:` — a build would fail without registry access. |
| `.env` | **Yes** | iDRAC credentials. Contains the real password — `chmod 600` on both ends. |
| `servers.json` | **Yes** | Admin-controlled iDRAC host list (mounted read-only). |
| `certs/` (`server.crt`, `server.key`) | **Yes** | TLS cert + key. `server.key` must be `chmod 600`. |
| `data/` | Recommended | Carries over the local users (including any changed admin password), discovered hosts, switches, model list, and the session-signing secret. If omitted, the app seeds a fresh `admin`/`admin` account on first start. Treat as sensitive. |
| Full source tree (`server.js`, `lib/`, `public/`, `Dockerfile`, `package*.json`, `README.md`) | Optional | Not needed at runtime (it is baked into the image), but useful for a future rebuild once the target has connectivity. |

## 3. On the target VM

```bash
cd ~/powerflex-visualizer

# Verify the transfer survived intact
sha256sum rack-visualizer-1.2.0.tar.gz   # must match the source checksum

# Import the image
docker load -i rack-visualizer-1.2.0.tar.gz

# Lock down secrets
chmod 600 .env certs/server.key
chmod 600 data/.session_secret 2>/dev/null || true

# Start using the offline compose file
docker compose -f docker-compose.offline.yml up -d

# Verify
docker ps | grep rack-visualizer
curl -sk https://localhost:8082/login    # expect the login page HTML
curl -sk -o /dev/null -w '%{http_code}\n' https://localhost:8082/api/racks   # expect 401
```

## 4. Caveats / pre-flight checklist

- **Docker must be installed before the air-gap.** Installing Docker Engine +
  Compose v2 on OEL9 normally needs package access; do it while the VM still
  has connectivity, or transfer the RPMs (`dnf download --resolve`) and
  install offline.
- **Architecture must match.** The image is `linux/amd64` (standard x86_64
  OEL9 VM is fine). Check with
  `docker image inspect rack-visualizer:1.2.0 --format '{{.Architecture}}'`.
  For an ARM target, rebuild here with `docker build --platform linux/arm64`.
- **TLS cert SANs.** The cert covers whatever hostnames/IPs it was generated
  for (see README.md). If users reach the new VM by a different hostname or IP,
  regenerate the cert on the target with the correct SANs (openssl command in
  README.md) or browsers will show a name-mismatch warning.
- **LDAP settings.** LDAP config is read from `.env` (see `.env.example`). On
  the target VM, set `LDAP_SERVER` / `LDAP_USER_DN_TEMPLATE` / `LDAP_GROUP_NAME`
  for the destination AD, or leave `LDAP_SERVER` empty for local-only auth.
- **Port.** The app publishes host port **8082** → container 8080. Adjust the
  `ports:` mapping in the offline compose file if 8082 is taken.
- **Firewall.** Open 8082/tcp on the target VM if clients connect remotely.

## 5. Updating the app later (still offline)

There is no registry to pull from, so every future change repeats the cycle:

1. Edit source on the connected machine.
2. `docker compose build` → `docker tag ... rack-visualizer:<new-version>` →
   `docker save ... | gzip`.
3. SCP the new tarball, `docker load`, then
   `docker compose -f docker-compose.offline.yml up -d` (compose recreates the
   container with the new image; `data/` persists).

## 6. Current staged artifact (this migration)

- Tarball: `~/powerflex-visualizer/rack-visualizer-1.2.0.tar.gz` (gzip)
- SHA-256: `8fb9a6ab842cef82c12dccc6982c6ae71173a401f373dc133a1fcd2bd03a24f4`
- Image: `rack-visualizer:1.2.0` (linux/amd64) — adds the "Discover iDRAC from
  PowerFlex" feature: Settings gains a PowerFlex Manager connection (URL,
  username, password) and iDRAC credential overrides; both passwords are
  stored encrypted (AES-256-GCM). When the toggle is on, the rack view shows
  only PowerFlex-discovered iDRAC nodes plus manually added switches.
  1.1.2 is superseded.

### 1.2.0 upgrade notes

- Two new files appear under `data/` on first start: `.enc_key` (the AES key,
  mode 0600 — **back this up**; without it the stored passwords are
  unrecoverable and must be re-entered) and `powerflex-hosts.json` (the
  discovered-host cache). No action needed if you carry `data/` over.
- `data/settings.json` now holds encrypted password blobs — keep it `chmod
  600` (the app writes it that way).
- No `.env` changes required. `IDRAC_USER`/`IDRAC_PASSWORD` still work;
  credentials set in Settings override them.
- After `docker load`, use `docker compose -f docker-compose.offline.yml up
  -d --force-recreate` — plain `up -d` will not swap the image if the old
  container is still running.
- To find your appliance's API paths (they vary by deployment), run
  `probe-powerflex.sh https://<pfxmgr>` and enter the working values under
  Settings → Advanced API paths.

> The checksum above is for this specific export. Rebuilding the image (even
> from identical source) produces a new tarball and checksum — always re-run
> `sha256sum` after `docker save` and compare on the target.
