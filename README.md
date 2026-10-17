# PowerFlex Rack Visualizer

Containerized web app that renders Dell PowerEdge servers in their 42U racks
(front view) by reading live data from each iDRAC's Redfish API.

Server position comes from the iDRAC "System Location" field (Asset Tracking →
System Information), e.g. `DC1 Prod_Rack1 RU36` = datacenter DC1, environment
Prod, Rack1, unit 36. That GUI field is exposed via Redfish as
`SystemInfo.1.SysLocation` in
`/redfish/v1/Managers/iDRAC.Embedded.1/Oem/Dell/DellAttributes/<SystemId>`;
the app falls back to `Chassis.Location` and a defensive System scan if it is
absent.

## Setup

1. `cp .env.example .env` and set `IDRAC_PASSWORD` (username defaults to `root`).
2. Copy `servers.example.json` to `servers.json` and list the iDRAC hostnames
   (`servers.json` is gitignored so real host lists never land in the repo).
3. `docker compose up -d`
4. Open https://localhost:8082 (self-signed cert — the browser will warn; proceed)

## Software inventory & dependencies

Everything the solution runs, end to end:

**Host requirements**

- Docker Engine + Docker Compose v2 — the only host software needed to run the
  app. No Node.js, Python, or other runtime is required on the host.
- Optional ops helpers (not part of the deployed app): `openssl` (generate the
  TLS cert, see HTTPS below) and `curl` + `python3` (used only by the
  `probe.sh` debugging script).

**Container base image**

- `node:20-alpine` — Alpine Linux with Node.js 20 and npm. The app runs as the
  unprivileged `node` user (see Dockerfile). The tag is floating (it tracks
  the latest Node 20 Alpine build); to see the exact image digest in use run
  `docker inspect --format='{{.Image}}' powerflex-visualizer-rack-visualizer-1`,
  or pin `FROM node:20-alpine@sha256:...` in the Dockerfile if your
  supply-chain policy requires digests.

**Application stack**

- Node.js 20 (ESM) + Express 4 web server. No build step, no frontend
  framework, no bundler — the UI is hand-written HTML/CSS/vanilla JS served
  statically from `public/`.
- No database. State lives in flat JSON files under `data/` (`users.json`,
  `discovered.json`, `switches.json`, `switch-models.json`, `.session_secret`).
- No telemetry, analytics, or phone-home code of any kind.

**Direct npm dependencies (3)**

| Package | Version | License | Purpose |
|---|---|---|---|
| express | 4.22.3 | MIT | HTTP server, routing, static files, body parsing |
| cookie-session | 2.1.1 | MIT | Signed, stateless session cookies |
| ldapts | 8.2.0 | MIT | LDAP/LDAPS client for Active Directory login |

Versions shown are the exact versions resolved by `package-lock.json`
(lockfile v3); `package.json` declares compatible ranges.

**Transitive dependencies**

- 77 production package entries in the lockfile (76 unique packages —
  `ms@2.1.3` is shared by `cookie-session` and `send`). Every one is licensed
  MIT, ISC, or BSD-3-Clause — no copyleft/GPL obligations.
- The image installs them with `npm ci --omit=dev`, so the build is
  reproducible from the lockfile and dev-only packages are never present.
  `package.json` declares no `devDependencies`.
- Full inventory (nested entries show the package they are installed under):

<details>
<summary>76 unique production packages — name@version (license)</summary>

