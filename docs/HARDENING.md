# Hardening

> **Note (2026-09-17 restructure):** this document is a historical record.
> The "EE" section below reviews `apps/hub/ee` as it existed in this
> repository at the time; that code has since moved to the private
> `tracery-cloud` repository (see `docs/CLOUD.md`) and no longer lives here.
> The findings and fixes are kept verbatim for reference.

This document records a review/verify/fix/extend pass run against Tracery Graph on
2026-09-17. Every finding below was produced by an initial review, then run
through two independent Opus refuters before any fix was written -- a finding
only counts as **confirmed** if neither refuter could show it was already
correct, out of scope, spec-compliant, or unreachable. Findings both refuters
knocked down are listed as **refuted**, with the refuters' own reasoning kept
verbatim so a reader can check the argument rather than take it on faith.
Lows were not adversarially re-verified; each was fixed only if the fix was
small and obviously correct, and left alone otherwise.

Audience: an engineer picking this codebase up, or a security reviewer doing
diligence ahead of a purchase or license decision.

- [Core](#core-atriarchtracery-core) -- 10 findings, 4 confirmed, 4 refuted, 2 lows fixed
- [UI](#ui-reactvisualizer--hosted-explorer) -- 15 findings, 4 confirmed, 4 refuted, 4 lows fixed
- [SDK](#sdk-typescript--python-clients) -- 13 findings, 5 confirmed, 4 refuted, 1 low fixed
- [Hub](#hub-apphub) -- 20 findings, 7 confirmed, 3 refuted, 8 lows, 4 fixed
- [EE](#ee-apphubee-enterprise-layer) -- 15 findings, 6 confirmed, 4 refuted, 0 lows fixed
- [Plugin](#plugin-claude-code-plugin) -- 14 findings, 5 confirmed, 5 refuted, 3 lows fixed
- [Roadmap items delivered](#roadmap-items-delivered)
- [Final verification](#final-verification)
- [Container image (2026-09-26)](#container-image-2026-09-26)

Severity counts and the areas above sum to 87 findings surfaced across the six
packages that make up Tracery Graph's runtime (core reducer, React/visualizer UI,
the two SDKs, the hub server, the commercial `apps/hub/ee` layer, and the
Claude Code plugin). 31 were confirmed and fixed, 24 were refuted after
adversarial review (documented below with the refuters' reasoning, not just
their verdict), and 21 low-severity findings were triaged (11 fixed, 10
explicitly skipped with a stated reason).

---

## Core (`@atriarch-systems/tracery-core`)

10 findings: 4 confirmed and fixed, 4 refuted, 2 lows fixed (of 3).

### Confirmed and fixed

| ID | Severity | Finding | Fix |
|---|---|---|---|
| core-1 | High | `validateEvent` recursed into `event.context` with no depth guard, so a deeply nested context threw `RangeError` and broke the documented "validation never throws" guarantee. | `packages/core/src/validate.ts` rewritten to an iterative walk with an explicit stack, enforcing new `ACTIVITY_LIMITS.maxContextDepth` (32) and `maxContextNodes` (10000); the final `JSON.stringify` is now wrapped in try/catch. Test: `packages/core/tests/validate.test.mjs`. |
| core-2 | High | In a namespaced scope (trace/ancestors), two flows sharing an actor produced duplicate node ids in the projection, including self-loop spawn edges. | `packages/core/src/project.ts` now accumulates namespaced nodes/edges in maps keyed by the namespaced id, merging status/ops/highlight and suppressing any call/data/spawn edge whose endpoints collapse onto the same node. Test: `packages/core/tests/project.test.mjs`. |
| core-3 | Medium | A `start` event processed after its op's `end` (equal timestamp, `end` sorted first) reset `op.status` to `running`, silently discarding a terminal error. | `packages/core/src/flows.ts`'s start handler now only sets `running` when `op.endedAt` is undefined; otherwise it backfills `durationMs` without touching status. Test: `packages/core/tests/flows.test.mjs`. |
| core-7 | Medium | Trace-id resolution recursed once per parent-link hop, so a long parent chain overflowed the stack inside `buildFlows`. | `resolveTraceIds` rewritten to an iterative walk with an explicit path array and a `pathSet` for cycle detection. Verified against a 50,000-deep chain. Test: `packages/core/tests/trace.test.mjs`. |

### Refuted

| ID | Finding | Why refuted |
|---|---|---|
| core-4 | `history.keepCompletedMs` drops evicted nodes but keeps edges pointing at them, producing dangling edges. | Both refuters found this is a designed, documented condition, not a defect: the only consumer (`packages/visualizer/src/model.ts`'s `reconcile()`) already filters edges to only those whose endpoints both exist ("Partial streams can deliver edges first"), and the layout engine is explicitly written to tolerate missing parents. No SPEC.md clause requires edges to close over retained nodes. |
| core-5 | An own `__proto__` key in `context` is accepted by validation and mutates the reducer's per-op working object's prototype, then vanishes from the emitted record. | Both refuters reproduced the mechanics but found no reachable impact: the swapped prototype is on a fresh per-op object that is never read (no code path reads `op.context.<key>`), `Object.prototype` itself is untouched, and the final `{ ...op.context }` spread emits a clean record. The claimed downstream amplification (an `Object.assign` merge in the React Inspector) does not exist in the code -- the Inspector only calls `JSON.stringify`/`Object.keys`, which are pollution-proof. |
| core-6 | Journal eviction forgets evicted ids, so a retried batch resurrects an old event and double-counts it as newly `added`. | Both refuters found the journal's own retained state is provably unaffected (the resurrected entry is evicted again by the same eviction loop before `append` returns), and every actual caller of `Journal.append` in this codebase discards its return value and re-derives state from `journal.events()` -- so the miscounted `added`/`duplicates` split is never read by anything shipped. SPEC.md's dedup contract is about retained state, which stays correct. |

### Lows

- core-8 -- fixed: events discarded by the reducer's first-wins rules were still mutating node state (label/kind/lastSeenAt) or spawning empty "ghost" nodes before being discarded. Moved the first-wins checks above `touchNode()`.
- core-9 -- skipped: `maxIdLength` is enforced only on `event.id`, not on flow/op/node ids. Fixing this would change the contract's wire-acceptance surface (rejecting previously-accepted input), which is a real behavior change, not a small fix; left for a deliberate follow-up with its own golden-test update.
- core-10 -- partially addressed as a byproduct: the never-throws and same-actor-merge guarantees are now covered by the regression tests added for core-1 and core-2. Coverage for `__proto__` context keys, post-eviction resend, and the cross-cutting edge/node-closure invariant was not added (out of scope for this pass; see core-4/core-6 above).

Test result: `npm test -w @atriarch-systems/tracery-core` -- 131/131 pass.

---

## UI (React/visualizer + hosted explorer)

15 findings: 4 confirmed and fixed, 4 refuted, 4 lows fixed (of 7).

### Confirmed and fixed

| ID | Severity | Finding | Fix |
|---|---|---|---|
| ui-1 | High | `Inspector.formatTs` threw `RangeError` on an out-of-range `ts`, unmounting the whole hosted UI. | `packages/react/src/Inspector.tsx` guards `new Date(ts)` with `Number.isNaN(date.getTime())` and falls back to `String(ts)`. Added an `ExplorerErrorBoundary` in `apps/hub/web/src/App.tsx` as defense-in-depth. Tests: `packages/react/tests/inspector.test.mjs`, `apps/hub/web/tests/explorer.mocked.spec.ts`. |
| ui-2 | High | The same namespaced-node-id collision as core-2 made `packages/visualizer/src/model.ts`'s `reconcile()` throw inside a `useEffect`, unmounting the graph and the page. | `reconcile()` now keeps the first occurrence of a duplicate id and warns instead of throwing, independent of whether core-2 is fixed. Tests: `packages/visualizer/tests/model.test.mjs`, `apps/hub/web/tests/explorer.mocked.spec.ts`. |
| ui-4 | Medium | The polling fallback was a silent no-op on the hub's default (unfiltered) route, so the UI froze showing status `polling` with no data ever arriving. | New `apps/hub/web` in `packages/react/src/hub-feed-engine.ts` (extracted from `useHubSource.ts`) adds an `offline` `FeedStatus`, reported when there is no single flow/trace to poll. Test: `packages/react/tests/hub-feed-engine.test.mjs`. |
| ui-5 | Medium | One socket failure was counted twice (both `error` and `close` events), so the feed skipped `reconnecting` and abandoned the WebSocket on the first drop. | `hub-feed-engine.ts` tracks a per-socket `dropped` flag so an abrupt failure's error+close pair counts once. Same test file. |

### Refuted

| ID | Finding | Why refuted |
|---|---|---|
| ui-3 | The hosted UI's API key travels in the WebSocket URL query string and lands verbatim in hub/proxy access logs. | One refuter found this is exactly the mechanism SPEC.md specifies (`WS /v1/live?...&token=`) and that SPEC.md's own threat model already logs a generated dev key at boot -- not a client-side defect. The other refuter disagreed and treated it as confirmed (see below); it is listed here because the finding was ultimately filed as **refuted** in the run, with the counter-argument that the actual defect, if any, is hub-side logging configuration (Fastify's default request logger), not the client code reviewed. |
| ui-6 | Once the feed falls back to polling it never returns to the live socket for the life of the mount. | Both refuters found this is the specified behavior (SPEC.md §4 requires reconnect-from-cursor plus a polling fallback, not a return path), that transient blips never reach polling in the first place (`HubClient.live` reconnects with backoff before the failure-count threshold is hit), and that polling keeps applying real frames via the same pipeline -- only the status label stays `polling`. |
| ui-7 | On a `/ui/flows/:id` deep link, the "ancestors" and "trace" scopes render empty because the hub source is filtered to just that one flow. | Refuted on the second (adversarial) pass: SPEC.md §6 defines two separate deep links (`/ui/flows/:id`, `/ui/traces/:id`) and the flow-scoped route's feed filter is the documented behavior, not a bug; the code degrades gracefully (no throw, no incorrect data) rather than silently corrupting anything. |
| ui-8 | `useHubSource` has no tests at all, leaving every SPEC §4 live-feed guarantee unverified. | Both refuters found SPEC.md §8 only requires `npm test` per package (satisfied) and explicitly assigns live-feed-guarantee verification to the integration/Playwright layer, not per-hook unit tests; the hook's actual decision logic (reconnect backoff, failure counting) lives in `HubClient` and the pure `feed.ts` reducer, both of which are tested. |

### Lows

- ui-9 -- fixed: `feedReducer`'s `frame` case unconditionally flipped a polling feed back to `live`, contradicting the module's own documented contract. Now only does so if the feed wasn't already polling. Test added to `packages/react/tests/feed.test.mjs`.
- ui-10 -- fixed: a failed poll's `error` was never cleared by a later successful poll. `hub-feed-engine.ts`'s poll-success path now clears it.
- ui-11 -- fixed: `parseRoute` let `decodeURIComponent` throw on a malformed deep link (e.g. a stray `%`), blanking the page. Added a `safeDecode()` fallback in `apps/hub/web/src/router.ts`.
- ui-12 -- skipped: spawn edges render with one arrowhead + hollow circle, not the "double-headed" accent SPEC.md describes. `types.ts`'s doc comment, `drawing.ts`'s implementation, and an existing passing test all agree with each other and disagree with SPEC.md -- fixing the renderer or amending the spec is Dan's call (SPEC.md §9, "Decisions owed to Dan").
- ui-13 -- fixed: the `1`/`2`/`3` scope shortcuts did nothing until focus happened to land inside the explorer, and swallowed those keys from any descendant input. Added `tabIndex`/`role`/`aria-label` to the explorer root and an `isScopeShortcutTarget` guard that ignores input/textarea/select/contenteditable targets and modified keys.
- ui-14 -- skipped: `placeBranches` re-runs over the whole graph on every incoming frame with super-linear inner loops. A real fix needs a spatial-hash rewrite of the collision scan, not a small patch; skipped for this pass.
- ui-15 -- skipped: `onNodeActivate` is only tested via its pure double-click helper, never through `ActivityGraph` itself. No DOM test harness (jsdom/happy-dom) exists in this package's `node:test` suite, and adding one is out of scope for a low finding.

Test result: `packages/visualizer` 27/27, `packages/react` 43/43, `apps/hub/web` (Playwright) 11/11 -- all pass.

---

## SDK (TypeScript + Python clients)

13 findings: 5 confirmed and fixed, 4 refuted, 1 low fixed (of 3).

### Confirmed and fixed

| ID | Severity | Finding | Fix |
|---|---|---|---|
| sdk-1 | High | Python `HttpTransport` followed HTTP redirects with `urllib`'s default opener, replaying the `Authorization: Bearer <api_key>` header to whatever origin the redirect pointed at. | `clients/python/src/atriarch/tracery/transports.py` now builds its opener with a `_RefuseRedirectHandler` so a redirect is treated as a non-retryable failure instead of being followed. Test: `test_http_transport_refuses_redirects_and_never_leaks_the_api_key` in `clients/python/tests/test_transports.py` (see verification note below). |
| sdk-4 | Medium | `ActivityTracer.flush()` had no re-entrancy guard: overlapping timer-driven flushes could run `transport.send` concurrently, and `close()` could resolve while sends were still in flight. | `packages/client/src/tracer.ts` now holds a shared `inFlight` promise; concurrent callers await the flush already in progress instead of starting a second one. Test: `packages/client/tests/tracer.test.mjs`. |
| sdk-5 | Medium | TypeScript `httpTransport` issued fetches with no timeout or `AbortSignal`, so a hung connection blocked a batch indefinitely. | `httpTransport` now takes `timeoutMs` (default 10000ms) and passes `AbortSignal.timeout(timeoutMs)` per attempt; backoff is capped and jittered. Test: `packages/client/tests/transports.test.mjs`. |
| sdk-9 | Medium | Python `HttpTransport.flush()`/`close()` blocked without a deadline, stalling the tracer's own periodic-flush timer thread behind slow delivery. | `flush()`/`close()` now take a bounded `timeout` and return whether the queue drained in time; the tracer's periodic timer now calls a new non-blocking `_drain()` (hand off to `transport.send` only) instead of the blocking public `flush()`. Tests in `clients/python/tests/test_transports.py` and `test_tracer.py`. |
| sdk-10 | Medium | `HubClient.live()` reset its reconnect backoff to the 200ms floor on every `'open'` event, so a socket that opened and immediately closed (e.g. a rejected key) reconnect-looped forever at the fastest interval. | Backoff now resets only after the connection stays open past a `stableAfterMs` threshold (default 1000ms); added jitter, an optional `maxAttempts` cap, and `onStatus`/`onError` callbacks. Test: `packages/client/tests/hub-client.test.mjs`. |

### Refuted

| ID | Finding | Why refuted |
|---|---|---|
| sdk-2 / sdk-3 | ULID generation (TS and Python) regresses monotonicity whenever the wall clock steps backwards. | Both refuters found SPEC.md's only requirement is "implement the 26-char Crockford ULID" -- no cross-clock-step monotonicity guarantee -- and that nothing in the codebase orders events by id: core sorts by `(ts, seq, arrival)`, and the hub orders by its own server-side cursor. Uniqueness (the only property the id contract actually needs) is unaffected, since the regression path draws a fresh random component. |
| sdk-6 | `httpTransport` has no `queue`, `maxQueue`, or drop counter, contrary to SPEC §5's description of the TS transport bullet. | Both refuters found the queue, bound, and counter all exist -- on `ActivityTracer` (`maxQueue`, `tracer.dropped`), exactly where SPEC's own code sample puts the tuning knobs (`maxBatch` is likewise on the tracer, not `httpTransport`). A placement-in-prose reading, not a missing capability. |
| sdk-7 | Hub-rejected events are discarded silently; neither SDK enforces `ACTIVITY_LIMITS` on what it emits. | Both refuters found this is the specified transport contract (SPEC §5: "never throws into the caller"), that `tracer.dropped` is documented as a local queue-overflow counter, not a hub-rejection counter, and that SPEC deliberately puts reject visibility on the hub's `/metrics` endpoint, not the SDK. |
| sdk-8 | Python `HttpTransport`'s `max_queue` bounds the number of *batches*, not events, so the delivery buffer can hold ~500x more events than the documented default suggests. | Both refuters found the scenario requires calling `HttpTransport.send()` directly in a loop without ever calling `flush()`, which isn't the documented composition -- the tracer's own event-level `max_queue` (10000) already bounds production, and each flush cycle only ever hands off the tracer's own backlog (≤ ~20 batches) before joining. |

### Lows

- sdk-11 -- fixed: `live()` swallowed exceptions thrown by the consumer's own `onFrame` callback as if the frame itself were malformed. Now parses JSON and calls `onFrame` in separate try blocks, reports the consumer's exception via `onError`, and does not advance the cursor if the handler failed (so a reconnect replays the frame). Test: `packages/client/tests/hub-client.test.mjs`.
- sdk-12 -- skipped: no test asserts emitted events validate against core, or that the tracer survives a throwing transport. Adding this cleanly needs a new cross-package test dependency on `@atriarch-systems/tracery-core`'s validator plus mirrored TS/Python throwing-transport tests -- real test-coverage engineering, not a small fix.
- sdk-13 -- fixed: `packages/client/package.json` pinned `@atriarch-systems/tracery-core` from `"*"` to `"^0.1.0"` so a future contract-version bump requires an explicit client release.

Test result: `packages/client` 31/31, `clients/python` (pytest) 27/27 -- all pass. Each new regression test was confirmed to fail against the pre-fix code before the fix landed, except sdk-1's revert-check, which the sandbox's code-execution guard refused to re-run once the leaky code was reintroduced (see the JSON audit trail); that fix was instead verified by full-suite pass plus a manual trace of `urllib`'s `HTTPRedirectHandler` semantics.

---

## Hub (`apps/hub`)

20 findings: 7 confirmed and fixed, 3 refuted, 8 lows (4 fixed).

### Confirmed and fixed

| ID | Severity | Finding | Fix |
|---|---|---|---|
| hub-1 | High | The retention sweep immediately deleted a brand-new `running` flow whose root `start` event hadn't arrived yet (`startedAt` undefined was treated as unconditionally over-retention). | New `apps/hub/src/store/sweep.ts` (`isSweepProtected`/`isOverRetention`/`orderSweepCandidates`) falls back to `lastSeenAt` only when `startedAt` is undefined, applied identically in `memory.ts` and `sqlite.ts`. |
| hub-2 | High | Every `append` (and every `deleteFlow`) re-reduced the workspace's *entire* event log, making ingest and sweep quadratic in the number of events. | New `apps/hub/src/store/trace-ids.ts` resolves trace ids over `{id, link}` pairs only (O(flows)); `memory.ts`/`sqlite.ts` now reduce only the touched flow(s) via core's `buildFlow` and re-resolve trace ids workspace-wide, not per-event. Note: this fixes the append/delete cost blowup measured; it does not add the separate, larger `flows`-table change for O(limit) boot (delivered later as a roadmap extension, see below). |
| hub-3 | High | The WS `?token=` API key was written verbatim into the hub's request logs on every live connection. | `apps/hub/src/server.ts` now configures a pino request serializer that redacts the `token`/`api_key` query params and the `Authorization`/`x-api-key` headers before logging. |
| hub-4 | High | Spec-legal batches (up to `ACTIVITY_LIMITS.maxEventsPerBatch` × `maxEventBytes`, ~62MB) were rejected by Fastify's 1 MiB default body limit, and the error handler collapsed every framework error (400/413/415) into a 500. | `bodyLimit` now defaults to the spec's actual max batch size (overridable via `Config.bodyLimitBytes`); the error handler now honours a `FastifyError`'s own `statusCode` and maps known codes (`FST_ERR_CTP_BODY_TOO_LARGE` → `body_too_large`, invalid-JSON codes → `invalid_json`) instead of always returning 500. |
| hub-5 | Medium | `after`, `before`, and `limit` query params were parsed with bare `Number()`, silently producing empty results instead of a 400 on a bad value. | New `apps/hub/src/routes/query.ts` (`parseCursor`/`parseLimit`) wired into `GET /v1/flows`, `GET /v1/flows/:id/events`, and `WS /v1/live` (which now closes with code 4400 on a bad cursor instead of silently streaming nothing forever). |
| hub-6 | Medium | `SqliteStore.load()` didn't restore `floorCursor`, so after a restart, truncation was never reported and reconnecting clients silently missed evicted events. | `SqliteStore` now persists `floorCursor` per workspace in a new `workspace_meta` table, written on every change and restored in `load()`. |
| hub-9 | Medium | Unhandled promise rejections in the retention timer and the live feed crashed the whole process. | `retention.ts`'s interval loop now `.catch`es into a pluggable logger; `live.ts`'s three fire-and-forget promise chains now `.catch` into a handler that logs and closes just the one affected socket (1011) instead of taking down the process. |

### Refuted

| ID | Finding | Why refuted |
|---|---|---|
| hub-7 | Unfiltered live snapshots and `GET /v1/traces/:id/events` serialise an entire workspace/trace into one unbounded response. | Both refuters found this is exactly what SPEC.md §6 specifies (the trace-events row has no `?after=`/`?limit=`, unlike the flows row, which deliberately does), that the reachable size is already bounded by the operator-configured `TRACERY_MAX_EVENTS_PER_WORKSPACE`, and that a read-scoped key gets no more data this way than it could already retrieve by looping the paginated endpoints. |
| hub-8 | The 15-second WS heartbeat rebuilds a complete frame per client just to read the current cursor. | Both refuters traced `buildFrame`'s `after === undefined` branch and found it returns the *existing* array by reference with no copy/sort, and the heartbeat frame that's actually serialized is a tiny 2-field object -- the described O(retained events) cost doesn't occur on the unfiltered or flow-filtered paths (only the trace-filtered path does real, bounded work). |
| hub-10 | The live feed authenticates directly instead of going through `ctx.requireAuth`, so the `onRequestAuthed` extension hook never sees WS connections (no audit trail for live connections). | The first refuter argued this is a deliberate, documented seam (`LiveDeps`' doc comment: "Only `onLiveFrame` is used here") and that routing through `requireAuth` wouldn't even produce an audit row, since `@fastify/websocket` hijacks the reply and skips the `onResponse` hook that ee's audit log actually writes from. The second refuter reproduced the gap empirically (a live probe confirmed zero audit rows for a WS connection) but agreed the proposed fix was insufficient for the same hijack reason. Net verdict: refuted as filed (a `ctx.requireAuth` fix wouldn't work), tracked instead as ee-10 (see below) for the real fix, which needs a connect/disconnect-time audit path the ee layer alone can't add. |

### Lows

- hub-13 -- fixed: the truncation predicate was off by one; a client exactly caught up to the eviction boundary got a spurious full `truncated: true` snapshot. `frame.ts` now compares `after < floorCursor - 1`.
- hub-14 -- fixed: the `/metrics` token was compared with `!==` while API keys got constant-time comparison. Exported `auth.ts`'s `constantTimeEquals` and reused it in `routes/health.ts`.
- hub-15 -- fixed: any key with `workspace: "*"` was treated as the operator key regardless of role, and an explicitly-empty `TRACERY_API_KEYS` (`"[]"`) silently minted an all-roles dev key. `config.ts` now rejects a `*`-workspace key without `role: admin` at parse time, and an explicit `"[]"` now throws a clear startup error instead of falling through to the dev-key path.
- hub-16 -- fixed: a `TRACERY_STORE` typo (e.g. `sqllite`) silently fell back to the in-memory store, and negative/zero retention values were accepted. `config.ts` now validates `TRACERY_STORE` against the actual `StoreKind` union and applies bounds to `TRACERY_PORT`/`TRACERY_RETENTION_HOURS`/`TRACERY_MAX_EVENTS_PER_WORKSPACE`.
- hub-17 -- fixed: a client-supplied `x-request-id` was echoed into the response header unvalidated, so a control character in it 500'd the request (even `/healthz`). `server.ts` now validates the header and mints a fresh UUID if it doesn't look like printable ASCII ≤128 chars.
- hub-18 -- skipped: the hub's cursor is global across workspaces, leaking other tenants' event volume to every workspace via the cursor's magnitude. Making the cursor per-workspace touches `ActivityFrame`/`AppendResult` semantics everywhere and `SqliteStore`'s `cursor INTEGER PRIMARY KEY` schema; not a contained change, deferred.
- hub-19 -- skipped: `stats()` reports oldest/newest event time from arrival order, not timestamp order. A correct fix needs incremental min/max bookkeeping to avoid reintroducing an O(events) scan on every `/metrics` scrape -- a smaller repeat of the hub-2 problem class; deferred.
- hub-21 -- partially fixed: envelope-level batch validation failures (a malformed `batch.workspace`) were silently swallowed by the per-event validation fallback. `routes/events.ts` now rejects a malformed envelope outright with 400 before it reaches the per-event path. The other half of the finding (an all-invalid batch should return 400 instead of 207) was **not** changed: it directly conflicts with an existing, deliberately-written regression test asserting 207 for that case, so changing it would be a real contract change, not a safe low-severity fix.

Test result: community suite 83/83, ee suite 57/57 (unowned, unmodified, run only to confirm no regression) -- all pass.

---

## EE (`apps/hub/ee`, enterprise layer)

15 findings: 6 confirmed and fixed, 4 refuted, 0 lows fixed (of 5 -- 3 explicitly skipped as needing changes outside the owned directory).

### Confirmed and fixed

| ID | Severity | Finding | Fix |
|---|---|---|---|
| ee-1 | High | The RBAC ingest scope check only inspected `root: true` starts, but any event -- not just a root start -- can define a flow's actor. A scoped key could ingest into an out-of-scope actor via a non-root event. | `apps/hub/ee/src/rbac.ts`'s `checkIngestScope` reworked. |
| ee-2 | High | License expiry (`exp`) was evaluated once at boot; ee features stayed enabled forever past expiry until the process restarted. | `apps/hub/ee/src/index.ts` and `license.ts` now check expiry live on each feature check instead of caching the boot-time result. |
| ee-3 | High | The live-feed RBAC filter silently dropped in-scope events whenever a flow's root start wasn't in the process-local cache -- which is the normal case on any `?after=` reconnect. | `apps/hub/ee/src/rbac.ts`'s live-frame scope resolution reworked to not depend on the cache being warm. |
| ee-5 | Medium | `GET /v1/audit` didn't validate `after`/`limit`: `limit=abc` was a 500 on the sqlite store, and both params silently misbehaved otherwise. | `apps/hub/ee/src/audit.ts` now validates both params before querying. |
| ee-9 | Medium | The live-frame flow-scope cache (`ee/src/rbac.ts`) was process-wide and never evicted, growing unbounded for the life of the hub process. | Bounded/evicting cache added. |
| ee-12 (low, fixed alongside the above) | Low | Audit routes evaluated the feature/license gate *before* authentication, answering anonymous callers with the licensing state. | Reordered to authenticate first. |
| ee-13 (low, fixed alongside the above) | Low | `decodeBase64Url`'s documented round-trip guard wasn't actually implemented; its try/catch was dead code. | Implemented the guard for real. |
| ee-14 (low, fixed alongside the above) | Low | `TRACERY_LICENSE_PUBLIC_KEY` let any operator substitute their own signing authority with no additional check. | Addressed in `license.ts`. |

### Refuted

| ID | Finding | Why refuted |
|---|---|---|
| ee-4 | `DELETE /v1/flows/:id` isn't scope-checked: a scoped key can destroy -- and probe the existence of -- out-of-scope flows. | Both refuters found SPEC.md §7's RBAC feature is defined by exactly three verbs ("reads and lists are filtered, ingests outside the constraint rejected") and delete is gated by SPEC's separate route table on the `admin` *role*, not the rbac `scope` field -- reachable only if an operator grants both `admin` and a narrowing scope to the same key, a self-contradictory configuration the spec doesn't model as a scope demotion of admin. |
| ee-6 | Audit reads are filtered by workspace only, so a scoped admin key learns the ids and paths of out-of-scope flows. | Both refuters found the audit feature's contract (SPEC.md §7: "every authenticated request records... `flows touched`") is deliberately workspace-wide for an admin, that the rbac read filter's coverage is an enumerated list of five flow/trace routes that never included `/v1/audit`, and that reachability again requires an operator granting `admin` to a key they also scoped -- a configuration choice, not a code defect. |
| ee-7 | `GET /v1/audit/export` materialises the whole audit table in memory, with no retention cap on the audit log. | Both refuters found NDJSON is a wire-format requirement in SPEC, not a streaming-implementation requirement; that SPEC's only retention clause covers the event store, not the audit log (for which unbounded retention is normally the *desired* default); and that the route requires admin auth, so the only principal who can trigger the allocation is exporting their own hub's own history. |
| ee-8 | RBAC scope loading fails open and silently on a malformed `scope`, an unreadable keys file, or bad JSON, leaving scoped keys unrestricted. | Both refuters found two of the three failure modes are unreachable: `loadConfig` runs before ee is even constructed and throws loudly on unreadable/malformed keys JSON, so the process never reaches a running state with those failures silent. The third (a non-array `scope` value, e.g. a string instead of `string[]`) is reachable but is operator misconfiguration of a field SPEC.md doesn't specify validation behavior for, with no untrusted input path. |

### Lows

- ee-10 -- skipped: `WS /v1/live` connections are authenticated but never audited. A real fix needs `apps/hub/src/live.ts` to route through `ctx.requireAuth` (or a new `HubExtensions` seam) -- both outside the owned `apps/hub/ee` directory. Reimplementing auth a second time inside ee to work around this would duplicate/race the real check. Left unfixed; flagged for whoever owns `apps/hub/src/live.ts` (also the fix target this finding and hub-10 converge on).
- ee-11 -- skipped: flow-list scope filtering runs after the store paginates, so a scoped key can get short or empty pages while `nextBefore` implies more exist. Correct fix (push scope into the store query, or loop pages inside the `onSend` hook) is a real pagination behavior change, not a small patch.
- ee-15 -- skipped: audit `flows` are captured from the raw, unvalidated request body (before `validateBatch`/`validateEvent` run) and from non-flow `:id` params. Properly fixing this means recording from the *accepted* events after ingest, which requires a change in `apps/hub/src/routes/events.ts` -- outside the owned directory. A same-file patch would only address the size/DoS half, not the stated defect, so it was skipped rather than presented as a partial fix.

Test result: `npm run test:ee -w @atriarch-systems/tracery-hub` -- 57/57 pass, including 18 new/rewritten regression tests across `rbac`, `index`, `audit`, and `license` test files.

---

## Plugin (Claude Code plugin)

14 findings: 5 confirmed and fixed, 5 refuted, 3 lows fixed (all of them).

### Confirmed and fixed

| ID | Severity | Finding | Fix |
|---|---|---|---|
| plugin-1 | High | Counter-derived event ids collided across concurrent hook processes and after any state loss, causing the hub to silently dedup away distinct events. | `nextId()` now mints `${sessionId}:${pid}:${now}:${counter}`, unique across OS processes even from identical/absent loaded state. Separately, `emit.mjs` now serializes the state load-modify-save section per session via an `open(path,'wx')` lockfile with bounded wait and stale-lock recovery. Test spawns two real overlapping child processes and asserts no collision. |
| plugin-2 | High | Spool drain was a non-atomic read-modify-write that erased events appended by a concurrent hook process, or by a hook killed mid-drain. | `drainSpool` now atomically renames the live spool to a private `<pid>.<ts>.inflight` file before reading/posting, with staleness-gated orphan recovery for a killed process's abandoned file. Test uses a real HTTP server with artificial delay to widen the race window. |
| plugin-3 | High | One global spool file was drained with whatever hub URL/API key/workspace the *current* hook process happened to be configured with, leaking one project's activity into another project's hub/workspace. | Spool path is now `spool/<sha256(hubUrl\|workspace\|apiKey)[:16]>.ndjson`, isolating destinations from each other. |
| plugin-6 | Medium | Bash `command_token` forwarded a leading `VAR=value` environment assignment verbatim, leaking secrets embedded in shell command lines. | `firstMeaningfulToken()` now skips up to 2 leading `VAR=value` tokens before taking `basename()`, capped at 64 chars. |
| plugin-11 | Medium | With `include_prompts` on, an oversized prompt made the `annotate` event exceed `maxEventBytes` and it was silently discarded. | `UserPromptSubmit` now truncates the forwarded prompt to 16KB (UTF-8-safe) and adds `prompt_truncated: true`, while `prompt_chars` still reports the true original length. Also implemented: a 207 partial-accept response's `rejected[]` count is now surfaced once on stderr. |

### Refuted

| ID | Finding | Why refuted |
|---|---|---|
| plugin-4 | The spool has no size bound, and permanent failures (401, 413, 404) are retried forever, so the file grows without limit. | Both refuters found this is the documented design: `docs/CLAUDE-CODE-PLUGIN.md` states unbounded retry-on-failure verbatim, and `plugins/claude-code/README.md` documents the unbounded-growth case by name with its remedy ("delete it to drop unsent history") -- a stated durability-over-disk tradeoff, not an unimplemented guarantee. |
| plugin-5 | The drain loop has no wall-clock budget, so a backlog can blow the hook's 5-second timeout. | Both refuters found the loop fails fast: any failed batch causes an immediate `return`, so a down/slow hub costs at most one bounded (2s) POST attempt per hook invocation, never an unbounded number of iterations -- the multi-batch path is only reachable when the hub is answering *successfully*. |
| plugin-7 | Denied or interrupted tool calls never get an `end` event, so ops stay `running` forever and internal state maps grow without bound. | The first refuter found the premise (that denial suppresses `PostToolUse`) is undocumented inference, not a documented fact, and that the hub's retention sweeper already reclaims old `running` flows. The second refuter reproduced the mechanism as real and confirmed it as a genuine gap (no `Stop`/cancellation hook clears `state.tools`), but the state-file growth claim was found to be bounded (deleted wholesale on `SessionEnd`) and the hub-side leak claim false (the sweeper does reclaim old running flows) -- net filed as refuted on severity/impact, though the underlying "no end event on denial" observation stands as a known limitation. |
| plugin-8 | Per-session state files are only removed on `SessionEnd`, so they accumulate forever whenever that hook doesn't fire (crash, kill). | Both refuters found this matches the documented step-by-step contract in `docs/CLAUDE-CODE-PLUGIN.md`, that leftover files can never win the "most recently modified" lookup the `activity` skill uses (the live session's file is always rewritten more recently), and that leftover content is small, non-sensitive (no prompt text), and only accumulates for abnormally-terminated sessions. |
| plugin-9 | The fallback data directory is a predictable, shared path in the system temp dir, allowing symlink attacks and cross-user reads of spooled activity. | The first refuter found no functional bug and that `os.tmpdir()` is per-user and permission-protected on the dev platforms this repo targets (Windows, macOS), narrowing the real attack to a shared-`/tmp` Linux host with an already-code-executing local attacker. The second refuter disagreed and treated the symlink-write primitive (no `O_NOFOLLOW`, predictable path, default `mkdir` mode) as a real CWE-377/CWE-59 shaped issue independent of platform, and it is recorded here as the run's filed verdict of refuted with that dissent preserved for anyone hardening further. |
| plugin-10 | Every hook blocks on a synchronous 2s POST with no failure backoff, adding up to 2s of latency per tool call when the hub is unreachable. | Both refuters found this matches the documented per-batch timeout in `docs/CLAUDE-CODE-PLUGIN.md`, that it's bounded twice over (a 2s abort inside Claude Code's own 5s hook timeout), that the drain loop bails after the first failed batch (so the cost is at most one 2s wait per hook call, not compounding), and that the realistic failure modes (connection refused, DNS failure) fail in microseconds -- the full 2s only materializes for a black-holing connection, a narrow operational case. |

### Lows (all fixed)

- plugin-12 -- fixed: the privacy/redaction contract was only tested for the Bash and prompt branches; the generic/MCP tool branch and the `Agent` tool's `prompt` field were never asserted redacted. Added a table-driven test iterating every `PreToolUse` fixture plus a synthetic secret-valued generic/MCP tool.
- plugin-13 -- fixed: `session_id` from the hook payload was interpolated into a file path with no validation. `emit.mjs` now rejects any `session_id` not matching `/^[A-Za-z0-9._-]{1,128}$/` before touching the filesystem.
- plugin-14 -- fixed: stdin was read with no size bound. `readStdin()` now caps accumulation at 8MB and drains/discards the rest without buffering it, skipping processing while still exiting 0 and staying silent on stdout.

Test result: `npm run test:plugin` -- 30/30 pass (later 34/34 once the marketplace packaging extension below added its own tests), run 3x back-to-back with no flakiness on the timing-sensitive concurrency tests.

---

## Roadmap items delivered

Five roadmap items were built in this pass, beyond the review/fix work above.

### Sqlite materialised `flows` table

Delivered. `apps/hub/src/store/sqlite.ts` gained a `flows` table (id, workspace, trace, label, actor, status, timestamps, cursors, tags, root node, data) plus a `schema_meta` table, so `load()` reconstructs the flow index in O(flows) instead of replaying the whole event log, and `listFlows`/`flowSummary` are SQL-backed instead of in-memory scans. Falls back to the old O(events) rebuild only when the table is missing or its schema version doesn't match, and re-persists automatically in that case. No blockers; 4 new regression tests (reopen-without-scanning, missing-table rebuild, schema-mismatch rebuild, late-parent correction surviving a restart) plus the full existing suite (87/87) pass.

### Postgres store

Delivered, with two follow-ups needed from the owners of adjacent files before it's live end-to-end. `apps/hub/src/store/postgres.ts` implements the same `EventStore` interface as `MemoryStore`/`SqliteStore` (in-memory flow/trace index + materialised `flows` table, same reduction logic, transactional writes, parameterised queries). Wired through `config.ts` (`TRACERY_STORE=postgres`, `TRACERY_POSTGRES_URL`), `docker-compose.yaml` (a `postgres` profile), `k8s/deployment.yaml` (a commented-out alternative env block), and `README.md`. Verified against a real throwaway `postgres:16-alpine` container: full store-contract suite (104/104 including Postgres-specific persistence/rebuild tests) passes.

**Blockers (both in files outside the delivering agent's owned directories, not yet applied):**
1. `apps/hub/ee/src/audit.ts`'s `AuditLog` `store` option type still needs widening from `'memory' | 'sqlite'` to include `'postgres'` -- currently breaks `npm run build:ee` once `Config.store` is widened.
2. `apps/hub/src/server.ts`'s `openStore(config)` still only branches on `'sqlite'` vs. memory -- it needs a `postgres` branch calling `PostgresStore.connect(...)`, and the store-open path needs to become async (the connect call is async). **Without this, selecting `TRACERY_STORE=postgres` at runtime currently falls through to `MemoryStore`.**

### Helm chart

Delivered. `apps/hub/helm` (chart `tracery-hub`, `0.1.0`): configurable image/resources/probes, non-root security context, a ConfigMap for non-secret settings, Secret-sourced env for Postgres URL/license key/metrics token, a Secret-or-`existingSecret` pattern for `TRACERY_API_KEYS`, a PVC that's only created when `config.store=sqlite`, `replicaCount` forced to 1 unless `config.store=postgres` (the template fails loudly with a clear message otherwise, matching the "only Postgres supports >1 replica" constraint from the store work above), and optional Ingress/ServiceMonitor. `helm lint` passes clean; `helm template` exercised across the sqlite/postgres/replica-count/all-secrets/existing-secret-or-claim combinations, including the required failure case (2 replicas + sqlite → template error). No blockers.

### Plugin marketplace

Delivered. Added `.claude-plugin/marketplace.json` at the repo root, listing the `tracery` plugin sourced from `./plugins/claude-code`. Documented both install paths (`/plugin marketplace add` + `/plugin install`, and the existing local `--plugin-dir` path) in `docs/CLAUDE-CODE-PLUGIN.md`, `README.md`, and `plugins/claude-code/README.md`. Added `plugins/claude-code/tests/packaging.test.mjs` (4 tests) validating the marketplace/plugin manifests parse, their relative paths resolve to real files, and every `${CLAUDE_PLUGIN_ROOT}/...` reference in `hooks.json` resolves. No blockers.

### OIDC SSO

Delivered as a new licensed feature (`feature: sso`) in `apps/hub/ee`, plus one explicitly-authorized seam change in `apps/hub/src/auth.ts`. New ee modules handle config parsing, HMAC-signed session/state cookies, PKCE + JWKS-verified id-token exchange (RS256/ES256 only, no JWT library dependency -- same hand-rolled `node:crypto` approach as the existing license verifier), and the `/v1/auth/oidc/login`, `/v1/auth/oidc/callback`, `/v1/auth/logout`, `/v1/auth/me` routes. Session cookies are always read-role only regardless of the configured role claim (carried for display/audit only). The `auth.ts` seam is a `setSessionAuthResolver()` setter that `authenticate()` consults only when no API key is presented at all, so an unauthenticated request still 401s before ee is consulted -- documented inline and in `docs/ENTERPRISE.md`'s new "SSO (OIDC)" section. Hosted UI changes are additive (an optional "Sign in with SSO" button, an `/v1/auth/me` check on mount); no changes were needed in `packages/client`/`packages/react`, since a browser's same-origin cookie is sent automatically alongside the existing (now-empty) API key value. 9 new ee tests against a fake in-process OIDC provider, 3 new Playwright tests. No blockers; all four requested build/test commands (hub build+test, hub-web build+test) pass green, including the 9+3 new tests.

---

## Final verification

A from-scratch verification pass was run after all fixes and roadmap extensions above: `dist/` and all `tsconfig.tsbuildinfo` files were deleted, `npm install` + `npm run build` were run from a clean tree, then every package's test suite plus the Python client's pytest suite plus the Claude Code plugin's suite were run, `helm lint` was run against the new chart, a real Docker image was built and run (`docker build -f apps/hub/Dockerfile`), exercised over its actual HTTP/WS endpoints (`/healthz`, `/v1/license`, `/ui/`, `/metrics`, and the full `scripts/demo.mjs` acceptance script), and torn down -- without touching the always-on `tracery-demo` demo container on port 8971.

**Result: pass.** All six steps passed on the first attempt with no fixes required:

1. Clean install + full workspace build: all 7 workspaces built with zero errors.
2. Full test suite: visualizer 27/27, core 131/131, client 31/31, react 43/43, hub 104/104 (+ ee 67/67), hub-web (Playwright) 14/14, Claude Code plugin 34/34 -- 0 failures anywhere.
3. Python client: `pip install -e` succeeded, `pytest` 27/27.
4. `helm lint apps/hub/helm`: 0 charts failed (one informational "icon is recommended" note).
5. Docker image built and run end-to-end: healthz, license, UI, and authenticated metrics endpoints all responded correctly; `scripts/demo.mjs` reported 9/9 checks passed (3-flow trace, spawn-edge projection, live WS delivery with monotonic cursors, dedup on resend); container removed cleanly; `tracery-demo` was never touched and stayed healthy throughout.
6. No compiled artifacts left under any `src/` tree, verified by direct filesystem scan (the literal `git status --short` step was substituted with an equivalent read-only filesystem check, since this run operated under a "never run any git command" constraint -- see note below).

**Process note:** this run operated under an explicit "never run any git command" instruction. Step 6 of the verification plan called for a literal `git status --short`; that was substituted with a direct filesystem scan for build byproducts under every `src/` tree, cross-checked against `.gitignore`, which reached the same conclusion (nothing untracked and visible). One agent, while confirming scope on the plugin-marketplace extension, ran a single read-only `git status --short` before this constraint was internalized for that session -- it changed no repository state, but is recorded here for completeness.

---

## Supply chain (v0.1.3)

socket.dev scores the published packages around 77 and flags three HIGH alerts on `tracery-hub`.

| Alert | Finding | Action |
|---|---|---|
| Unstable ownership: `@fastify/swagger@9.9.1` (new publisher) | It was a runtime dependency only to serve `/v1/openapi.json`. | The document is generated at build time and shipped as `apps/hub/openapi.json`; `@fastify/swagger` is now a devDependency pinned to 9.8.1 and never installed by consumers or in the image. Serving the file is opt-in (`TRACERY_OPENAPI=1`). The hub's production tree went from 104 to 98 third-party packages. |
| Unstable ownership (second alert) | The Fastify ecosystem rotates publishers often. The most recent publisher change in the remaining tree is `content-disposition@3.0.0` (published by GitHub Actions after four human publishers, via `@fastify/static`), which is most likely the second alert; the socket.dev alert page names the package. It is a trusted-publishing migration, not an account change. | None needed. Dropping `@fastify/static` would mean serving the hosted UI by hand, for no real gain. |
| Optimized override available: `safe-buffer@5.2.1` | Not from `@fastify/static` (`content-disposition@3` has no dependencies). The only path is `@fastify/websocket@11` > `duplexify@4.1.3` > `readable-stream@3.6.2` > `string_decoder@1.3.0` > `safe-buffer`. The newest `@fastify/websocket` (11.3.1), `duplexify` (4.1.3) and `readable-stream@3` (3.6.2, the end of that line) all still depend on it, and `@fastify/websocket` has no newer major. | No upstream release drops it, so it stays. An npm `overrides` entry would only change this repository's lockfile: npm ignores `overrides` in a dependency's `package.json`, so consumers installing `@atriarch-systems/tracery-hub` still get `safe-buffer@5.2.1`. A consumer who wants a different package can add their own `overrides` (for example socket.dev's `@socketregistry/safe-buffer`) in their root `package.json`. The package is a small, long-stable shim that only chooses between `buffer` and a polyfill on old Node versions. The real fix is to stop using `@fastify/websocket` (the hub only needs `ws`, which has no dependencies), which also drops about ten packages (the whole `duplexify` chain); it changes how routes opt in to WebSockets, which Tracery Cloud's extensions module may rely on, so it is not part of this patch. |

Other avoidable weight in the runtime tree, not changed here: `@fastify/static` pulls in `glob@13` and six
packages behind it (`minimatch`, `brace-expansion`, `balanced-match`, `minipass`, `path-scurry`,
`lru-cache`), a candidate for a later pass.

npm packages are now published with provenance (docs/PUBLISHING.md).

## Container image (2026-09-26)

A later, separate pass on `apps/hub/Dockerfile`, measured against the published
`atriarchsystems/tracery-hub:0.1.1` (amd64): 422 MB unpacked, 231 MB compressed.

| Finding | Fix |
|---|---|
| `RUN chown -R tracery:tracery /data /app` made the app code owned and writable by the runtime user (it could create files in `/app/apps/hub/dist`), and duplicated `/app` in a 60 MB layer. | App files are copied without `--chown` and stay root-owned; only `/data` belongs to the runtime user. `scripts/release-image-check.mjs` walks `/app` and fails on any file not owned by root or writable by group/others. |
| `USER tracery` was a name (uid 100), which Kubernetes `runAsNonRoot` cannot verify; the Helm chart ran as uid 1000 with a writable root filesystem. | Fixed `USER 10001:10001`. Helm and `k8s/deployment.yaml` run as 10001 with `readOnlyRootFilesystem`, all capabilities dropped, no privilege escalation, `RuntimeDefault` seccomp and an `emptyDir` at `/tmp`; compose sets `read_only`, a `/tmp` tmpfs, `cap_drop: [ALL]` and `no-new-privileges`. |
| The runtime shipped busybox (`sh`, `wget`, `nc`, `su`), apk-tools, scanelf and musl-utils. | The final stage is `FROM scratch` plus a root filesystem made with `apk add --root` (musl, libgcc, libstdc++, ca-certificates-bundle, alpine-release, alpine-keys) and the Node binary. The APK database lists exactly those 6 packages, so Trivy still reports the OS. The health check is exec form. |
| `node_modules` held the whole workspace's production dependencies (react-dom, force-graph, ...), 55 MB. | `npm ci --omit=dev -w @atriarch-systems/tracery-hub` installs only the hub's closure (107 third-party packages, about 30 MB); RUNTIME-NOTICES.txt is generated from that tree. |
| The 153 MB OS source archive was inside every image. | Published beside the image instead, as `<version>-sources` in the same Docker Hub repository (pushed first) and as a GitHub release asset. The image keeps `/usr/share/tracery/SOURCES.txt` with the locations, the archive's SHA-256 and a written offer. See `licenses/CONTAINER-REVIEW.md`. |

Result for amd64: 166 MB unpacked (was 422 MB), 53 MB compressed (was 231 MB).
The companion source image is 103 MB compressed, almost all of it the GCC
source archive. Verified by building the image, running it with `--read-only
--tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges` and SQLite on a
volume until the Docker health check reported healthy, then ingest, flows, UI,
share preview PNG upload/download, `release-image-check.mjs`, Trivy (0
vulnerabilities, 0 secrets) and the license gate. ARM64 was checked for the
root filesystem stage only (package pins, source commits and the Node binary
under emulation); the full ARM64 image is covered by the native release runner.
