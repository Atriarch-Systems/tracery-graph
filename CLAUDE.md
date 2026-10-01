# CLAUDE.md — Tracery Graph

Agent activity graphs: an event contract, pure reducers, a React canvas
visualizer, emitter SDKs (TS + Python) and a standalone hub server that stores
and draws activity pushed by many applications.

Read `docs/SPEC.md` before changing anything. `packages/core/src/contract.ts` is
the wire contract; a change there is a versioned contract change with a golden test.

## Layout

| Path | Package | What |
| --- | --- | --- |
| `packages/core` | `@atriarch-systems/tracery-core` | contract, validation, journal, flows, traces, projection. No DOM, no React. |
| `packages/visualizer` | `@atriarch-systems/tracery-visualizer` | canvas component (moved here from atriarch-agentkit). |
| `packages/react` | `@atriarch-systems/tracery-react` | `ActivityExplorer` composite + live-source hooks. |
| `packages/client` | `@atriarch-systems/tracery-client` | TS emitter SDK + hub read client. |
| `clients/python` | `atriarch-tracery-graph` | Python emitter SDK, stdlib only, `atriarch.tracery`. |
| `apps/hub` | `@atriarch-systems/tracery-hub` | Fastify server, stores, live feed, hosted UI, Docker, k8s. Its OpenAPI document is generated at build time (`npm run openapi -w @atriarch-systems/tracery-hub`) and committed as `apps/hub/openapi.json`; regenerate it after any route schema change (a test fails on drift). |

Tracery Cloud (accounts, SSO, audit log, RBAC, managed retention/backups) is
a private `tracery-cloud` repository, not part of this checkout. It plugs
into `apps/hub` via the `HubExtensions` seam (`apps/hub/src/server-context.ts`,
loaded through `TRACERY_EXTENSIONS_MODULE`) -- see `docs/SPEC.md` §7 and
`docs/CLOUD.md`.

## Conventions

- ESM only, TypeScript strict, `tsconfig.json` extends `../../tsconfig.base.json`.
- Tests: `node --test tests/*.test.mjs` against `dist/`, build first. Python: pytest.
- Consumer inputs are `readonly` and never mutated. No `any` in exports.
- Node >= 22.13 (`node:sqlite`). Python 3.11 is the supported interpreter.
- CI runs on self-hosted runners only. The single exception is the release workflow's `publish-npm` job, which must be GitHub-hosted (`ubuntu-latest`) so npm can sign provenance and accept Trusted Publishing (docs/PUBLISHING.md).
- Licensing: original Tracery Graph code is Apache-2.0; third-party files retain their
  own licenses. No enterprise implementation or runtime commercial-license gate
  lives in this repository. Release license-compliance checks are required.

## Commands

```bash
npm ci && npm run build && npm test            # all workspaces
python -m pip install -e clients/python[dev] && python -m pytest -q clients/python
docker build -f apps/hub/Dockerfile -t atriarchsystems/tracery-hub .
node scripts/demo.mjs                           # end-to-end against a running hub
```

## Git hygiene

Stage explicit paths, never `git add -A`. Other agents may be working in
sibling directories of this checkout.