```
accepts@1.3.8 (MIT)
array-flatten@1.1.1 (MIT)
body-parser@1.20.8 (MIT)
bytes@3.1.2 (MIT)
call-bind-apply-helpers@1.0.2 (MIT)
call-bound@1.0.4 (MIT)
content-disposition@0.5.4 (MIT)
content-type@1.0.5 (MIT)
cookie@0.7.2 (MIT)
cookie-session@2.1.1 (MIT)
cookie-signature@1.0.7 (MIT)
cookies@0.9.1 (MIT)
debug@2.6.9 (MIT)
debug@3.2.7 (MIT, nested under cookie-session)
depd@2.0.0 (MIT)
destroy@1.2.0 (MIT)
dunder-proto@1.0.1 (MIT)
ee-first@1.1.1 (MIT)
encodeurl@2.0.0 (MIT)
es-define-property@1.0.1 (MIT)
es-errors@1.3.0 (MIT)
es-object-atoms@1.1.2 (MIT)
escape-html@1.0.3 (MIT)
etag@1.8.1 (MIT)
express@4.22.3 (MIT)
finalhandler@1.3.2 (MIT)
forwarded@0.2.0 (MIT)
fresh@0.5.2 (MIT)
function-bind@1.1.2 (MIT)
get-intrinsic@1.3.0 (MIT)
get-proto@1.0.1 (MIT)
gopd@1.2.0 (MIT)
has-symbols@1.1.0 (MIT)
hasown@2.0.4 (MIT)
http-errors@2.0.1 (MIT)
iconv-lite@0.4.24 (MIT)
inherits@2.0.4 (ISC)
ipaddr.js@1.9.1 (MIT)
keygrip@1.1.0 (MIT)
ldapts@8.2.0 (MIT)
math-intrinsics@1.1.0 (MIT)
media-typer@0.3.0 (MIT)
merge-descriptors@1.0.3 (MIT)
methods@1.1.2 (MIT)
mime@1.6.0 (MIT)
mime-db@1.52.0 (MIT)
mime-types@2.1.35 (MIT)
ms@2.0.0 (MIT)
ms@2.1.3 (MIT, nested under cookie-session and send)
negotiator@0.6.3 (MIT)
object-inspect@1.13.4 (MIT)
on-finished@2.4.1 (MIT)
on-headers@1.1.0 (MIT)
parseurl@1.3.3 (MIT)
path-to-regexp@0.1.13 (MIT)
proxy-addr@2.0.8 (MIT)
qs@6.16.1 (BSD-3-Clause)
range-parser@1.2.1 (MIT)
raw-body@2.5.3 (MIT)
safe-buffer@5.2.1 (MIT)
safer-buffer@2.1.2 (MIT)
send@0.19.2 (MIT)
serve-static@1.16.3 (MIT)
setprototypeof@1.2.0 (ISC)
side-channel@1.1.1 (MIT)
side-channel-list@1.0.1 (MIT)
side-channel-map@1.0.1 (MIT)
side-channel-weakmap@1.0.2 (MIT)
statuses@2.0.2 (MIT)
strict-event-emitter-types@2.0.0 (ISC)
toidentifier@1.0.1 (MIT)
tsscmp@1.0.6 (MIT)
type-is@1.6.18 (MIT)
unpipe@1.0.0 (MIT)
utils-merge@1.0.1 (MIT)
vary@1.1.2 (MIT)
```

</details>

**Network requirements**

- Inbound: TCP 8082 on the host (HTTPS; the container listens on 8080).
- Outbound: TCP 443 HTTPS to each configured iDRAC host, and TCP 636 LDAPS to
  the Active Directory domain controller (only when `LDAP_SERVER` is set).
- No other outbound connections. No CDNs, external fonts, or remote assets —
  every static file is served from the image.

**Testing tooling (not shipped)**

- `test/mock-idrac.js` and `test/auth-test.js` run in throwaway
  `node:20-alpine` containers. Nothing under `test/` is copied into the
  production image — the Dockerfile copies only `server.js`, `lib/`, and
  `public/`.

## HTTPS

The app serves TLS when `certs/server.crt` + `certs/server.key` exist (mounted
read-only into the container); otherwise it falls back to plain HTTP. The
`certs/` directory is gitignored — generate your own cert with the hostnames
and IPs your users actually reach the site by:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout certs/server.key -out certs/server.crt -days 3650 \
  -subj '/CN=rackviz.example.com' \
  -addext 'subjectAltName=DNS:localhost,DNS:rackviz.example.com,IP:127.0.0.1'
chmod 600 certs/server.key
```

With TLS enabled the session cookie is marked `Secure`, so it is only sent over
HTTPS. Add more SAN entries if you reach the site by another name or IP.

## Authentication

All pages and API endpoints require login.

- **Local users** — stored in `data/users.json` (PBKDF2-SHA256, 600k iterations).
  On first start the app seeds a default `admin` / `admin` account. Signed-in local
  users can change their password via **Account → Change password** (min 8
  characters). AD-only accounts see a note that their password is managed in
  Active Directory. If a local password is lost, reset it from the host with:
  `docker run --rm -v "$PWD":/app -w /app node:20-alpine node set-password.js admin 'new-password'`
- **Active Directory login** — mirrors our companion ram-inventory app.
  Configured in `.env` (see `.env.example`): `LDAP_SERVER` (e.g.
  `ldaps://dc01.example.com:636`), `LDAP_USER_DN_TEMPLATE`
  (`{username}@example.com`), and optionally `LDAP_GROUP_NAME` to restrict
  AD logins to members of a security group (empty = allow all AD users). The DC's
  self-signed certificate is not validated. AD is tried first; if the DC is
  unreachable the app falls back to local users. `alice` and
  `alice@example.com` are the same account.
