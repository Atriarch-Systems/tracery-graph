# Build plan — workstreams

> **Note (2026-09-17 restructure):** historical record of the original
> workstream plan. Workstream F's `apps/hub/ee` has since moved to the
> private `tracery-cloud` repository (see `docs/CLOUD.md`) and no longer
> lives in this repository.

Each workstream is one agent. Read `docs/SPEC.md` and `packages/core/src/contract.ts`
before writing code. Rules for every workstream:

- Work only inside the directories listed under "Owns". Do not edit another
  workstream's files. If you need something from another package that does not
  exist yet, write the smallest possible local stub in a `*.stub.ts` file inside
  your own package, mark it `// TODO(integration)`, and say so in your report.
- Do not run any `git` command. The coordinator commits.
- Every package builds with `npm run build` and tests with `npm test` from its
  own directory and from the repo root. Tests run with `node --test` against
  `dist/` (build first), no test framework dependency.
- `npm install` only inside the repo root (workspaces). Add dependencies to your
  own package.json; keep them few and pinned to a major.
- No `any` in exported signatures. `readonly` inputs. Consumer objects are never mutated.
- Windows host: paths may contain spaces, use `node` scripts not shell scripts
  for anything cross-platform; `node:sqlite` needs Node >= 22.13 (this box has 22.14).
- Report at the end: what you built, what you tested (paste the test summary),
  what you stubbed, what you could not do.

## A — core reducers

Owns: `packages/core`.
Deliver: `package.json` (`@atriarch-systems/tracery-core` 0.1.0, Apache-2.0), `tsconfig.json`
extending `../../tsconfig.base.json`, `src/` implementing SPEC §1–§2:
`contract.ts` (given), `validate.ts`, `journal.ts`, `flows.ts`, `trace.ts`,
`project.ts`, `catalog.ts`, `index.ts`. Type-only dependency on
`@atriarch-systems/tracery-visualizer/types`.
Tests (`tests/*.test.mjs`): validation accept/reject matrix; dedupe; ordering by
ts/seq; op lifecycle table; end-without-start marks partial; flow status matrix;
trace resolution incl. parent arriving late, explicit `trace`, missing parent,
cycle; `project` in all three scopes incl. namespacing, spawn edges,
`layout.parentId`, groups, data edges, self-edge suppression; a golden test
pinning `ACTIVITY_CONTRACT_VERSION` and a sample event's exact JSON shape.
Also ship `src/fixtures.ts` exporting a deterministic sample trace (parent +
two children, ~40 events) used by other workstreams' tests and the demo.

## B — visualizer additions

Owns: `packages/visualizer`.
Deliver: SPEC §3 (groups/hulls, edge kinds, `onNodeActivate`, `placeBranches`
ignores data edges), version 0.3.0, `VISUALIZER_CONTRACT_VERSION = 2`, tsconfig
extends base, README updated, existing tests kept green plus new ones.
`react-force-graph-2d` and `d3-force` stay as dependencies. Draw hulls in a
canvas layer beneath nodes (use `onRenderFramePre`).

## C — client SDKs

Owns: `packages/client`, `clients/python`.
Deliver: SPEC §5. TS: `ActivityTracer`, `Flow`, `Op`, transports, ULID,
`HubClient`; tests with a local `node:http` fake hub asserting batching,
retry/backoff, queue bound + drop counter, `spawnLink`, `durationMs`, flush on
close. Python: `pyproject.toml` (`atriarch-tracery-graph` 0.1.0, `requires-python >=3.11`,
`[project.optional-dependencies] dev = ["pytest"]`), `src/atriarch/activity/`,
`tests/` with `http.server` fake hub; same assertions plus context managers,
`contextvars` parent propagation, exception → `error` with class name only.
Both SDKs must emit events that pass core's `validateEvent` (copy the contract
rules into the Python docstrings; the TS SDK imports the types from core).

## D — hub server

Owns: `apps/hub` except `apps/hub/web` and `apps/hub/ee`.
Deliver: SPEC §6. Fastify 5, `@fastify/websocket`, `@fastify/static`
(OpenAPI 3.1 generated at build time with `@fastify/swagger`, a devDependency, shipped as `openapi.json`, served at `/v1/openapi.json` when `TRACERY_OPENAPI=1`); `src/config.ts` (env parsing with
defaults), `src/auth.ts`, `src/store/{types,memory,sqlite}.ts`, `src/routes/*`,
`src/live.ts`, `src/retention.ts`, `src/metrics.ts`, `src/server.ts`, `bin/hub.mjs`.
Serve `apps/hub/web/dist` at `/ui` when present; otherwise `/ui` returns a
plain page saying the UI is not built. `Dockerfile`, `docker-compose.yaml`,
`k8s/`, `README.md` with every env var. Tests: store contract suite run against
both stores; route tests with `fastify.inject` covering auth matrix, ingest
validation/duplicates/207, list/paging, trace endpoints, WS snapshot → events →
reconnect-from-cursor → truncated snapshot, retention sweep, metrics text.
Expose `createServer(config)` for tests and for ee to extend (hooks: `onRequestAuthed`,
`registerRoutes`).

