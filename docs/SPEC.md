# Tracery Graph — specification (v1)

Tracery Graph by Atriarch Systems turns agent activity events into live, inspectable graphs. An
application pushes small events ("op X started on node Y in flow Z"); the library
or the hub turns them into flows, node histories and a drawable graph. When one
flow spawns another (an agent starting a subagent), the child links to its parent
and the whole tree renders as one trace.

Three ways to use it:

1. **Library.** Import `@atriarch-systems/tracery-core` + `@atriarch-systems/tracery-react` and
   render the graph in your own app from your own event stream.
2. **Hub.** Run `@atriarch-systems/tracery-hub` as a container. Apps push events with a
   client SDK; the hub stores, sorts, serves and draws. Nothing renders in the app.
3. **Both.** Embed the React explorer in your app but point it at the hub.

## Non-goals (v1)

- Not an OpenTelemetry replacement. It carries graph-shaped activity, not spans
  with arbitrary attributes for every function call. Producers may put an OTel
  `trace_id` in `context` to cross-link.
- Not a log store. `context` is bounded (64 KB per event) and the hub sweeps by retention.
- No raw prompts, secrets or PII by default. Producers own that decision.

## Repository layout

```
packages/core          @atriarch-systems/tracery-core        contract, validation, journal, reducers, trace assembly (no DOM, no React)
packages/visualizer    @atriarch-systems/tracery-visualizer  the canvas component (moved from agentkit, Apache-2.0)
packages/react         @atriarch-systems/tracery-react       ActivityExplorer composite + hooks (live feed, hub client)
packages/client        @atriarch-systems/tracery-client      TS emitter SDK (batching HTTP transport) + hub read client
clients/python         atriarch-tracery-graph               Python emitter SDK, stdlib only, namespace package atriarch.tracery
apps/hub               @atriarch-systems/tracery-hub         standalone server + hosted UI (apps/hub/web) + Dockerfile + k8s
docs/                  SPEC.md (this), PLAN.md (workstreams), CLOUD.md
```

Tracery Cloud (accounts, SSO, audit log, RBAC, managed retention/backups --
see [`docs/CLOUD.md`](CLOUD.md)) plugs into `apps/hub` via the `HubExtensions`
seam (§7) from a private `tracery-cloud` repository; nothing in the layout
above is a paid feature.

npm workspaces, Node >= 22.13 (for `node:sqlite`), TypeScript 5, ESM only,
`node --test` for tests. Python 3.11, stdlib only, pytest for tests. CI runs on
self-hosted runners only.

## 1. Contract

The wire types live in [`packages/core/src/contract.ts`](../packages/core/src/contract.ts).
Read that file first; this section defines the semantics.

### Identity and deduplication

- `id` is the dedup key. Re-sending an event with the same id is a no-op
  (`duplicates` in the batch result). Producers retry batches freely.
- `flow` + `op` identify a call instance. One `start` per op; later `start`s for
  the same op are ignored (first wins). `update` and `annotate` may repeat. One
  `end` per op; later `end`s are ignored.
- `flow` + `node` identify a graph node. `kind`, `label` update the node when
  present; the last observed value wins.
- Edge identity is `(source node, target node, relation)` inside a flow.
  Counts are the number of distinct `start` ops observed on that edge; `end`
  and `update` never add to a count.

### Ordering

Events are processed in `(ts, seq ?? 0, arrival)` order inside a flow. Hub
consumers use the hub `cursor`. Late events for a retained flow are always
accepted and re-projected; a flow with an `end` on every op is complete but
still accepts late children (a late `start` reopens it).

### Op lifecycle

| Event | Effect on the op |
| --- | --- |
| `start` | creates the op; `status = running`; `startedAt = ts`; context merged |
| `update` | context shallow-merged; `status` applied if given (a producer may report `error` mid-op) |
| `end` | `endedAt = ts`; `status` required (default `success` if absent); `durationMs` recorded; context merged |
| `annotate` | appended to the op timeline verbatim; does not merge into context or change status |

An `end`/`update`/`annotate` whose op has no `start` still creates the op with
`startedAt = undefined` and marks the flow `partial` (evidence of a node, never an
invented call count or edge visit).

