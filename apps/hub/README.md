# @atriarch-systems/tracery-hub

Standalone server for Tracery Graph (see [`../../docs/SPEC.md`](../../docs/SPEC.md)
§6). Apps push events with a client SDK (`@atriarch-systems/tracery-client` or the
Python `atriarch-tracery-graph`); the hub stores, sorts, serves and draws. Nothing
renders in the producing app.

```
npx @atriarch-systems/tracery-hub
```

(or `node apps/hub/bin/hub.mjs` from a built source checkout) starts the server bound to `127.0.0.1:8971` with an in-memory store and
**no authentication of its own** ("local mode" -- see "Auth mode" below): a
single `default` workspace, no key to generate, copy, or configure. Every
other setting below has a default.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `TRACERY_PORT` | `8971` | HTTP/WS listen port. |
| `TRACERY_HOST` | `127.0.0.1` | HTTP/WS listen host. A loopback value (`127.0.0.1`, `::1`, `localhost`) is what makes "local mode" (below) apply automatically; the Dockerfile sets this to `0.0.0.0` explicitly for the container case. |
| `TRACERY_STORE` | `memory` | `memory`, `sqlite`, or `postgres`. |
| `TRACERY_SQLITE_PATH` | `/data/tracery.db` | Database file path, used only when `TRACERY_STORE=sqlite`. |
| `TRACERY_POSTGRES_URL` | unset | `postgres://user:pass@host:5432/db` connection string. **Required** when `TRACERY_STORE=postgres` (the hub fails at boot without it); ignored otherwise. |
| `TRACERY_API_KEYS` | unset | Inline JSON array of API keys (see below). Setting this (or `_FILE`) always selects `authMode: 'keys'`, on any host. |
| `TRACERY_API_KEYS_FILE` | unset | Path to a JSON file with the same shape as `TRACERY_API_KEYS`. Ignored when `TRACERY_API_KEYS` is set. |
| `TRACERY_AUTH` | unset | Set to `none` to run with no authentication on a **non-loopback** host (e.g. a container already sitting behind a reverse proxy/service mesh/network policy that authenticates for it) -- see "Auth mode" below. Ignored when `TRACERY_API_KEYS`/`_FILE` is set, and irrelevant on a loopback host (already local mode by default). |
| `TRACERY_RETENTION_HOURS` | `72` | Retention window; the sweeper deletes complete flows older than this. |
| `TRACERY_MAX_EVENTS_PER_WORKSPACE` | `500000` | Soft per-workspace cap enforced by the sweeper (not a hard per-append limit). |
| `TRACERY_METRICS_TOKEN` | unset | When set, `GET /metrics` requires it (`?token=`, `x-metrics-token`, or `Authorization: Bearer`). Unset means `/metrics` is public. |
| `TRACERY_LOG_LEVEL` | `info` | Pino log level (`fatal`..`trace`, or `silent`). |
| `TRACERY_OPENAPI` | unset (off) | `1` (or `true`) serves the OpenAPI 3.1 document at `GET /v1/openapi.json`, with no authentication. Off by default: the document describes every route, so expose it only where you want that. The document is generated at build time and ships in the package as `openapi.json`; the hub never builds it at runtime. `0`, `false` or empty keep it off; any other value stops the hub at boot. |
| `TRACERY_UI_DIR` | `<package>/web/dist` | Directory to serve at `/ui`. When it (or its `index.html`) is missing, `/ui` serves a plain "not built" page instead. |
| `TRACERY_PUBLIC_URL` | unset | Absolute origin (scheme + host) used to build a share link's `url` and its `GET /s/:token` Open Graph tags (`docs/SHARING.md`). Unset means "use the inbound request's own origin" -- set this explicitly whenever the hub is reachable at a different public hostname than requests arrive on (behind a CDN, a path-rewriting gateway, etc.). |

### Auth mode

Resolved once at boot into `authMode: 'none' | 'keys'`, in this order:

