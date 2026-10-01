# Tracery Graph

<a href="https://github.com/Atriarch-Systems/tracery-graph/actions/workflows/ci.yaml"><img src="https://github.com/Atriarch-Systems/tracery-graph/actions/workflows/ci.yaml/badge.svg?branch=main" alt="CI status"></a>

Tracery Graph by Atriarch Systems turns agent activity into live, inspectable graphs. A program sends small events such as "op X started on node Y in flow Z"; the hub (or the embedded library) turns them into flows, per-node histories and a graph you can watch while it grows or open again later.

- **Live graphs from small events.** Four event types (`start`, `update`, `end`, `annotate`) are the whole input. Nodes, edges and call counts are derived from them, never declared.
- **Subagent flows join one trace.** A flow started by another flow names its parent in `link.parentFlow`. Every flow linked that way renders as one trace, even when the parent arrives after the child.
- **Self-hosted, no account.** The hub is one Node process or container. With no configuration it binds `127.0.0.1`, keeps events in memory and needs no API key.
- **Context stays with the producer.** Payload `context` is optional and bounded. Share links hide it by default and show only its key names and size.
- **Library, hub, SDKs and plugin.** Embed the React explorer in your own app, run the hub, send events from TypeScript, Python or plain HTTP, or stream a Claude Code session with the plugin.

The graph is `Workspace → Trace → Flow → Node → Op`.

<p align="center">
  <img src="docs/images/hero.gif" alt="Tracery Graph drawing a live trace: an orchestrator plans and searches, spawns two subagents (one succeeds, one errors), while a guard check and a human approval run concurrently — all rendered live as the graph grows" width="900">
</p>

<p align="center">
  <em>An orchestrator plans, searches, and spawns two subagents — one succeeds, one hits an error — while a guard
  check and a human approval run alongside them. Captured live from the real hosted UI; no editing.
  More in <a href="docs/DEMOS.md">docs/DEMOS.md</a>.</em>
