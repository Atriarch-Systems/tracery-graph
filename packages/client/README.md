# @atriarch-systems/tracery-client

TypeScript emitter SDK for [Tracery Graph](../../docs/SPEC.md): batches
`start`/`update`/`end`/`annotate` events for a flow and its ops, ships them to
a hub (or straight into an in-process `Journal`), and reads them back through
a small hub client. See `docs/SPEC.md` §5 for the full contract this
implements.

## Install

```
npm install @atriarch-systems/tracery-client
```

## Quick start: a parent flow spawning a subagent flow

```ts
import { ActivityTracer, httpTransport } from '@atriarch-systems/tracery-client';

const tracer = new ActivityTracer({
  transport: httpTransport({ baseUrl: 'https://tracery.example.com', apiKey: process.env.TRACERY_API_KEY! }),
  actor: { id: 'agent:saga', kind: 'agent' },
});

// Parent flow.
const flow = tracer.startFlow({ label: 'Triage CVE-2026-1234' });

const op = flow.start({ node: 'llm:main', name: 'llm.provider', kind: 'llm' });
op.update({ context: { tokens: 120 } });
op.annotate({ context: { note: 'retrying after a rate limit' } });
op.end({ status: 'success', context: { model: 'qwen3.6:35b-a3b' } });

// Hand a subagent the link it needs to attach its own flow to this one.
const link = flow.spawnLink(op);
await spawnSubagent(link); // however you launch the subagent process/task

flow.end();
await tracer.flush();
await tracer.close();
```

The subagent process constructs its own tracer and starts its flow with the
link it was handed:

```ts
import { ActivityTracer, httpTransport } from '@atriarch-systems/tracery-client';

// `link` is whatever `spawnSubagent` above passed through (env var, IPC message, etc).
const subTracer = new ActivityTracer({
  transport: httpTransport({ baseUrl: 'https://tracery.example.com', apiKey: process.env.TRACERY_API_KEY! }),
  actor: { id: 'agent:saga/subagent:research-7', kind: 'subagent' },
});

const subFlow = subTracer.startFlow({ label: 'Research CVE-2026-1234', link });
const searchOp = subFlow.start({ node: 'tool:search', name: 'tool.call', kind: 'tool' });
searchOp.end();
subFlow.end();
await subTracer.close();
```

The hub (or `project()` in `@atriarch-systems/tracery-core`) resolves the two flows
into one trace, with a `spawn` edge from the parent's `llm:main` op to the
subagent's root node.

## API

- `ulid()` — a 26-character Crockford-base32 ULID, monotonic within a
  millisecond. No dependency.
- `ActivityTracer` — owns the event queue and flush timer.
  `new ActivityTracer({ transport, actor?, flushIntervalMs = 250, maxBatch = 500, maxQueue = 10000, clock? })`.
  `tracer.dropped` counts events dropped because the queue exceeded
  `maxQueue`. `tracer.flush()` drains the queue now; `tracer.close()` flushes,
  stops the timer, and closes the transport.
- `tracer.startFlow({ id?, label?, link?, context?, actor? })` — starts a flow
  and its root op (`root: true`, `node` defaults to `actor?.id ?? 'flow'`,
  `name: 'flow'`, `kind` defaults to `actor?.kind ?? 'agent'`). Returns a
  `Flow`.
- `flow.start({ node, name, kind?, label?, parent?, relation?, dataFrom?, context?, tags? })`
  — starts a non-root op. Pass an existing `Op` as `parent` to set
  `parentOp`/`parentNode` explicitly (never inferred from call order).
  Returns an `Op` with `update()`, `annotate()`, and `end({ status?, context?, durationMs? })`
  (`durationMs` is computed from the clock's monotonic reading unless given;
  `status` defaults to `'success'`).
- `flow.spawnLink(op?)` — returns the `ActivityLink` a subagent flow needs to
  attach to this one (`{ parentFlow, parentOp, parentNode, trace? }`).
  Defaults to spawning from the flow's root op. `trace` is included when this
  flow can resolve its own trace id client-side (it has no link of its own,
  or it was given an explicit `link.trace`); otherwise it's left for the hub.
- `flow.end({ status?, context? })` — ends the flow's root op.

### Transports

- `httpTransport({ baseUrl, apiKey, workspace?, fetch?, retries = 5, backoffMs = 200 })`
  — POSTs batches to `${baseUrl}/v1/events` with `Authorization: Bearer`.
  Retries network errors and 5xx with exponential backoff; 4xx is dropped,
  not retried. Never throws into the caller.
- `memoryTransport()` — records every batch on `.batches` (readonly array of
  arrays); for tests.
- `journalTransport(journal)` — calls `journal.append(events)`, feeding
  `@atriarch-systems/tracery-core`'s `Journal` directly for the library-only usage
  mode (no hub).

### HubClient (read side)

```ts
import { HubClient } from '@atriarch-systems/tracery-client';

const hub = new HubClient({ baseUrl: 'https://tracery.example.com', apiKey: '...' });
const { flows } = await hub.listFlows({ limit: 20, status: 'running' });
const flow = await hub.getFlow(flows[0].id);
const trace = await hub.getTrace(flow.trace);
const dispose = hub.live({ trace: flow.trace }, (frame) => console.log(frame));
// later: dispose();
```

`listFlows`, `getFlow`, `getTrace`, `events(flow, after?)`, and
`traceEvents(trace)` map directly onto the hub's `GET /v1/...` endpoints.
`live(filter, onFrame)` opens `WS /v1/live`, reconnects with exponential
backoff (capped at 10s) from the last cursor it saw on disconnect, and
returns a disposer. Works in Node (global `fetch`/`WebSocket`) and in
browsers; pass `{ fetch, WebSocket }` to override either.

## Status

`NodeRecord`, `OpRecord`, `EdgeRecord`, `TimelineEntry`, `FlowStatus` and
`NodeStatus` in `src/hub-types.stub.ts` are re-exported straight from
`@atriarch-systems/tracery-core`. `FlowSummary` and `Trace` in that same file are
still locally defined: they mirror core's `Flow`/`Trace` with `ops`/`nodes`
flattened from `ReadonlyMap` to plain objects, since a `Map` does not
survive `JSON.stringify`/`JSON.parse` and these two types describe the
hub's JSON response bodies, not the in-process reducer output. The hub
itself (`apps/hub`) has not shipped yet, so treat the exact response
envelopes -- `ListFlowsResult` in particular -- as a best-effort reading of
`docs/SPEC.md` §6 rather than a confirmed schema until the hub publishes
its OpenAPI document (`openapi.json` in the hub package).