1. `TRACERY_API_KEYS` or `TRACERY_API_KEYS_FILE` set -> `'keys'`, regardless
   of host. Unchanged from before: see "API key file format" below.
2. Otherwise, `TRACERY_HOST` resolves to a loopback address (`127.0.0.1`,
   `::1`, `localhost` -- the default) -> `'none'` ("local mode"): every
   request and WS connection is a full-access principal on the single
   `default` workspace. No key is ever checked, minted, or printed. A
   batch/query naming any workspace other than `default` is rejected with
   `400 workspace_not_local`, not silently redirected to `default`.
3. Otherwise, `TRACERY_AUTH=none` set explicitly -> `'none'`, same as above,
   plus a one-line warning logged at boot -- this is for a container that
   binds a non-loopback host (so it isn't caught by rule 2) but sits behind
   something that already authenticates (reverse proxy, service mesh,
   network policy).
4. Otherwise: **the hub fails to start** with
   `TRACERY_HOST is not loopback and no API keys are configured; set
   TRACERY_API_KEYS (see README) or TRACERY_AUTH=none if something in front
   of the hub already authenticates`. There is no dev-key fallback (the old
   behavior of generating and logging one all-roles key when nothing was
   configured has been removed entirely) -- a non-loopback bind always needs
   an explicit decision, one way or the other.

`GET /v1/info` (public, no auth) reports `{ product, version, edition, auth,
workspace? }` -- `workspace` is present only in `'none'` mode -- so a client
can discover which mode a hub is running in with one unauthenticated call;
the hosted UI uses it to skip the key-entry screen entirely in local mode.

The container binds all interfaces and requires configured keys, unless you explicitly
set `TRACERY_AUTH=none` at runtime behind a trusted access-control boundary.

### API key file format

```json
[
  { "id": "saga", "key": "s3cr3t-ingest-key", "workspace": "saga", "roles": ["ingest", "read"] },
  { "id": "explorer", "key": "s3cr3t-read-key", "workspace": "saga", "roles": ["read"] },
  { "id": "operator", "key": "s3cr3t-operator-key", "workspace": "*", "roles": ["ingest", "read", "admin"] }
]
```

- `id` is a label used in logs; it is optional (defaults to `key-<index>`).
- `workspace` is the workspace the key is bound to. Requests never see
  another workspace's data. `workspace: "*"` is the **operator** key: every
  request made with it must name a workspace explicitly (`?workspace=` on
  reads, `{"workspace": "..."}` in the ingest body) except `GET /v1/workspaces`,
  where the operator may omit it to see every workspace's stats.
- `roles` is a non-empty array drawn from `ingest`, `read`, `admin`.
- Present the key as `Authorization: Bearer <key>`, `x-api-key: <key>`, or
  (WebSocket only, since browsers cannot set custom headers on a WS
  handshake) `?token=<key>`.
- Keys are compared in constant time (`crypto.timingSafeEqual` over a
  SHA-256 hash of each candidate), so a wrong key never leaks how much of it
  matched.

### SSO (OIDC)

This package ships no SSO implementation of its own. An extensions module
(see "Extending (extensions)" below) can add one -- Tracery Cloud does, as a
private `HubExtensions` module loaded via `TRACERY_EXTENSIONS_MODULE` -- by
registering its own `/v1/auth/*` routes and, via `apps/hub/src/auth.ts`'s
`setSessionAuthResolver` seam, letting a signed session cookie stand in for
an API key on requests that present no credential at all. A configured
module's session cookie is then accepted anywhere a `read` role API key
would be -- including `GET /v1/flows` and `WS /v1/live` above -- with no
`Authorization` header or `?token=` at all. See
[`../../docs/CLOUD.md`](../../docs/CLOUD.md) for what Tracery Cloud's SSO
offers.

## HTTP API

All JSON, all under `/v1` except health/metrics/UI. The machine-readable
spec (OpenAPI 3.1) ships pre-generated as `openapi.json` in the package and is
served at `GET /v1/openapi.json` only when `TRACERY_OPENAPI=1`. Errors are always
`{ "error": { "code": "...", "message": "..." } }`; every response carries
`x-request-id`.

### Cross-origin requests

Browser HTTP requests and WebSocket upgrades accept the hub's own origin and
exact origins in `TRACERY_ALLOWED_ORIGINS` (comma-separated, for example
`http://localhost:5173,https://app.example.com`). Opaque origins (`null`), paths,
and wildcards are not accepted. Set `TRACERY_PUBLIC_URL` when a reverse proxy
serves a different external origin. Do not trust arbitrary forwarded headers.
Native SDK requests without an Origin header continue to work and still require
keys in authenticated mode. Origin checks never replace authentication.

For the generator demo, allow its Vite origin explicitly on the target hub.

### Headers

| Header | When | Meaning |
| --- | --- | --- |
| `x-request-id` | Every response. | Echoes the incoming `x-request-id`, or a generated one when absent/invalid. |
| `x-ko-fi` | Every response, community edition only. | `https://ko-fi.com/demonslyr` -- a friendly tip-jar link, no protocol meaning; absent when an extensions module reports a valid license (see `docs/CLOUD.md`). |

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/v1/info` | none | Hub identity: `{ product, version, edition, auth, workspace? }` -- `workspace` present only in `authMode: 'none'`. See "Auth mode" above. |
| `POST` | `/v1/events` | `ingest` | Batch ingest. Body is an `ActivityBatch` (`{ v, workspace?, events }`). Returns `ActivityBatchResult`; `200` when every event was accepted, `207` when some were rejected (see `rejected[]`), `400` for a malformed envelope or a batch over 1000 events. |
| `GET` | `/v1/flows` | `read` | List flows, newest-activity first. Query: `limit` (default 50, max 1000), `before` (opaque cursor from a previous page's `nextBefore`), `status`, `actor`, `trace`, `q` (label substring). |
| `GET` | `/v1/flows/:id` | `read` | Flow summary (`ops`/`nodes`/`edges`, no events). `404` when unknown. |
| `GET` | `/v1/flows/:id/events` | `read` | `ActivityFrame`: a full snapshot, or (with `?after=<cursor>`) just the events after it -- or a `truncated: true` snapshot when `after` is older than what the store still holds. |
| `GET` | `/v1/traces/:id` | `read` | Every flow sharing the resolved trace id, plus spawn links and any `missing` (referenced-but-never-observed) parents. `404` when no flow resolves to this trace. |
| `GET` | `/v1/traces/:id/events` | `read` | Every event for every flow in the trace, cursor-ordered. |
| `GET` | `/v1/workspaces` | `admin` | Workspace stats. A non-operator admin key only ever sees its own workspace. |
| `DELETE` | `/v1/flows/:id` | `admin` | Deletes a flow and its events. `404` when unknown. |
| `POST` | `/v1/shares` | `read` | Create a share link (`docs/SHARING.md`). Body: `{ target: { type: "flow"\|"trace", id }, mode?, includeContext?, expiresInDays? }`. Returns `{ id, token, url }`. |
| `GET` | `/v1/shares` | `read` | List the caller's own shares (or every share in the workspace, for an admin key); tokens are never included. |
| `DELETE` | `/v1/shares/:id` | `read`, creator or `admin` | Revoke a share. Idempotent; `404` when unknown. |
| `PUT` | `/v1/shares/:id/preview` | `read`, creator or `admin` | Upload a PNG preview image (raw body, `Content-Type: image/png`, max 2 MB). |
| `GET` | `/v1/shares/:token/meta`, `/flow`, `/trace`, `/events` | none -- the token is the credential | Public, read-only, redacted-by-default reads through one share. Unknown/expired/revoked tokens all `404` identically. Rate-limited to 60 req/min/IP. |
| `GET` | `/v1/shares/:token/preview.png` | none | The share's uploaded preview PNG, or `404` if it has none. |
| `WS` | `/v1/shares/:token/live` | none | Same framing as `WS /v1/live`, scoped to one share's target; only serves a `mode: "live"` share (closes immediately otherwise). |
| `GET` | `/s/:token` | none | The share page: the hosted UI with Open Graph tags injected for this share, then the SPA's own share-mode view. |
| `GET` | `/v1/flows/:id/export.html`, `/v1/traces/:id/export.html` | `read` | A single, fully self-contained downloadable `.html` file (no network dependency) rendering the flow/trace offline. `?context=false` redacts. `404` if `apps/hub/web`'s `viewer.html` hasn't been built. |
| `GET` | `/healthz` | none | Liveness. |
| `GET` | `/readyz` | none | Readiness (the store answered `stats()`). |
| `GET` | `/metrics` | none, or `TRACERY_METRICS_TOKEN` | Prometheus text exposition. |
| `WS` | `/v1/live?workspace=&flow=&trace=&after=&token=` | `read` | Live feed: a `snapshot` frame, then `events` frames as they're ingested, then a `heartbeat` frame every 15s. Reconnect with `after=<cursor>`; a stale cursor gets a fresh `truncated: true` snapshot instead of a gap. A client that can't keep up (2s send deadline) is disconnected. |
| `GET` | `/`, `/ui/*` | none (the UI does its own key entry) | Hosted explorer, when `apps/hub/web` was built into `TRACERY_UI_DIR`; otherwise a plain placeholder page. |

See [`../../docs/SHARING.md`](../../docs/SHARING.md) for what a share is,
snapshot vs. live, redaction rules, rate limits, and `TRACERY_PUBLIC_URL`.

`workspace` is resolved from the API key, except for the `*` operator key,
which must be given one explicitly (`?workspace=` on every read/WS route,
`{"workspace": "..."}` in the ingest body).

### Metrics

`GET /metrics` exposes: `tracery_events_ingested_total`,
`tracery_events_rejected_total`, `tracery_events_duplicate_total`,
`tracery_flows_total`, `tracery_store_events`, `tracery_ws_clients`,
`tracery_sweeps_total`, `tracery_swept_flows_total`.

## Storage

Three `EventStore` implementations, selected by `TRACERY_STORE`:

- **`memory`** (default): everything in process memory. Simplest option;
  lost on restart.
- **`sqlite`**: `node:sqlite` (`DatabaseSync`, WAL mode), file at
  `TRACERY_SQLITE_PATH`. Events are the durable source of truth on disk;
  flow/trace reduction is kept as an in-memory index, updated incrementally
  on every write (core's single-flow `buildFlow`, exactly like `MemoryStore` --
  see below), so reads never touch disk. This keeps `SqliteStore` behaviourally
  identical to `MemoryStore` (both run the exact same `@atriarch-systems/tracery-core`
  reduction) while adding durability across restarts. It bounds memory use to
  what `TRACERY_MAX_EVENTS_PER_WORKSPACE` allows.
- **`postgres`**: the `pg` package against `TRACERY_POSTGRES_URL`. Same
  design as `SqliteStore` (events on disk, an incrementally-updated in-memory
  flow index, the same materialised `flows` table -- see below), except
  every write (`append`, `deleteFlow`, `sweep`) runs inside one SQL
  transaction and every query is parameterised. **This is the only store
  that supports more than one hub replica** -- `MemoryStore` and
  `SqliteStore` are both single-writer (in-process memory, or a single
  WAL-mode file); pointing several hub instances at the same Postgres
  database is the supported way to scale the hub horizontally or run it
  highly available. `k8s/deployment.yaml` has a commented-out env block for
  switching to it, and `docker-compose.yaml`'s `postgres` profile brings up
  a throwaway Postgres alongside the hub for local testing.

All three stores resolve a flow's `trace` id via core's `resolveTraceIds`/
`assembleTrace` on every append (an O(flows) walk over already-reduced
`{id, link}` pairs, not a re-run of `buildFlows` over the whole event log), so
a parent flow arriving after its child corrects the child's (and any further
descendants') `trace` automatically.

### The `flows` table (SqliteStore, PostgresStore)

`SqliteStore` and `PostgresStore` each keep a `flows` table alongside
`events` -- one row per flow, kept current incrementally the same way the
in-memory index is (on `append`, `deleteFlow` and `sweep`, only the flow(s)
actually touched plus whichever other flows a late-parent trace correction
changed are re-written). It exists for two reasons:

1. **Boot cost.** On open, the store loads the `flows` table straight into
   its in-memory index -- one row read + a `JSON.parse` (`SqliteStore`) or
   an already-parsed `jsonb` value (`PostgresStore`) per flow, O(flows) --
   instead of re-deriving every flow from its entire event history via
   `buildFlows(allEvents)`, which is O(events) and was `SqliteStore`'s old
   startup path. The `events` table is still read into memory at boot (other
   reads need the raw events), but that read no longer feeds a flow-graph
   reduction.
2. **`listFlows`/`flowSummary` are genuinely SQL-backed**: filtering
   (`status`, `actor`, `trace`, `q`), ordering (newest activity first) and
   `before`-cursor paging are all indexed `WHERE`/`ORDER BY` clauses against
   this table, not an in-memory array scan.

`PostgresStore` keeps all of its tables inside one Postgres *schema*
(`public` by default) and creates them on boot if they don't exist yet, with
a `schema_version` row recording the materialised row shape -- a missing
`flows` table or a version mismatch triggers the same one-time O(events)
rebuild described above for `SqliteStore`.

Columns (both stores use the same shape; `SqliteStore`'s TEXT/INTEGER map to
`PostgresStore`'s TEXT/BIGINT/JSONB):

| Column | Meaning |
| --- | --- |
| `workspace`, `id` | Primary key. |
| `trace` | The flow's resolved trace id (SPEC.md §1 "Trace resolution"). |
| `label` | `Flow.label`; matched case-insensitively by `listFlows`' `q` filter. |
| `actor_id`, `actor_kind` | `Flow.actor.id`/`.kind`, `NULL` if the flow has no actor. |
| `status`, `partial` | `Flow.status`; `partial` as `0`/`1`. |
| `started_at`, `ended_at` | `Flow.startedAt`/`.endedAt`, `NULL` when open/unset. |
| `first_cursor`, `last_cursor` | The lowest/highest hub cursor among the flow's retained events; `last_cursor` is `listFlows`' sort/page key (matches "most recent activity first"). |
| `tags_json` | Sorted, deduped JSON array of every op's tags in the flow. |
| `root_node` | The node id of the op whose `start` declared `root: true`, or `NULL` for a partial flow with no root start yet. |
| `data_json` | The full `FlowSummary` (ops/nodes/edges included) as JSON -- what `listFlows`/`flowSummary` actually return. |

A schema-metadata table carries a `flows_schema_version` row -- `schema_meta`
in `SqliteStore`, `schema_version` in `PostgresStore` (the same idea, named
per the task that introduced each store). On open, the store rebuilds the
`flows` table from `events` (the old O(events) `buildFlows` path, run once)
whenever the table is missing (a database/schema from before it existed) or
that row doesn't match the store's current schema version (a future
column/format change) -- then writes the current version so the next boot
takes the fast path again.

### Retention

Every 60s, the sweeper deletes the oldest complete flows first -- oldest by
`startedAt` -- until the workspace is both under `TRACERY_RETENTION_HOURS`
and under `TRACERY_MAX_EVENTS_PER_WORKSPACE`. A `running` flow younger than
the retention window is never swept; a `running` flow *older* than the
window is treated as stale and is swept like any other (this is a safety
valve against a producer that never sends `end`, not a guarantee that
long-running flows survive indefinitely -- keep `TRACERY_RETENTION_HOURS`
generous for genuinely long-running work).

## Docker

```
docker run --rm -p 127.0.0.1:8971:8971 -e TRACERY_AUTH=none atriarchsystems/tracery-hub:0.1.1
```

The local example explicitly opts out of authentication and publishes the port
only on loopback. The image has no unauthenticated default. For network access,
configure a real key:

```
docker run --rm -p 8971:8971 \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  -e TRACERY_API_KEYS='[{"id":"me","key":"CHANGE_ME","workspace":"default","roles":["ingest","read","admin"]}]' \
  atriarchsystems/tracery-hub:0.1.1
```

Use `--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges`
for every hub container. The hub writes only to `/data` and `/tmp` and needs
no Linux capabilities. The compose services below use the same settings.

To build the image yourself, run this from the **repository root** (the image
needs `packages/core` and, optionally, `apps/hub/web`):

```
docker build -f apps/hub/Dockerfile -t atriarchsystems/tracery-hub:dev .
```

or with compose (also root-context; its services configure a keys file):

```
docker compose -f apps/hub/docker-compose.yaml up --build
```

From v0.1.2 the image is `FROM scratch` with the Node binary and six Alpine
runtime packages: no shell, busybox or apk. It runs as uid/gid `10001`, the app
code is owned by root and read-only to the hub, and only `/data` is writable.
It keeps only the hub's production dependencies, exposes `8971`, declares
`VOLUME /data`, and has an exec-form `HEALTHCHECK` against `/healthz` (via
Node's built-in `fetch`). The matching OS package sources are published as the
`<version>-sources` image tags and GitHub release assets;
`/usr/share/tracery/SOURCES.txt` in the image says where. There is no `sh`, so
to look inside a running container use `docker exec <name> node -e "..."`.
(0.1.1 is Alpine-based, runs as the non-root user `tracery`, uid 100, and
carries the sources inside the image.)

If `apps/hub/web` does not exist yet in the build context, the image still
builds and serves the plain placeholder page at `/ui` (see
`apps/hub/src/routes/ui.ts`).

`TRACERY_API_KEYS_FILE` mounts well as a Docker secret or a read-only bind
mount; see `docker-compose.yaml` and `keys.example.json` for the shape.

`docker-compose.yaml`'s default `hub` service uses `sqlite`. Its `postgres`
profile brings up a throwaway Postgres plus a second hub instance
(`hub-postgres`, host port `8972`) configured with `TRACERY_STORE=postgres`:

```
docker compose -f apps/hub/docker-compose.yaml --profile postgres up --build postgres hub-postgres
```

## Kubernetes

Plain manifests in `k8s/` (Kustomize-friendly, no Helm); a Helm chart
covering the same deployment (plus Ingress, ServiceMonitor and templated
secrets) is at [`helm/`](helm/README.md).

Both run the hub as uid/gid `10001` with a read-only root filesystem, all
capabilities dropped, no privilege escalation, `RuntimeDefault` seccomp and an
`emptyDir` at `/tmp`. Keep those settings in your own manifests. The root
[README's Kubernetes section](../../README.md#kubernetes) has a copy-paste
`securityContext` example.

```
kubectl create namespace tracery
kubectl apply -f k8s/secret.example.yaml   # replace with real keys first, or provision via OpenBao/ExternalSecret
kubectl apply -f k8s/pvc.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
```

`deployment.yaml` runs `TRACERY_STORE=sqlite` against the `pvc.yaml` volume,
reads `k8s/secret.example.yaml`'s `keys.json` via `TRACERY_API_KEYS_FILE`,
and sets `replicas: 1` with `strategy: Recreate` -- `memory`/`sqlite` are both
single-writer, so do not scale this beyond one replica unless you switch to
`TRACERY_STORE=postgres` first (see the "Storage" section above). A commented
env block in `deployment.yaml` shows that swap: point `TRACERY_POSTGRES_URL`
at an existing Postgres (via a Secret; OpenBao/ExternalSecret is the
preferred way to provision it) and drop the `data` PVC/volume/mount, then
raise `replicas` and switch `strategy` back to `RollingUpdate`.

## Extensions

`createServer(config, extensions?)` (`src/server.ts`) is the only seam this
package exposes for anything beyond what ships here (SPEC.md §7 "Extensions
and Tracery Cloud"):

```ts
export interface HubExtensions {
  onRequestAuthed?(ctx: { request: FastifyRequest; auth: AuthContext }): void | Promise<void>;
  registerRoutes?(app: FastifyInstance, ctx: HubContext): void | Promise<void>;
  onLiveFrame?(ctx: { auth: AuthContext; frame: ActivityFrame }): ActivityFrame | null;
  isLicensed?(): boolean;
}
```

- `onRequestAuthed` runs after every successful authentication (before the
  route handler), for audit logging.
- `registerRoutes` runs once at boot with the live Fastify instance and the
  same `HubContext` every built-in route uses (`config`, `store`, `metrics`,
  `keys`, `requireAuth`), for adding routes like `/v1/license` or RBAC
  filtering hooks. It runs after every built-in route is registered and
  before the UI's catch-all 404 handler, so an extensions module's routes
  are never shadowed.
- `onLiveFrame` runs from `live.ts`'s `send()` before every frame goes out
  over `WS /v1/live` -- the one send path `registerRoutes`'s Fastify `onSend`
  hook can't reach, since the live feed writes to the raw WebSocket outside
  Fastify's response pipeline. Return the frame (unchanged, or with a
  filtered `events` array) to send it, or `null` to drop it entirely.
- `isLicensed` reports whether a currently-valid license is active, re-checked
  on every call. `server.ts` uses it to decide whether to send the `x-ko-fi`
  header; `bin/hub.mjs` uses it for the one-line startup banner. Absent, or
  no extensions module at all, both mean "community".

None of these hooks are invoked by anything in this package; an extensions
module (or a test) passes them into `createServer` directly.

### Loading an extensions module: `TRACERY_EXTENSIONS_MODULE`

`bin/hub.mjs` reads `TRACERY_EXTENSIONS_MODULE` -- an npm package name
(resolved the ordinary Node way) or an absolute/relative path to a built ESM
module -- and, when set:

1. Dynamically `import()`s it.
2. Calls its exported `createExtensions(config)` (sync or `async`), passing
   the hub's own `Config` (`./config` export, below).
3. Passes the returned `HubExtensions` object into `createServer`.
4. Logs one line naming the module that loaded.

Unset (the default) means the plain community hub: no extra routes, no
`onRequestAuthed`/`onLiveFrame` hooks, `GET /v1/info` reports
`edition: "community"`. This is a **hard** dependency once configured: a bad
module name/path, an import error, a missing `createExtensions` export, or a
`createExtensions` that throws all abort startup with a clear error message
-- an operator who set this env var meant for it to load, so this never
falls back to the community edition silently.

```sh
TRACERY_EXTENSIONS_MODULE=@atriarch/tracery-cloud-ee node bin/hub.mjs   # npm package
TRACERY_EXTENSIONS_MODULE=./local-extensions/index.js node bin/hub.mjs  # local path
```

Tracery Cloud's implementation of this seam (SSO, audit log, RBAC scopes;
[`../../docs/CLOUD.md`](../../docs/CLOUD.md)) lives in the private
`tracery-cloud` repository, not here -- `HubExtensions` and
`TRACERY_EXTENSIONS_MODULE` are themselves generic and know nothing about
Tracery Cloud specifically. Anything importing this package as a library
(an extensions module included) can reach the pieces it needs via this
package's subpath exports: `.` (`createServer`, `HubContext`,
`HubExtensions`, `Config` types), `./auth` (`AuthContext`, `AuthError`,
`setSessionAuthResolver`, ...), `./store` (`EventStore`, `FlowSummary`, ...),
`./config` (`Config`, `loadConfig`, ...), and `./test-helpers`
(`testConfig`, `createTestServer`, `bearer`, ... -- so an extensions
package's own tests don't need to reach into this package's `tests/`
directory, which ships source only, not `dist`).

## Development

```
npm run build   # tsc -p tsconfig.json
npm test        # node --test tests/*.test.mjs (builds first)
npm start        # node bin/hub.mjs, reading the environment
```