</p>

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Sending events](#sending-events)
- [Viewing graphs](#viewing-graphs)
- [Hub reference](#hub-reference)
- [Behavior and limits](#behavior-and-limits)
- [Docker](#docker)
- [Kubernetes](#kubernetes)
- [Claude Code plugin](#claude-code-plugin)
- [Packages](#packages)
- [Development](#development)
- [Licensing](#licensing)
- [Tracery Cloud](#tracery-cloud)
- [Support](#support)
- [Further reading](#further-reading)

## Install

**From package registries** (npm and npx need Node.js >=22.13, which provides `node:sqlite`):

```sh
npm install @atriarch-systems/tracery-client                                # emitter SDK + hub read client
npm install @atriarch-systems/tracery-core @atriarch-systems/tracery-react   # embed the explorer
npx @atriarch-systems/tracery-hub                                          # run the hub
docker pull atriarchsystems/tracery-hub:0.1.1
```

The Python client is not on PyPI yet. Install it from a checkout (Python >=3.11, no dependencies):

```sh
git clone https://github.com/Atriarch-Systems/tracery-graph.git
python -m pip install ./tracery-graph/clients/python
```

**From source**, for contributors or to run the latest `main` (Node.js >=22.13):

```sh
git clone https://github.com/Atriarch-Systems/tracery-graph.git   # add --branch v0.1.1 for the tagged release
cd tracery-graph
npm ci
npm run build
python -m pip install ./clients/python   # optional, the Python client
```

## Quick start

Start the hub. With no environment variables it listens on `127.0.0.1:8971`, stores events in memory, and runs in local mode: one `default` workspace and no API key.

```text
$ npx @atriarch-systems/tracery-hub
{"level":30,...,"msg":"Server listening at http://127.0.0.1:8971"}
{"level":30,...,"msg":"Tracery Graph hub: http://127.0.0.1:8971  (local mode, no auth; set TRACERY_API_KEYS or bind a non-loopback host to require keys)"}
{"level":30,...,"msg":"store: memory"}
```

Node 22 also prints an `ExperimentalWarning` for `node:sqlite` at startup; it does not affect the memory store. From a source checkout, `node apps/hub/bin/hub.mjs` starts the same hub.

In a second terminal, write a flow with two ops (the root op and one tool call) as an `ActivityBatch`. `ts` is epoch milliseconds:

```sh
NOW=$(date +%s000)
cat > batch.json <<EOF
{"v":1,"events":[
  {"v":1,"id":"e1","ts":$NOW,"flow":"demo-1","op":"root","node":"agent:demo","type":"start","name":"flow","kind":"agent","label":"Demo run","root":true},
  {"v":1,"id":"e2","ts":$((NOW+100)),"flow":"demo-1","op":"search-1","node":"tool:search","type":"start","name":"tool.call","kind":"tool","parentOp":"root","parentNode":"agent:demo"},
  {"v":1,"id":"e3","ts":$((NOW+650)),"flow":"demo-1","op":"search-1","node":"tool:search","type":"end","name":"tool.call","status":"success","durationMs":550,"context":{"hits":7}},
  {"v":1,"id":"e4","ts":$((NOW+700)),"flow":"demo-1","op":"root","node":"agent:demo","type":"end","name":"flow","status":"success","durationMs":700}
]}
EOF
```

Send it twice, then read it back:

```text
$ curl -s -X POST http://127.0.0.1:8971/v1/events -H "content-type: application/json" -d @batch.json
{"accepted":4,"duplicates":0,"rejected":[],"cursor":4}

$ curl -s -X POST http://127.0.0.1:8971/v1/events -H "content-type: application/json" -d @batch.json
{"accepted":0,"duplicates":4,"rejected":[],"cursor":4}

$ curl -s http://127.0.0.1:8971/v1/flows
{"flows":[{"id":"demo-1","label":"Demo run","status":"complete","partial":false,"startedAt":1790399940000,"endedAt":1790399940700,"trace":"demo-1","ops":{...},"nodes":{...},"edges":[...]}]}

$ curl -s http://127.0.0.1:8971/v1/flows/demo-1
{"id":"demo-1","label":"Demo run","status":"complete",...,"ops":{"root":{...},"search-1":{"id":"search-1","node":"tool:search","name":"tool.call","kind":"tool","status":"success",...,"durationMs":550,"parentOp":"root","parentNode":"agent:demo",...,"context":{"hits":7},...}},"nodes":{"agent:demo":{...},"tool:search":{...}},"edges":[{"source":"agent:demo","target":"tool:search","relation":"invoke","count":1,"ops":["search-1"],"lastAt":1790399940650,"kind":"call"}]}
```

The second send is a no-op because event ids are the deduplication key. Open <http://127.0.0.1:8971/ui/> to see the graph, or go straight to <http://127.0.0.1:8971/ui/flows/demo-1>.

The same thing from the TypeScript client, with a subagent flow linked to the parent. Install it with `npm install @atriarch-systems/tracery-client`, then save this as `trace-demo.mjs` in the same directory:

```js
import { ActivityTracer, HubClient, httpTransport } from '@atriarch-systems/tracery-client';

const baseUrl = 'http://127.0.0.1:8971';
const tracer = new ActivityTracer({ transport: httpTransport({ baseUrl }), actor: { id: 'agent:main', kind: 'agent' } });
const flow = tracer.startFlow({ label: 'Plan a trip' });
const plan = flow.start({ node: 'llm:main', name: 'llm.call', kind: 'llm', parent: flow.rootOp });
plan.end({ context: { tokens: 812 } });
const sub = tracer.startFlow({ label: 'Book hotel', link: flow.spawnLink(plan), actor: { id: 'agent:main/sub:hotel', kind: 'subagent' } });
sub.start({ node: 'tool:search', name: 'tool.call', kind: 'tool', parent: sub.rootOp }).end();
sub.end(); flow.end(); await tracer.close();
const trace = await new HubClient({ baseUrl }).getTrace(flow.id);
for (const f of trace.flows) console.log(f.label, f.status, f.edges.map((e) => `${e.source} -> ${e.target}`), `trace=${f.trace}`);
console.log(trace.links);
```

```text
$ node trace-demo.mjs
Plan a trip complete [ 'agent:main -> llm:main' ] trace=01M3E2F6JPE6JGAA1M0S00DYYN
Book hotel complete [ 'agent:main/sub:hotel -> tool:search' ] trace=01M3E2F6JPE6JGAA1M0S00DYYN
[
  {
    parent: '01M3E2F6JPE6JGAA1M0S00DYYN',
    child: '01M3E2F6JVF9CY40JPMM2Z8P1G',
    parentOp: '01M3E2F6JVF9CY40JPMM2Z8P1D',
    parentNode: 'llm:main'
  }
]
```

Both flows resolve to the parent's trace id. Flow and op ids are ULIDs generated by the client. An op gets an edge only from an explicit `parent`; neither client infers one from call order.

From Python, after installing the client from a checkout (see [Install](#install)), save this as `trace_demo.py`:

```python
from atriarch.tracery import ActivityTracer, HttpTransport

tracer = ActivityTracer(transport=HttpTransport(base_url="http://127.0.0.1:8971"),
                        actor={"id": "agent:py", "kind": "agent"})
flow = tracer.start_flow(label="Summarize inbox")
with flow.op(node="tool:mail", name="tool.call", kind="tool", parent=flow.root_op) as op:
    op.update(context={"messages": 12})
flow.end()
tracer.close()
print(flow.id)
```

```text
$ python trace_demo.py
01M3E2F6WBTCJT3RAC80CAAE6C

$ curl -s http://127.0.0.1:8971/v1/flows/01M3E2F6WBTCJT3RAC80CAAE6C
{"id":"01M3E2F6WBTCJT3RAC80CAAE6C","label":"Summarize inbox","actor":{"id":"agent:py","kind":"agent"},"status":"complete",...,"edges":[{"source":"agent:py","target":"tool:mail","relation":"invoke","count":1,...,"kind":"call"}]}
```

Against a hub with keys, pass `apiKey` (TypeScript) or `api_key` (Python) with the `ingest` role. When it is omitted, neither client sends a credential.

## Sending events

| Producer | What it does | Reference |
|---|---|---|
| TypeScript client (`@atriarch-systems/tracery-client`) | Queues events and flushes every 250 ms, up to 500 per request. Retries network errors and 5xx with backoff, drops 4xx, never throws into the caller. Also has `HubClient` for reads and `journalTransport` for in-process use with no hub. | [packages/client/README.md](packages/client/README.md) |
| Python client (`atriarch-tracery-graph`, module `atriarch.tracery`) | Stdlib only. A background thread sends batches; `with flow.op(...)` ends the op as `success` or `error` and sets an implicit parent for nested ops. | [clients/python/README.md](clients/python/README.md) |
| Raw HTTP | `POST /v1/events` with an `ActivityBatch`, from any language. | [Event model](#event-model), [HTTP API](#http-api) |
| Claude Code plugin | Turns a Claude Code session, its tool calls and its subagents into linked flows. | [Claude Code plugin](#claude-code-plugin) |

### Event model

The wire contract is [`packages/core/src/contract.ts`](packages/core/src/contract.ts); [docs/SPEC.md](docs/SPEC.md) §1 defines its semantics.

- **Workspace**: an isolated partition of the hub. An API key is bound to one; local mode serves only `default`.
- **Trace**: a tree of flows joined by links on each child flow's root `start`.
- **Flow**: one run of work that produces one graph: an invocation, a job, a session.
- **Node**: a reusable component identity inside a flow (`llm:main`, `tool:search`). Many ops can land on one node, and the node keeps their history.
- **Op**: one call instance inside a flow. Its `start`, `update` and `end` events share the op id.

A request body is `{ "v": 1, "workspace"?: string, "events": ActivityEvent[] }`. The response is `{ accepted, duplicates, rejected: [{ index, reason }], cursor }`.

| Field | Required | Meaning |
|---|---|---|
| `v` | yes | Contract version; must be `1`. |
| `id` | yes | Globally unique event id and the deduplication key. ULID or UUID recommended. |
| `ts` | yes | Epoch milliseconds at the producer. |
| `seq` | no | Producer-side monotonic sequence within the flow. The hub assigns its own cursor. |
| `flow` | yes | Flow id. |
| `op` | yes | Op id; the events of one call share it. |
| `node` | yes | Node id inside the flow. |
| `type` | yes | `start`, `update`, `end` or `annotate`. |
| `name` | yes | Operation name, e.g. `llm.provider`, `tool.call`, `memory.retrieve`. |
| `kind` | no | Node category for presentation catalogs: `llm`, `tool`, `agent`, ... |
| `label` | no | Human label for the node. |
| `relation` | no | Edge purpose from the parent node to this node: `invoke`, `deliver`, `listen`. Defaults to `invoke`. |
| `parentOp` | no | Explicit call-context parent inside the same flow. Never inferred from arrival order. |
| `parentNode` | no | The parent op's node, so the edge can render before the parent's events arrive. |
| `root` | no | `true` when the op began with no parent in its flow. The first root `start` defines the flow. |
| `dataFrom` | no | This op consumed the output of that node. Draws a dashed data edge without implying call parentage. |
| `status` | no | `running`, `success`, `error`, `cancelled` or `skipped`. Expected on `end`; `success` when absent. |
| `durationMs` | no | Elapsed time reported on `end`. |
| `actor` | no | `{ id, name?, kind? }`: who ran the flow. Trace views namespace node ids by actor. |
| `link` | no | Only meaningful on a flow's root `start`: `{ parentFlow, parentOp?, parentNode?, trace? }`. |
| `context` | no | Free JSON. `start`/`update`/`end` contexts are shallow-merged into the op in event order. |
| `tags` | no | Up to 32 strings. |

| Type | Effect on the op |
|---|---|
| `start` | Creates the op with `status: running`. Later `start`s for the same op are ignored. |
| `update` | Merges `context`; applies `status` if given (an op may report `error` mid-flight). |
| `end` | Sets `endedAt`, `status` and `durationMs`; merges `context`. Later `end`s are ignored. |
| `annotate` | Appends a timeline entry. Does not merge context or change status. |

**Flows.** A flow's label is its root op's `label ?? name`. Its status is `error` if any op errored, else `running` if any op is open, else `unknown` if the flow is partial, else `complete`. An edge's count is the number of distinct `start` ops on it.

**Linking flows into traces.** A child flow puts `link` on its root `start` event. Its trace id is `link.trace` if set, else the parent's trace id if the parent flow is known, else `link.parentFlow`. A flow with no link is a trace root. The clients build the link for you: `flow.spawnLink(op)` in TypeScript, `flow.spawn_link(op)` in Python. The graph draws a `spawn` edge from `link.parentNode` (or the parent's root node) to the child's root node. Set `link.trace` when the parent flow may never reach the same hub.

**Context and redaction.** Put only what a viewer should see in `context`. The contract says producers must not put raw prompts, secrets or PII there unless their hub is scoped for it; the hub cannot tell. A share created without `includeContext` replaces every context value with its shape, `{"_redacted": true, "keys": [...], "bytes": n}`. HTML exports include context unless you ask for `?context=false`. A redacted share is not anonymized: labels, node ids and op names still show. A downloaded export cannot be revoked.

## Viewing graphs

### Hosted UI

The hub serves the explorer at `/ui/` (`/` redirects there). In local mode it opens directly. With keys configured it asks for a key with the `read` role once and keeps it in `sessionStorage`.

- **Flow list.** Active flows first. "Follow latest" keeps the newest flow selected until you pick one. Deep links: `/ui/flows/<id>` and `/ui/traces/<id>`.
- **Scopes.** *This flow*, *With ancestors* (the parent chain, root first, ancestors dimmed) and *Whole trace*. In the last two, each flow is drawn inside a group hull and node ids are namespaced by actor, so two agents' `llm:main` stay apart.
- **Inspector.** Click a node to see its ops newest first, with status, timing, merged context and annotations. Double-click a node that belongs to another flow to switch to that flow.
- **Layout.** The graph uses guided layout: a child flow grows beside the node that spawned it. Drag a node to move it, or drag inside a group's hull, away from any node, to move the whole group. Moved positions last until the page reloads.
- **Fade.** A flow's nodes stay highlighted while it runs. When the flow ends (`completedAt` is the flow's `endedAt`), its highlight fades out over about a second.
- **Settings.** The gear button picks a theme preset (`dark`, `light`, `high-contrast`, `ocean`) and four color overrides. The choice is kept in `localStorage` and applies to the main explorer, not to share or export views.

| Key | Action |
|---|---|
| `1` / `2` / `3` | This flow / With ancestors / Whole trace (ignored in text fields and with Ctrl, Cmd or Alt) |
| Arrow keys | Select the next or previous node (graph focused) |
| `Enter` | Open the selected node's flow, when it belongs to another flow |
| `F` | Fit the graph to the view |
| `Escape` | Clear the selection |

### Sharing

On a flow or trace deep link, **Share** creates a link at `/s/<token>` that needs no API key. A `snapshot` share (the default) is frozen at the moment it was created; a `live` share keeps streaming. Context is hidden unless the sharer includes it. Shares expire after 30 days by default (or `"never"`) and can be revoked. **Download image** saves the current view as a PNG, and **Export .html** downloads one self-contained file that renders the same explorer offline; in local mode, where a link is useless to anyone else, the dialog lists the export first. Details, including Open Graph previews and `TRACERY_PUBLIC_URL`: [docs/SHARING.md](docs/SHARING.md).

### Embedding

Render the explorer in your own React app from an in-process journal (no hub):

```tsx
import { useMemo } from 'react';
import { Journal } from '@atriarch-systems/tracery-core';
import { ActivityExplorer, useJournalSource, THEME_PRESETS } from '@atriarch-systems/tracery-react';

function MyPage() {
  const journal = useMemo(() => new Journal({ maxEvents: 20_000 }), []);
  // journal.append(events) as your app produces them, or
  // new ActivityTracer({ transport: journalTransport(journal) }) from @atriarch-systems/tracery-client
  const source = useJournalSource(journal);
  return <div style={{ height: '100vh' }}><ActivityExplorer source={source} theme={THEME_PRESETS.light} /></div>;
}
```

or from a running hub (live WebSocket, falling back to polling):

```tsx
import { ActivityExplorer, useHubSource } from '@atriarch-systems/tracery-react';

function MyPage() {
  // apiKey is optional against a local-mode hub.
  const source = useHubSource({ baseUrl: 'http://127.0.0.1:8971', workspace: 'default' });
  return <div style={{ height: '100vh' }}><ActivityExplorer source={source} /></div>;
}
```

A browser page on another origin must be listed in the hub's `TRACERY_ALLOWED_ORIGINS`. [`examples/generator`](examples/generator) is a small app that draws sample flows with no hub and can also push them to one.

## Hub reference

### Environment variables

Every variable has a default; `node apps/hub/bin/hub.mjs` with none set works. Invalid numbers, store names, origins or key lists stop the hub at boot with an error.

| Variable | Default | Meaning |
|---|---|---|
| `TRACERY_PORT` | `8971` | Listen port (integer 1-65535). |
| `TRACERY_HOST` | `127.0.0.1` | Listen host. `127.0.0.1`, `::1` and `localhost` count as loopback. The Docker image sets `0.0.0.0`. |
| `TRACERY_STORE` | `memory` | `memory`, `sqlite` or `postgres`. Any other value fails at boot. |
| `TRACERY_SQLITE_PATH` | `/data/tracery.db` | SQLite file, used when `TRACERY_STORE=sqlite`. |
| `TRACERY_POSTGRES_URL` | unset | `postgres://...` connection string. Required when `TRACERY_STORE=postgres`. |
| `TRACERY_API_KEYS` | unset | JSON array of keys: `[{"id","key","workspace","roles"}]`. Setting it selects keys mode. |
| `TRACERY_API_KEYS_FILE` | unset | Path to a file with the same JSON. Ignored when `TRACERY_API_KEYS` is set. |
| `TRACERY_AUTH` | unset | `none` runs a non-loopback hub with no authentication of its own. Ignored when keys are set. |
| `TRACERY_RETENTION_HOURS` | `72` | Retention window in hours; must be greater than 0. |
| `TRACERY_MAX_EVENTS_PER_WORKSPACE` | `500000` | Per-workspace event cap enforced by the sweeper, not at ingest. |
| `TRACERY_METRICS_TOKEN` | unset | When set, `/metrics` requires it (`?token=`, `x-metrics-token` or `Authorization: Bearer`). |
| `TRACERY_LOG_LEVEL` | `info` | Pino log level. |
| `TRACERY_OPENAPI` | unset (off) | `1` serves the pre-generated OpenAPI document at `/v1/openapi.json`, without authentication. Off by default. |
| `TRACERY_UI_DIR` | `apps/hub/web/dist` | Directory served at `/ui/`. Without an `index.html` there, `/ui/` shows a "not built" page. |
| `TRACERY_PUBLIC_URL` | unset | Public origin used for share URLs and Open Graph tags; trailing slashes are removed. Unset means the request's own origin. |
| `TRACERY_ALLOWED_ORIGINS` | unset | Comma-separated exact `http(s)` origins, no paths or wildcards, that browsers may call the hub from. |
| `TRACERY_EXTENSIONS_MODULE` | unset | npm package or path of an extensions module (read by `bin/hub.mjs`). A load failure stops the hub. See [apps/hub/README.md](apps/hub/README.md#extensions). |

**Browser origins.** A request without an `Origin` header (the SDKs, curl) is allowed. A browser request must come from the hub's own origin, `TRACERY_PUBLIC_URL`, or an origin in `TRACERY_ALLOWED_ORIGINS`; anything else, including `Origin: null`, gets `403 origin_forbidden`. In local mode the `Host` must also be a loopback name or the `TRACERY_PUBLIC_URL` host, which blocks DNS rebinding. Origin checks never replace authentication.

### Auth modes

The mode is decided once at boot and reported by `GET /v1/info`:

1. `TRACERY_API_KEYS` or `TRACERY_API_KEYS_FILE` set: **keys mode**, on any host. `TRACERY_API_KEYS='[]'` is refused.
2. No keys, loopback host: **local mode**. Every request has every role on the `default` workspace. A request naming another workspace gets `400 workspace_not_local`.
3. No keys, non-loopback host, `TRACERY_AUTH=none`: local mode, with a warning logged at boot. Use it only behind a proxy, mesh or network policy that authenticates.
4. No keys, non-loopback host, no `TRACERY_AUTH=none`: **the hub refuses to start** (`TRACERY_HOST is not loopback and no API keys are configured; ...`).

In keys mode a key has roles from `ingest`, `read` and `admin`, and is bound to one workspace. A key with workspace `"*"` is the operator key; it must include `admin` and must name a workspace on each request. Present a key as `Authorization: Bearer <key>` or `x-api-key: <key>`, or `?token=<key>` on WebSockets. Keys are compared in constant time. A missing or unknown key gets `401`; a missing role or another workspace gets `403`. The key file format is in [apps/hub/README.md](apps/hub/README.md#api-key-file-format).

### HTTP API

JSON everywhere; errors are `{ "error": { "code", "message" } }`; every response carries `x-request-id`. The OpenAPI 3.1 document ships in the hub package as `openapi.json` (generated at build time) and is served at `GET /v1/openapi.json` only when `TRACERY_OPENAPI=1`.

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/v1/info` | none | `{ product, version, edition, auth, workspace? }`; `workspace` only in local mode. |
| GET | `/healthz` | none | Liveness: `{"status":"ok"}`. |
| GET | `/readyz` | none | Readiness: the store answered; `503` otherwise. |
| GET | `/metrics` | none, or metrics token | Prometheus text: ingested, rejected and duplicate events, flows, stored events, WebSocket clients, sweeps. |
| GET | `/v1/openapi.json` | none | OpenAPI document. Only when `TRACERY_OPENAPI=1`; otherwise `404`. |
| POST | `/v1/events` | ingest | Ingest an `ActivityBatch`. `200` all accepted, `207` some rejected, `400` bad envelope or over 1000 events. |
| GET | `/v1/flows` | read | Flows, most recent activity first. `limit` (default 50, max 1000), `before` (the previous page's `nextBefore`), `status`, `actor`, `trace`, `q` (label substring). |
| GET | `/v1/flows/:id` | read | Flow summary: ops, nodes, edges; no events. |
| GET | `/v1/flows/:id/events` | read | Snapshot frame, or with `?after=<cursor>` only newer events. |
| DELETE | `/v1/flows/:id` | admin | Delete a flow and its events. |
| GET | `/v1/traces/:id` | read | Every flow in the trace, its links and any `missing` parents. |
| GET | `/v1/traces/:id/events` | read | Every event of every flow in the trace. |
| GET | `/v1/workspaces` | admin | Per-workspace stats. Only the operator key sees all workspaces. |
| WS | `/v1/live?workspace=&flow=&trace=&after=&token=` | read | A `snapshot` frame, then `events` frames, and a `heartbeat` every 15 s. |
| GET | `/v1/flows/:id/export.html`, `/v1/traces/:id/export.html` | read | Self-contained offline HTML file. `?context=false` redacts context. |
| POST | `/v1/shares` | read | Create a share: `{ target: { type, id }, mode?, includeContext?, expiresInDays? }` returns `{ id, token, url }`. |
| GET | `/v1/shares` | read | List your shares (all shares for an `admin` key); tokens are never listed. |
| DELETE | `/v1/shares/:id` | read, creator or admin | Revoke a share. |
| PUT | `/v1/shares/:id/preview` | read, creator or admin | Upload a PNG preview (`Content-Type: image/png`, max 2 MB). |
| GET | `/v1/shares/:token/meta`, `/flow`, `/trace`, `/events`, `/preview.png` | none (the token) | Public read through one share. Unknown, expired and revoked tokens all return the same `404`. |
| WS | `/v1/shares/:token/live` | none (the token) | Live frames for a `live` share; closes for a `snapshot` share. |
| GET | `/s/:token` | none | The share page, with Open Graph tags for link previews. |
| GET | `/`, `/ui/*` | none | The hosted UI (it handles key entry itself). |

### Storage

| Store | Persists | Replicas | Use it for |
|---|---|---|---|
| `memory` (default) | No; lost on restart | One | Laptops, demos, trying the plugin. |
| `sqlite` | Yes, one WAL-mode file at `TRACERY_SQLITE_PATH` | One (single writer) | A single self-hosted hub. In the container the file is `/data/tracery.db` on the `/data` volume. |
| `postgres` | Yes, in the database at `TRACERY_POSTGRES_URL` | Several | More than one hub replica, or high availability. |

All three reduce events with the same core code, so they return the same flows. `sqlite` and `postgres` also keep a `flows` table, so a restart reloads flows without re-reducing every event. Retention works the same way for every store: see [Retention](#retention).

## Behavior and limits

### Ingest does not trust arrival order

- **Deduplication.** An event whose `id` is already stored in that workspace is counted in `duplicates` and ignored. Retrying a batch is always safe.
- **Ordering.** Inside a flow, events are applied in `(ts, seq ?? 0, arrival)` order. Consumers of the hub follow its `cursor`, which only grows.
- **Late events.** Events for a retained flow are always accepted and re-projected. A late `start` reopens a flow that looked complete.
- **Partial flows.** An `update`, `end` or `annotate` whose op has no `start` still creates the op, without a start time, and marks the flow `partial`. No call count or edge is invented for it.
- **Late parents.** When a parent flow arrives after its child, the child's stored trace id is corrected. Link cycles are broken by treating the first flow seen as the root.

### Failures stay per event

A batch whose events are all valid is stored whole. Otherwise each event is validated on its own: valid ones are stored, and each invalid one is listed in `rejected` with its index and reason, with status `207`:

```text
{"accepted":1,"duplicates":0,"rejected":[{"index":1,"reason":"event.ts must be a finite number"}],"cursor":17}
```

Only a malformed envelope (`v` not `1`, `events` not an array, an empty `workspace`) or more than 1000 events rejects the whole request.

### Limits

These are `ACTIVITY_LIMITS` in `contract.ts`:

| Limit | Value |
|---|---|
| Events per batch | 1000 |
| Serialized size of one event | 64 KiB |
| Length of an event `id` | 256 characters |
| Tags per event | 32 |
| `context` nesting depth | 32 |
| JSON values inside one `context` | 10,000 |

The request body limit is 1000 × 64 KiB, so a batch within these limits is never cut off by the HTTP layer; a larger body gets `413 body_too_large`.

### Retention

A sweeper runs every 60 seconds and deletes whole flows. A flow's age is its `startedAt`, which is the producer's `ts` on the root `start` (for a partial flow, the time its last event arrived). Flows past `TRACERY_RETENTION_HOURS` are deleted, complete flows first and oldest first; while a workspace is over `TRACERY_MAX_EVENTS_PER_WORKSPACE`, younger complete flows go too. A flow that is not complete and is younger than the window is never swept. A running flow older than the window is swept like any other, so a producer that never sends `end` cannot pin data forever. Events sent with old timestamps are swept within a minute of arriving.

### Live feed

A live subscriber gets a `snapshot` frame, then `events` frames after each commit, and a `heartbeat` every 15 seconds. A client that does not take a frame within 2 seconds is disconnected. Reconnect with `after=<cursor>` to resume; if that cursor is older than what the store still holds, the hub sends a new snapshot with `truncated: true` instead of leaving a gap. The TypeScript `HubClient.live` and `useHubSource` reconnect with backoff; `useHubSource` falls back to polling after two failed sockets.

### Shares

Public share routes (`/v1/shares/:token/*` and the share WebSocket) are limited to 60 requests per minute per client IP, with an in-memory bucket per hub replica. Over the limit, HTTP gets `429 rate_limited` and the WebSocket closes with `4429`. Revoking or expiring a share closes its open live sockets.

### When the plugin cannot reach the hub

The Claude Code plugin appends every event to an on-disk spool before sending. It sends in batches of up to 1000 with a 2-second timeout; a batch that gets any `2xx` (including `207`) is removed, and a failure leaves it and everything after it for the next hook call. The hook always exits 0 and never blocks the session. A spool that grows and does not shrink means the hub is unreachable or rejects the key.

## Docker

The image binds `0.0.0.0`, so it needs keys or an explicit opt-out. For a local trial, opt out and publish the port on loopback only:

```sh
docker run --rm -p 127.0.0.1:8971:8971 -e TRACERY_AUTH=none atriarchsystems/tracery-hub:0.1.1
```

For anything another person or machine reaches, configure keys, keep data on a named volume and lock the container down:

```sh
docker run -d --name tracery-hub -p 8971:8971 \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  -e TRACERY_STORE=sqlite -v tracery-data:/data \
  -e TRACERY_API_KEYS='[{"id":"me","key":"CHANGE_ME","workspace":"default","roles":["ingest","read","admin"]}]' \
  atriarchsystems/tracery-hub:0.1.1
```

Use `--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges` for every hub container. The hub writes only to `/data` and `/tmp`, needs no Linux capabilities and never needs to gain privileges.

To build the image yourself, run this from the repository root:

```sh
docker build -f apps/hub/Dockerfile -t atriarchsystems/tracery-hub:dev .
```

`TRACERY_API_KEYS_FILE` also works with a Docker secret or a read-only bind mount. [`apps/hub/docker-compose.yaml`](apps/hub/docker-compose.yaml) runs the hub with SQLite and a keys file, and its `postgres` profile adds a throwaway Postgres. Its services use the same read-only, no-capabilities settings.

Image facts (from [`apps/hub/Dockerfile`](apps/hub/Dockerfile)). These describe the hardened image, which ships from v0.1.2; notes in brackets say how 0.1.1 differs.

- Runtime: `FROM scratch` with the Node 22.23.2 binary from `node:22.23.2-alpine3.24` and only the six Alpine packages it needs (musl, libgcc, libstdc++, ca-certificates-bundle, alpine-release, alpine-keys), all pinned. No shell, busybox, apk, npm, Corepack or Yarn. [0.1.1: an `alpine:3.24.2` base that includes busybox.]
- Runs as uid/gid `10001`. The `USER` is numeric, so Kubernetes `runAsNonRoot` can verify it. App code under `/app` is owned by root and read-only to the hub; only `/data` belongs to uid 10001. [0.1.1: the non-root user `tracery`, uid 100.] Entry point `node bin/hub.mjs` in `/app/apps/hub`.
- Only the hub's production dependencies are installed.
- Defaults: `TRACERY_HOST=0.0.0.0`, `TRACERY_PORT=8971`, `TRACERY_STORE=memory`, `TRACERY_SQLITE_PATH=/data/tracery.db`.
- `EXPOSE 8971`, `VOLUME /data`, and an exec-form `HEALTHCHECK` every 30 s that fetches `/healthz` with Node.
- Ships the hosted UI and license notices. The matching Alpine package sources are published as the `<version>-sources` image tags and as GitHub release assets, and `/usr/share/tracery/SOURCES.txt` in the image says where. [0.1.1: the sources are inside the image under `/usr/share/tracery/`.]
- Size (amd64): 53 MB compressed, 166 MB unpacked. [0.1.1: 231 MB and 422 MB.]
- Released images are built and tested natively for `linux/amd64` and `linux/arm64`.

From v0.1.2 the image has no shell, so `docker exec ... sh` does not work. Run Node instead, for example `docker exec tracery-hub node -p "process.getuid()"`, or use `docker debug tracery-hub` if your Docker has it.

Image tags:

| Tag | Contents |
|---|---|
| `0.1.1`, `latest` | Multi-platform; Docker picks amd64 or arm64. |
| `0.1.1-amd64`, `latest-amd64` | Linux amd64 only. |
| `0.1.1-arm64`, `latest-arm64` | Linux arm64 only. |
| `<version>-sources`, `<version>-sources-amd64`, `<version>-sources-arm64` | Matching OS package sources (not runnable). From v0.1.2. |

## Kubernetes

[`apps/hub/helm`](apps/hub/helm/README.md) is a Helm chart (Deployment, Service, optional Ingress and ServiceMonitor, keys inline or from an existing Secret), and [`apps/hub/k8s`](apps/hub/k8s) has plain manifests. Both default to SQLite on a PVC with one replica; the chart refuses `replicaCount > 1` unless `config.store` is `postgres`. Both use the matching published image (`0.1.1`) by default. To run your own build, push it to your registry and set `image.repository` and `image.tag`.

```sh
helm install tracery-hub apps/hub/helm --namespace tracery --create-namespace -f my-values.yaml
```

The chart and the manifests run the hub as a non-root, locked-down container:

- uid/gid `10001` with `runAsNonRoot: true`
- a read-only root filesystem
- all Linux capabilities dropped and no privilege escalation
- the `RuntimeDefault` seccomp profile
- an `emptyDir` at `/tmp` as the only scratch space

Keep the same settings if you write your own manifests. They work with 0.1.1 and later. With SQLite, `/data` needs a writable volume (a PVC), and `fsGroup: 10001` makes it writable by the hub:

```yaml
spec:
  template:
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        runAsGroup: 10001
        fsGroup: 10001
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: hub
          image: atriarchsystems/tracery-hub:0.1.1
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - name: tmp
              mountPath: /tmp
            - name: data
              mountPath: /data
      volumes:
        - name: tmp
          emptyDir:
            sizeLimit: 64Mi
        - name: data
          persistentVolumeClaim:
            claimName: tracery-hub-data
```

From v0.1.2 the image has no shell. To look inside a pod, run Node (`kubectl exec <pod> -c hub -- node -p "process.getuid()"`) or attach an ephemeral debug container with `kubectl debug -it <pod> --image=busybox --target=hub`.

## Claude Code plugin

Streams a Claude Code session to a hub: the session is one flow, each tool call an op, each subagent a child flow linked to the `Agent` call that spawned it.

```text
/plugin marketplace add Atriarch-Systems/tracery-graph
/plugin install tracery-graph@atriarch-systems
```

For development, point Claude Code at the directory instead: `claude --plugin-dir ./plugins/claude-code`. With a local hub running (`npx @atriarch-systems/tracery-hub`), the only setting needed is the hub URL.

| Setting | Env var | Default | Meaning |
|---|---|---|---|
| `hub_url` | `TRACERY_HUB_URL` | `http://127.0.0.1:8971` (install prompt) | Hub base URL. With no URL at all, every hook is a silent no-op. |
| `api_key` | `TRACERY_API_KEY` | empty | Key with the `ingest` role. Leave empty for a local-mode hub. |
| `workspace` | `TRACERY_WORKSPACE` | `default` | Workspace to write to. |
| `include_prompts` | `TRACERY_INCLUDE_PROMPTS` | `false` | Also send the full text of user prompts. |

| Sent | Never sent |
|---|---|
| Session id, cwd, model, permission mode | User prompt text (unless `include_prompts` is on) |
| Tool name and a redacted input summary (first token and length of a Bash command, file paths, key names) | Full Bash command, file contents, tool input values |
| Tool output byte count | Tool output |
| First line of an error, up to 200 characters | Full errors and stack traces |
| Subagent type and its task description | Subagent transcripts and prompts |

Ask Claude for the activity link, or run `/tracery-graph:activity`, to get the hub URL of the current session's flow. Full mapping, the subagent correlation rules and troubleshooting: [plugins/claude-code/README.md](plugins/claude-code/README.md) and [docs/CLAUDE-CODE-PLUGIN.md](docs/CLAUDE-CODE-PLUGIN.md).

## Packages

| Package | Path | Version | License |
|---|---|---|---|
| `@atriarch-systems/tracery-core` | `packages/core` | 0.1.1 | Apache-2.0 |
| `@atriarch-systems/tracery-visualizer` | `packages/visualizer` | 0.3.1 | Apache-2.0 |
| `@atriarch-systems/tracery-client` | `packages/client` | 0.1.1 | Apache-2.0 |
| `@atriarch-systems/tracery-react` | `packages/react` | 0.1.1 | Apache-2.0 |
| `atriarch-tracery-graph` (Python, `atriarch.tracery`) | `clients/python` | 0.1.0 | Apache-2.0 |
| `@atriarch-systems/tracery-hub` | `apps/hub` | 0.1.1 | Apache-2.0 |
| `@atriarch-systems/tracery-hub-web` (hosted UI, not published) | `apps/hub/web` | 0.1.1 | Apache-2.0 |
| `tracery-graph` (Claude Code plugin) | `plugins/claude-code` | 0.1.0 | Apache-2.0 |

`core` holds the contract, validation, journal and reducers, with no DOM or React. `visualizer` is the canvas graph component. `react` is `ActivityExplorer` and its hooks. `client` is the TypeScript emitter and hub client. `hub` is the server and its hosted UI.

## Development

```sh
npm ci
npm run build                                  # every workspace
npx playwright install chromium                # once, for the browser tests
npm test                                       # every workspace's tests
npm run test:plugin                            # Claude Code plugin tests, including an end-to-end run against the real hub
python -m pip install -e "clients/python[dev]"
python -m pytest -q clients/python             # Python client tests
npm run license:check                          # dependency license policy
npm run publish:check                          # pack the npm tarballs, install them in a fresh consumer, run npx tracery-hub
npm run publish:check:python                   # build the wheel, install it in a fresh venv, import it
npm run demo                                   # end-to-end demo against a running hub (TypeScript and Python producers)
docker build -f apps/hub/Dockerfile -t atriarchsystems/tracery-hub:dev .
```

CI (`.github/workflows/ci.yaml`, self-hosted runners only) runs on pushes to `main` and on pull requests from this repository: the Node version check, `npm ci`, `license:check`, the release-script tests, `build`, `test` and `test:plugin`, a license inventory and source SBOM; the Python tests on Python 3.11; and the Docker image build. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup and pull requests; report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Licensing

Tracery Graph's original code is licensed under the [Apache License 2.0](LICENSE). Every package in this repository works unlicensed and unmodified; there is no license key or feature flag anywhere in it. Third-party dependencies and vendored code keep their own licenses: see [docs/LICENSING.md](docs/LICENSING.md) and [NOTICE](NOTICE).

## Tracery Cloud

Atriarch's managed hosting and private enterprise extensions are separate from this community release and plug in through the hub's extensions seam. Contact [Atriarch Systems](https://atriarch.systems) for availability and terms. This release does not establish trial, SAML, billing or managed-backup availability. See [docs/CLOUD.md](docs/CLOUD.md).

## Support

Tracery Graph is free and open source. If it saves you time, [buy me a coffee](https://ko-fi.com/demonslyr).

[![ko-fi](https://img.shields.io/badge/Ko--fi-Buy%20me%20a%20coffee-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/demonslyr)

## Further reading

- [docs/SPEC.md](docs/SPEC.md): the specification: contract, reducers, visualizer, SDKs, hub API, extensions, acceptance tests.
- [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md): a longer walkthrough with Docker Compose, a keys file, both SDKs, embedding and the plugin.
- [apps/hub/README.md](apps/hub/README.md): hub configuration, key file format, storage internals and extensions.
- [docs/SHARING.md](docs/SHARING.md): share links, redaction, expiry, rate limits, previews, image and HTML export.
- [docs/CLAUDE-CODE-PLUGIN.md](docs/CLAUDE-CODE-PLUGIN.md): the plugin's hook mapping, privacy contract and correlation rules.
- [docs/DEMOS.md](docs/DEMOS.md): the three demos, with commands and screenshots.
- [docs/VALIDATION.md](docs/VALIDATION.md) and [docs/CLEAN-MACHINE-TEST.md](docs/CLEAN-MACHINE-TEST.md): checklists for verifying a fresh checkout and the release artifacts.
- [docs/PUBLISHING.md](docs/PUBLISHING.md): how npm, Docker Hub, GitHub and PyPI releases are made.
- [docs/HARDENING.md](docs/HARDENING.md): findings from a review and fix pass.
- [docs/LICENSING.md](docs/LICENSING.md): licensing and redistribution of third-party code.
- [docs/CLOUD.md](docs/CLOUD.md): Tracery Cloud and the extensions seam.
- [CLAUDE.md](CLAUDE.md): repository layout and conventions for agents working in this codebase.