## E — React explorer + hosted UI

Owns: `packages/react`, `apps/hub/web`.
Deliver: SPEC §4 and §6 "Hosted UI". `packages/react`: `ActivityExplorer`,
`useHubSource`, `useJournalSource`, `useProjection`, inspector, CSS variables;
tests with `react-dom/server` render + reducer-level tests of the source hooks'
state machines (extract the WS state machine into a pure module so it is
testable without a browser). `apps/hub/web`: Vite app, key entry screen, routes
`/ui`, `/ui/flows/:id`, `/ui/traces/:id`, builds into `apps/hub/web/dist`;
Playwright test that runs against a hub started from `apps/hub` seeded with
core's fixture trace via the ingest API (the hub is D's; if D is not done when
you start, develop against `useJournalSource` with the fixture and leave the
Playwright test ready to run).

## F — enterprise layer

Owns: `apps/hub/ee`, `docs/ENTERPRISE.md`. Starts after D.
Deliver: SPEC §7: `ee/LICENSE` (placeholder commercial license text with a
clear "replace with counsel-approved text" header), `ee/src/license.ts`
(ed25519 verify, embedded public key, dev keypair generation script),
`ee/scripts/mint-license.mjs`, `ee/src/audit.ts` + routes, `ee/src/rbac.ts`,
registration through D's hooks, `/v1/license`. Tests: signed/expired/tampered
keys, audit rows written and exported, rbac filtering. `docs/ENTERPRISE.md`:
what is in the commercial layer, how licensing works, roadmap (OIDC SSO,
Postgres, HA).

## G — integration and demo

Owns: `scripts/`, root `README.md`, `docs/GETTING-STARTED.md`. Starts after A–F.
Deliver: SPEC §8 acceptance 1–6 executed for real on this machine: root
build/test, Python tests, Docker build and run, `scripts/demo.mjs` (TS client
parent flow + one TS child + one Python child through the hub) with assertions,
run the Playwright suite against the running container, fix any cross-package
break found (you may edit any package for integration fixes; list every file you
touched). Root README: what it is, three usage modes, quick start for each,
package table, licensing summary.

## H — Claude Code plugin

Owns: `plugins/claude-code`, `docs/CLAUDE-CODE-PLUGIN.md`. Starts after D (needs a
running hub to test against) and after the hook-payload research note in
`docs/research/claude-code-hooks.md` exists.
Deliver: a Claude Code plugin (`.claude-plugin/plugin.json`, `hooks/hooks.json`,
`hooks/emit.mjs`, `README.md`) that maps hook events to Activity events and
posts them to a hub. Mapping: SessionStart → root start of flow `session_id`
(actor `agent:claude-code`, kind `agent`, label from cwd basename + model);
UserPromptSubmit → `annotate` on the root op (prompt length, never the text);
PreToolUse → op `start` (op = `tool_use_id`, node `tool:<tool_name>`, kind `tool`,
context = a redacted summary of `tool_input`: file paths, command name, byte counts);
PostToolUse → op `end` success; tool failure hook → op `end` error with the error
class or first line; Agent tool PreToolUse → also emits the child link so the
subagent's SessionStart (if it carries its own session id) or its tool calls
attach as a child flow via `link.parentFlow`/`parentOp`; SubagentStop → child
flow end; Stop / SessionEnd → flow end; PreCompact → annotate. The emitter is a
single zero-dependency Node script: reads the hook JSON from stdin, builds
events, POSTs to `${TRACERY_HUB_URL}/v1/events` with `TRACERY_API_KEY`, 2 s
timeout, spools to `${TMP}/tracery/spool.ndjson` on failure and
drains the spool on the next call, always exits 0, logs nothing to stdout.
Include a `/activity` skill that prints the hub deep link for the current
session. Tests: node:test feeding recorded hook payloads through the mapper and
asserting the emitted events pass core's `validateEvent`; an end-to-end test
that runs the emitter against a hub started from `apps/hub` and checks the flow
appears with a spawn edge to a subagent flow.