### Flow

A flow is defined by its first `root: true` start. A flow with events but no root
start is `partial`. Flow fields: `id`, `label` (root op's `label ?? name`), `actor`
(root event's actor, else first actor seen), `startedAt`, `endedAt` (max end ts
when no op is open), `status` (`error` if any op errored, else `running` if any op
open, else `unknown` if partial, else `complete`), `link`, `trace` (resolved trace
id), `ops`, `nodes`, `edges`.

### Trace resolution

`trace` for a flow = `link.trace` if set, else the `trace` of the flow named by
`link.parentFlow` if that flow is known, else `link.parentFlow` (the parent may
arrive later), else the flow's own id. A flow with no link is a trace root.
Cycles in links are broken by treating the first flow seen as the root.

### Mapping from Virali's pipeline journal (schema_version 1)

| Virali | Activity |
| --- | --- |
| `invocation_id` | `flow` |
| `operation_id` | `op` |
| `component_id` | `node` |
| `parent_operation_id`, `parent_component_id` | `parentOp`, `parentNode` |
| `event` | `type` |
| `kind`, `name`, `relation`, `root`, `status`, `duration_ms` | same, camel-cased |
| `metadata` | `context` |
| `metadata.source_component_id` | `dataFrom` |
| `timestamp` (seconds) | `ts` (milliseconds) |
| `event_id` | `id` |
| `sequence` | `seq` |

The Virali adapter is a follow-up in the Virali repo, not part of this repo.

## 2. Core reducers (`@atriarch-systems/tracery-core`)

All pure, renderer-free, importable in Node and browsers.

```ts
// validation
validateEvent(raw: unknown): { ok: true; event: ActivityEvent } | { ok: false; reason: string }
validateBatch(raw: unknown): { ok: true; batch: ActivityBatch } | { ok: false; reason: string }

// journal: bounded, deduplicating, ordered event log
class Journal { constructor(opts?: { maxEvents?: number })
  append(events: readonly ActivityEvent[]): { added: ActivityEvent[]; duplicates: number }
  events(): readonly ActivityEvent[]           // ordered
  flowIds(): readonly string[]
  eventsForFlow(flow: string): readonly ActivityEvent[]
  partial: boolean                              // true once eviction has dropped events
}

// flows
buildFlows(events: readonly ActivityEvent[]): ReadonlyMap<string, Flow>
buildFlow(events: readonly ActivityEvent[]): Flow           // single-flow fast path

interface Flow { id; label; actor?; status; partial; startedAt?; endedAt?; link?; trace;
  ops: ReadonlyMap<string, OpRecord>; nodes: ReadonlyMap<string, NodeRecord>; edges: readonly EdgeRecord[] }
interface OpRecord { id; node; name; kind?; status; startedAt?; endedAt?; durationMs?;
  parentOp?; parentNode?; root; relation; dataFrom?; context: ActivityContext;
  timeline: readonly TimelineEntry[]; tags: readonly string[] }
interface TimelineEntry { ts; type: ActivityEventType; status?; context?: ActivityContext; eventId }
interface NodeRecord { id; label; kind?; ops: readonly string[]; status; running: number;
  firstSeenAt; lastSeenAt; lastOpName?; errorCount: number }
interface EdgeRecord { source; target; relation; count; ops: readonly string[]; lastAt; kind: 'call' | 'data' }

// traces
assembleTrace(flows: ReadonlyMap<string, Flow>, anyFlowInTrace: string): Trace
interface Trace { root: string; flows: readonly Flow[]; links: readonly { parent: string; child: string; parentOp?; parentNode? }[];
  missing: readonly string[] /* parentFlow ids referenced but never observed */ }
ancestors(flows, flow): readonly string[]      // root-first chain

// projection to the visualizer contract
type Scope = { mode: 'flow'; flow: string } | { mode: 'ancestors'; flow: string } | { mode: 'trace'; trace: string }
project(flows: ReadonlyMap<string, Flow>, scope: Scope, options?: ProjectOptions): Projection
interface ProjectOptions { catalog?: (node: NodeRecord, flow: Flow) => NodePresentation; now?: number;
  history?: { keepCompletedMs?: number } }
interface Projection { nodes: ActivityNode<NodeData>[]; edges: ActivityEdge<EdgeData>[]; groups: FlowGroup[] }
interface NodeData { flow: string; node: NodeRecord; ops: OpRecord[] }
interface EdgeData { flow: string; edge: EdgeRecord }
interface FlowGroup { id: string; label: string; flow: string; nodeIds: string[]; actor?: ActivityActor; status: Flow['status'] }
```

Projection rules:

- In `flow` scope node ids are the raw `node` ids. In `ancestors` and `trace`
  scope node ids are `${actor.id ?? flow.id}::${node}` so two agents' `llm:main`
  stay apart while one agent's repeated flows in a trace merge onto shared nodes.
- Each flow in a multi-flow scope becomes a `FlowGroup`; the visualizer draws a
  hull behind its nodes. Ancestors scope renders the chain root-first, the chosen
  flow highlighted, ancestors dimmed.
- A child flow's root node gets an edge from `link.parentNode` (or the parent
  flow's root node when unknown) with `relation: 'spawn'`, `kind: 'spawn'`, and
  `layout.parentId` pointing at that node so `placeBranches` grows the subgraph
  beside its spawner.
- Node `status`: `error` if any op on it errored, `running` if any op open, else `idle`.
  `active = running > 0`. `activity.highlighted = true` for flows in scope,
  `completedAt = flow.endedAt`, `updatedAt = node.lastSeenAt`.
- `detail` = last op name; `footer` = `${ops.length} ops` (or `${errorCount} errors`).
- `dataFrom` edges have `kind: 'data'`, are dashed, and do not affect placement parents.
- Self edges (parent node === node) are suppressed but the op stays in the node history.
- `catalog` lets the caller map `kind` to `NodePresentation`; a default catalog
  ships (`agent`, `subagent`, `llm`, `tool`, `memory`, `guard`, `human`, `service`, fallback).

`@atriarch-systems/tracery-core` ships self-contained, renderer-free projection types.
A build check keeps them identical to the visualizer data contract. Import React
graph props and capture handles from `@atriarch-systems/tracery-visualizer`.

## 3. Visualizer (`@atriarch-systems/tracery-visualizer`) additions

Keep the existing contract (`VISUALIZER_CONTRACT_VERSION` becomes 2). Add:

- `ActivityNode.group?: string` and `ActivityGraphProps.groups?: readonly { id; label; accent?; dimmed?: boolean }[]`.
  Grouped nodes get a rounded convex hull drawn beneath them with the label at the
  top-left. Dimmed groups render at 45% alpha. Groups are presentation only.
- `ActivityEdge.kind?: 'call' | 'data' | 'spawn'`. `data` draws dashed; `spawn`
  draws a thicker double-headed accent and is excluded from force link strength.
- `ActivityGraphProps.onNodeActivate?: (node) => void` fired on double-click / Enter
  (used to jump into a child flow from a trace view).
- `placeBranches` accepts `edges` with `kind` and ignores `data` edges when
  choosing a parent.
- Tests for each; SSR test still passes; `npm pack` produces a tarball that Virali
  can drop into `vendor/` unchanged in shape.

## 4. React explorer (`@atriarch-systems/tracery-react`)

```tsx
<ActivityExplorer
  source={useHubSource({ baseUrl, workspace, apiKey })}   // or useJournalSource(journal)
  initialScope={{ mode: 'flow', flow }}
  catalog={myCatalog}
  renderInspector={(selection) => ...}    // optional override
/>
```

Composite of: connection status, flow picker (latest N flows, active ones first,
"follow latest" default), scope switch (This flow / With ancestors / Whole trace),
`ActivityGraph` in guided layout with `placeBranches`, an inspector panel
showing the selected node's ops newest-first with status, timing, merged context
(pretty JSON, collapsible) and the annotate timeline, and a group legend in trace
mode. Double-clicking a child flow's group (or a spawn edge target) switches scope
to that flow. Keyboard: `1/2/3` switch scope. Tailwind is not required; styles are
inline or a single CSS module with CSS variables for theming (`--tracery-bg`,
`--tracery-fg`, `--tracery-accent`).

Hooks: `useHubSource` (WS live feed with snapshot + reconnect from cursor, falls
back to polling `GET /v1/flows/:id/events?after=`), `useJournalSource` (in-process
journal), `useProjection(source, scope, options)`.

## 5. Client SDKs

### TypeScript (`@atriarch-systems/tracery-client`)

```ts
const tracer = new ActivityTracer({ transport: httpTransport({ baseUrl, apiKey, workspace }),
  actor: { id: 'agent:saga', kind: 'agent' }, flushIntervalMs: 250, maxBatch: 500 });
const flow = tracer.startFlow({ label: 'Triage CVE-2026-1234', link?: { parentFlow, parentOp, parentNode } });
const op = flow.start({ node: 'llm:main', name: 'llm.provider', kind: 'llm', parent?: parentOp, context: {...} });
op.update({ context: { tokens: 120 } }); op.annotate({ context: { note: 'retry' } });
op.end({ status: 'success', context: {...} });          // durationMs computed from performance.now()
const child = flow.spawnLink(op);                         // → ActivityLink for a subagent's startFlow
flow.end(); await tracer.flush(); await tracer.close();
```

Transports: `httpTransport` (batches, retries with backoff, never throws into
the caller, drops with a counter when the queue exceeds `maxQueue`),
`memoryTransport` (tests), `journalTransport(journal)` (in-process, feeds
`@atriarch-systems/tracery-core` directly for the library-only path). Ids are ULIDs
generated locally (no dependency; implement the 26-char Crockford ULID).

`HubClient` (read side): `listFlows`, `getFlow`, `getTrace`, `events(flow, after)`,
`live(filter, onFrame)` returning a disposer; Node and browser (`WebSocket` global).

### Python (`clients/python`, distribution `atriarch-tracery-graph`, module `atriarch.tracery`)

Same shape: `ActivityTracer`, `Flow`, `Op`, `HttpTransport` (background thread,
`queue.Queue`, `urllib.request`, bounded, never blocks the producer),
`MemoryTransport`. Context managers: `with flow.op(node=..., name=...) as op:`
ends with `error` on exception (class name only, no message). `contextvars`
carry the current flow/op so nested calls get `parentOp` without plumbing.
`flow.spawn_link(op)` returns a dict for a subagent. No third-party deps.
Type hints, `py.typed`, PEP-420 namespace (no `atriarch/__init__.py`).

## 6. Hub (`@atriarch-systems/tracery-hub`)

Fastify 5 on Node 22. Configuration by environment variables (documented in
`apps/hub/README.md`), with an in-memory loopback-only local default for the Node process. Containers
bind all interfaces and require keys or an explicit runtime auth opt-out.

### HTTP API (all under `/v1`, JSON; OpenAPI 3.1 shipped as `openapi.json` and served at `/v1/openapi.json` only when `TRACERY_OPENAPI=1`)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/events` | ingest | batch ingest; body `ActivityBatch`; returns `ActivityBatchResult`; 207 when some rejected |
| GET | `/flows` | read | list flows: `?limit=50&before=<cursor>&status=&actor=&trace=&q=` newest first |
| GET | `/flows/:id` | read | `Flow` summary + node/edge records (no events) |
| GET | `/flows/:id/events` | read | `ActivityFrame` snapshot; `?after=<cursor>` for incremental |
| GET | `/traces/:id` | read | `Trace` with all member flows |
| GET | `/traces/:id/events` | read | all events for the trace |
| GET | `/workspaces` | admin | list workspaces and their stats |
| DELETE | `/flows/:id` | admin | delete a flow and its events |
| GET | `/v1/info` | none | hub identity: `{ product, version, edition, auth, workspace? }` |
| GET | `/healthz`, `/readyz` | none | liveness / readiness |
| GET | `/metrics` | none or metrics token | Prometheus text: events ingested, rejected, duplicates, flows, store size, ws clients |
| WS | `/v1/live?workspace=&flow=&trace=&after=` | read (query `?token=` or header) | `ActivityFrame`s: snapshot then events, heartbeat every 15 s |
| GET | `/` and `/ui/*` | none (UI does its own key entry) | hosted explorer |

Errors are `{ error: { code, message } }`. Every request gets `x-request-id`.

### Auth

Two modes, resolved once at boot into `authMode: 'none' | 'keys'`:

- **`'keys'`** (`TRACERY_API_KEYS` or `TRACERY_API_KEYS_FILE` set, any host):
  the original API-key behavior. `TRACERY_API_KEYS` is a JSON array:
  `[{ "id": "saga", "key": "...", "workspace": "default", "roles": ["ingest","read"] }]`;
  or `TRACERY_API_KEYS_FILE` path. A key with `workspace: "*"` and role
  `admin` is the operator key. Keys are compared in constant time.
  `Authorization: Bearer <key>` or `x-api-key`. The workspace of a request is
  the key's workspace, or the batch/query `workspace` when the key is `*`.
  Requests never see another workspace's data.
- **`'none'`** ("local mode" -- no keys configured, and `TRACERY_HOST`
  resolves to a loopback address: `127.0.0.1`, `::1`, `localhost`; this is
  the default, so `npx @atriarch-systems/tracery-hub`/`node bin/hub.mjs` with no env
  at all lands here): every request and WS connection is a full-access
  principal on the single `default` workspace, no key ever checked or
  printed. A batch/query naming any other workspace is rejected with 400.
  `TRACERY_AUTH=none` opts into the same mode on a non-loopback host (a
  container behind its own auth/proxy/mesh); the hub logs a warning once at
  boot when this applies. With no keys configured on a non-loopback host and
  no `TRACERY_AUTH=none`, the hub fails to start with a clear error rather
  than falling back to a generated key -- there is no dev-key mode any more.

`GET /v1/info` (public, no auth) reports `{ product, version, edition, auth,
workspace? }` -- `workspace` present only in `'none'` mode -- so a client
(the hosted UI, the demo script, the Claude Code plugin) can discover which
mode a hub is running in with one unauthenticated call.

### Storage

`EventStore` interface in `apps/hub/src/store/types.ts`:
`append`, `flowEvents`, `traceEvents`, `listFlows`, `flowSummary`, `deleteFlow`,
`subscribe`, `sweep`, `stats`, `close`. Two implementations: `MemoryStore`
(default, bounded) and `SqliteStore` (`node:sqlite`, WAL, file path from
`TRACERY_SQLITE_PATH`, default `/data/tracery.db` in the container). Flow
summaries are materialised on append (a `flows` table) so listing is O(limit).
The trace id of a flow is resolved on append and stored; when a parent arrives
after a child, the child's stored trace is corrected. Postgres is a documented
follow-up behind the same interface.

### Retention

`TRACERY_RETENTION_HOURS` (default 72) and `TRACERY_MAX_EVENTS_PER_WORKSPACE`
(default 500k). A sweeper runs every minute, deletes the oldest complete flows
first, never a running flow younger than the retention window. `sweep` results
feed `/metrics`.

### Live feed

Subscribers register a filter (workspace, optional flow or trace). Ingest
fans out accepted events after the store commits. A slow client gets a 2-second
send deadline then is dropped. Reconnect with `after=<cursor>` replays from the
store; if the cursor is older than what the store holds, a `snapshot` with
`truncated: true` is sent.

### Hosted UI (`apps/hub/web`)

Vite + React 19 + `@atriarch-systems/tracery-react`. Built to `apps/hub/web/dist` and
served by the hub as static files. First load asks for a read key (kept in
`sessionStorage`), then shows the workspace's flows. Deep links:
`/ui/flows/:id`, `/ui/traces/:id`.

### Packaging

- `apps/hub/Dockerfile`: multi-stage, builds workspaces, final shell-less runtime
  (`FROM scratch` + the pinned Node binary + the pinned Alpine libraries it links
  against, installed with `apk --root`; no busybox or apk) with only the hub's
  production dependency closure. App code is root-owned and read-only to the
  numeric non-root user `10001:10001`; only `/data` belongs to it. `VOLUME /data`,
  `EXPOSE 8971`, exec-form `HEALTHCHECK` on `/healthz`. Runs under
  `--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges`.
  The `sources-image` target builds the companion `<version>-sources` image with
  the matching OS package sources (`licenses/CONTAINER-REVIEW.md`).
- `apps/hub/docker-compose.yaml`: hub + volume, example keys file; read-only root,
  `/tmp` tmpfs, all capabilities dropped, `no-new-privileges`.
- `apps/hub/k8s/`: Deployment, Service, PVC, example Secret; plain manifests (Kustomize-friendly).
  The Deployment (and the Helm chart) runs as `10001`, read-only root filesystem,
  capabilities dropped, with an `emptyDir` at `/tmp`.
- `npx @atriarch-systems/tracery-hub` starts the server (bin entry).

## 7. Extensions and Tracery Cloud

Original Tracery Graph code is **Apache-2.0**; third-party files retain their own licenses.
There is no commercial layer or runtime commercial-license
gate in the community hub. The hub exposes exactly one seam for
anything beyond what ships here: `HubExtensions`
(`apps/hub/src/server-context.ts`) --

```ts
export interface HubExtensions {
  onRequestAuthed?(ctx: { request: FastifyRequest; auth: AuthContext }): void | Promise<void>;
  registerRoutes?(app: FastifyInstance, ctx: HubContext): void | Promise<void>;
  onLiveFrame?(ctx: { auth: AuthContext; frame: ActivityFrame }): ActivityFrame | null;
  isLicensed?(): boolean;
}
```

-- loaded at startup from an operator-supplied module named by
`TRACERY_EXTENSIONS_MODULE` (`apps/hub/README.md` "Extensions", `apps/hub/bin/hub.mjs`):
a package name or an absolute/relative path to a module exporting an
async-or-sync `createExtensions(config)` that returns a `HubExtensions`
object. Unset (the default, and what every test/CI run in this repository
exercises) means the plain community hub: no extra routes, `GET /v1/info`
reports `edition: "community"`, and there is no `/v1/license` route at all.

**Tracery Cloud** is Atriarch Systems' managed service built on this seam --
accounts, seats, SSO (OIDC), an audit log, RBAC scopes, managed retention and
backups, and support. Its implementation (a `HubExtensions` module, a
license-key format, and the future managed-service layer -- billing, quotas,
metering, a status page) lives in a private repository (`tracery-cloud`), not
here; see [`docs/CLOUD.md`](CLOUD.md) for what it offers and how self-hosted
enterprise is available on request. `HubExtensions` itself is generic and
Apache-2.0 -- anyone can write a different module against the same seam.

## 8. Testing and acceptance

Every package has `npm test` using `node --test` against `dist/` (build first,
same convention as the visualizer). Python uses pytest. Acceptance for the whole
repo, executed by the integration workstream:

1. `npm ci && npm run build && npm test` green at the root on Node 22.
2. `python -m pytest clients/python` green on 3.11 (3.13 acceptable locally).
3. `docker build -f apps/hub/Dockerfile .` succeeds; `docker run` with no env
   fails closed; explicit `TRACERY_AUTH=none` on a loopback-published port serves `/healthz`,
   `/v1/info`, `/ui/` (and `/v1/openapi.json` with `TRACERY_OPENAPI=1`).
4. A demo script (`scripts/demo.mjs`) drives the TS client to emit a parent flow
   that spawns two child flows (one via the Python client), then asserts through
   the hub API that: the trace has three flows; the child trace ids equal the
   parent flow id; `project(trace)` has two `spawn` edges; the live WS delivered
   every event with a monotonic cursor; a duplicate resend reports `duplicates`.
5. Playwright (`apps/hub/web/tests`) loads the hosted UI against the demo data
   and checks: the flow list shows three flows, the trace scope shows three
   groups, clicking a node shows its context in the inspector, double-clicking a
   child group switches scope.
6. Reduced motion, SSR import, and the visualizer's existing tests still pass.

## 9. Decisions owed to Dan

- Product name and npm org. Working name "Tracery Graph", scope `@atriarch-systems/tracery-*`, hub image `atriarchsystems/tracery-hub`.
- Commercial/license terms for Tracery Cloud and self-hosted enterprise -- now entirely
  the private `tracery-cloud` repository's concern, not this one's.
- Whether to publish to npmjs.com or only the internal Nexus.
- Whether Virali's dashboard switches to the hub or keeps its embedded journal.