- **Session** — signed cookie (secret persisted to `data/.session_secret`), 24-hour
  lifetime. Local users get an **Account** menu in the header offering **Change
  password** and **Log out**; AD-only users see a plain **Log out** button
  instead, since their password is managed in Active Directory.

## Behavior

- Hover a server: iDRAC hostname + service tag. Click: opens the iDRAC in a new tab.
- Racks are grouped by datacenter + environment (e.g. `DC1 Prod`). A dropdown in
  the header switches between environments; the selection is reflected in the URL
  hash, so an environment can be bookmarked.
- Single rack is centered; multiple racks are ordered left-to-right by rack number.
- Height map: `R6xx` = 1U, `R7xx` = 2U; unknown models default to 1U with a warning.
- Overlapping servers and out-of-range positions are flagged.
- Unreachable iDRACs show an error card; the rest of the page still renders.

## Add / Remove page

The **Add/Remove** button in the header opens a management page with three
sections:

- **Add iDRAC node** — enter one iDRAC IP/DNS name, or press **+** to add more
  fields and submit them together. Each address is checked against
  `https://<host>/redfish/v1` (anonymous, no credentials sent) before being
  added; unreachable or duplicate hosts are reported per line. **Import CSV**
  works the same way: first column of each line is the host, optional header
  row and `#` comments are ignored.
- **Add network device** — switches don't speak Redfish, so all fields are
  entered manually: Make/Model, Switch name, IP address, Serial number,
  Location (same format as iDRAC, e.g. `DC1 Prod_Rack1 RU18`), Role
  (Leaf A / Leaf B / Border Leaf A / Border Leaf B / Management Agg A /
  Management Agg B / Spine A / Spine B / Spine C), and Height (1U or 2U).
  Make/Model values you have entered before appear as autocomplete suggestions
  (kept in `data/switch-models.json`), so repeat models only need picking from
  the list. The Role dropdown is auto-selected from the switch name when it
  matches a known pattern — names ending `-lf-n9k01`, `-blf-n9k07`,
  `-ma-n9k03` (also `-bl-`/`-mgmt-`/`-agg-`) map to Leaf / Border Leaf /
  Management Agg with an odd trailing number meaning A and even meaning B;
  `-sp-n9k01/02/03` map to Spine A / B / C — and can still be overridden
  manually. **Import CSV** bulk-adds devices: header row with `Make/Model`,
  `Switch name`, `IP address`, `Serial number`, `Location`, `Role`, `Height`
  columns — **Download example CSV** fetches a ready-made template
  (`public/switches-example.csv`). Role matching is case-insensitive, Height
  accepts `1`/`2`/`1U`/`2U`, and rows whose switch name is already configured
  are skipped.
- **Current entries** — lists everything configured. Discovered iDRAC hosts and
  network devices have a **Remove** button; `servers.json` hosts are edited by
  changing the file itself.

Added iDRAC hosts persist to `data/discovered.json` and switches to
`data/switches.json` (both on the writable `./data` volume), merged with
`servers.json` on every load.

In the rack, switches render as teal blocks labeled `Make/Model · Role`
(e.g. `Cisco 93180YC-FX3 · Leaf`); hover shows name, IP, serial, and position.
Switches participate in overlap detection just like servers.

## Testing without real iDRACs

`test/mock-idrac.js` is a mock Redfish endpoint (self-signed HTTPS) for
end-to-end checks:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout test/certs/key.pem -out test/certs/cert.pem -days 1 -subj '/CN=mock-idrac'
docker network create racktest
docker run -d --name mock-idrac --network racktest --network-alias mock-idrac \
  -v "$PWD/test/mock-idrac.js":/app/mock.js:ro -v "$PWD/test/certs":/certs:ro node:20-alpine node /app/mock.js
docker run -d --name rack-app-test --network racktest -p 8082:8080 \
  -v "$PWD/test/servers-mock.json":/app/config/servers.json:ro --env-file .env rack-visualizer
curl -s localhost:8082/api/racks
```

## Notes

- Moving the app to an air-gapped host (no registry access)? See
  **MIGRATION.md** for the `docker save` / SCP / `docker load` procedure.
- TLS verification is disabled only for outbound iDRAC requests (self-signed
  certs); the site itself is served over HTTPS with a self-signed cert (see
  HTTPS above).
- Repeated failed logins may trigger an iDRAC account lockout — fix the password
  in `.env` and restart the container.
- `probe.sh` dumps the authenticated Redfish System JSON if you need to inspect
  the raw fields.
