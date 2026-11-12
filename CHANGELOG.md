# Changelog

## Unreleased

## v0.1.5

The first release on npm and Docker Hub since v0.1.2. It ships everything listed under v0.1.4
and v0.1.3 below: both were tagged, but their npm publish job never ran, so neither reached a
registry and their GitHub releases stay drafts. Upgrading from 0.1.2, read both sections. Core,
client, React and hub 0.1.5; visualizer 0.4.0. No code changes since v0.1.4.

### Release workflow

- **npm publishing runs on the self-hosted runner again.** Since v0.1.3 the `publish-npm` job ran
  only on a GitHub-hosted runner (`ubuntu-latest`), so that npm could sign provenance. The
  organization has no GitHub-hosted minutes, so that job waited 24 hours and was cancelled, for
  v0.1.3 and for v0.1.4. It now runs on `[self-hosted, Linux, X64, arc-amd64]` with
  `NPMJS_TOKEN` and publishes **without** a provenance attestation, as v0.1.2 did. The tested
  tarballs, their checksums and the commit check are unchanged.
- **New `npm_provenance` input** (manual runs, default off) moves `publish-npm` back to
  `ubuntu-latest` and publishes with `--provenance`, for when GitHub-hosted runners are available.
  Without it, a missing `NPMJS_TOKEN` now fails the job, since Trusted Publishing works only on
  GitHub-hosted runners.
- docs/PUBLISHING.md, docs/HARDENING.md and CLAUDE.md describe the new default.

## v0.1.4 (tagged, not published; shipped in v0.1.5)

Easier-to-read activity graphs: pipelines lay out left to right, single call edges lose their
`×1` labels, and idle cards can keep their accent colour. Core, client, React and hub 0.1.4;
visualizer 0.4.0.

### Visualizer 0.4.0

- **Data edges order siblings into columns.** In `placeBranches` (guided layout), a node with
  `kind: 'data'` edges from siblings (nodes with the same placement parent) is placed to the right
  of the furthest of them, on that sibling's row, after they are placed. A pipeline whose steps are
  all called by one parent now reads left to right; before, every step stacked in one column beside
  the parent, alternating above and below it. Data edges still never make a node anyone's
  placement parent; a `lane` hint still sets the row; data cycles still place every node. Graphs
  without data edges between siblings are laid out exactly as before. **Upgrade note:** guided
  layouts with such edges change shape. Positions you saved from an earlier version are kept as
  they are; only newly placed cards follow the new rule.
- **Edge labels say only what is useful.** A label pill reads `invoke` for a single edge and
  `invoke ×3` for a repeated one (it read `invoke ×1` before). An edge with no label and a count
  of 1 draws no pill, even with `showLabel`.
- **Spawn edges are thinner**: 1 px wider than a call edge of the same count instead of 2.5 px.
- **`GraphTheme.nodeAccentIdleMix`** (optional, 0-1, default 0): how much of a node's own
  accent stays on its accent bar and detail text once it is idle. Set it to 1 when the accent
  carries meaning that outlives activity, such as a finished step's state. Unset, idle cards
  draw exactly as before.

### Core 0.1.4

- **Call edges no longer ask for a label** (`showLabel: false`; it was `true`). The visualizer
  still labels an edge once its count is above 1 or an end is selected, so a graph of single
  calls is no longer covered in `invoke ×1` pills. Spawn edges keep `showLabel: true`.

### Client, React and hub 0.1.4

- No code changes; they move to core 0.1.4 and visualizer 0.4.0. Helm `appVersion` and the k8s
  image tag follow.
- Hub image: Alpine 3.24.4 (was 3.24.2), with the runtime packages re-pinned to what the 3.24
  repository now serves (`alpine-release` 3.24.4-r0, `musl` 1.2.6-r3, `ca-certificates-bundle`
  20261020-r0; `libgcc`/`libstdc++` unchanged). The old pins had left the repository, so the image
  no longer built. `licenses/container-policy.json` records the new versions and aports commits.
  The source collector now fetches recipes from the canonical aports repository
  (gitlab.alpinelinux.org) instead of the GitHub mirror, which lagged a point release behind
  (it lacked the 3.24.4 release commit).

## v0.1.3 (tagged, not published; shipped in v0.1.5)

Supply-chain hardening: a smaller hub dependency tree, an opt-in OpenAPI document and npm provenance
(provenance is opt-in from v0.1.5: see the release workflow notes there).
Core, client, React and hub 0.1.3; visualizer stays 0.3.2.

### Hub

- **OpenAPI is pre-generated and off by default.** The hub no longer builds its OpenAPI document at
  runtime. It is generated at build time from the real route schemas (`npm run openapi`, using
  `@fastify/swagger` as a devDependency), committed as `apps/hub/openapi.json`, and shipped in the
  package and the Docker image. `GET /v1/openapi.json` is served only when `TRACERY_OPENAPI=1`;
  otherwise it is a 404. When enabled it is served as before (no authentication). The document covers the hub's built-in
  routes; routes added by a `TRACERY_EXTENSIONS_MODULE` are not in it.
  A test fails if the committed document drifts from the routes. **Upgrade note:** set
  `TRACERY_OPENAPI=1` if you or your tooling fetch `/v1/openapi.json`; the "UI not built" page no longer
  links to it.
- `@fastify/swagger` is no longer a runtime dependency: six fewer packages in the hub's production tree
  (104 to 98 third-party packages: `@fastify/swagger`, `json-schema-resolver`, `openapi-types`, `yaml`,
  `debug`, `ms`). It was also the source of an "unstable ownership" supply-chain alert.
- `safe-buffer` (a socket.dev "optimized override" alert) stays: it is reached only through
  `@fastify/websocket` > `duplexify` > `readable-stream@3` > `string_decoder`, and the latest releases of all
  of those still depend on it. See docs/HARDENING.md "Supply chain (v0.1.3)" for why an npm override does
  not help consumers and what you can do.
- `TRACERY_OPENAPI` is documented in the hub README and the root README environment tables.

### Releases

- **npm provenance.** The npm packages are now published with `npm publish --provenance` from a new
  GitHub-hosted `publish-npm` job (`contents: read`, `id-token: write`), so each release carries a signed
  attestation linking the tarball to the workflow run and commit. Everything else, including the Docker
  Hub and GitHub release publishing, stays on the self-hosted runners. The jobs run in order (`preflight`
  creates the tag and draft release, `publish-npm`, then `publish`), so the GitHub release is still undrafted
  only after npm and Docker Hub are both published. `scripts/release-npm.mjs` re-verifies the checksums,
  keeps its "already published with matching integrity" skip (the unchanged visualizer 0.3.2 is skipped
  this way), and now requires the registry to show the attestation for what it publishes; it has tests.
- The job works with the existing `NPMJS_TOKEN` secret and also supports npm Trusted Publishing (OIDC).
- `publish:check` also verifies that the hub tarball ships `openapi.json`, does not serve it by default and
  has no `@fastify/swagger` runtime dependency.

## v0.1.2

Explorer drag performance, visible bounds and node detail props, plus the hardened hub image.
Core, client, React and hub 0.1.2; visualizer 0.3.2.

### Explorer

- Fixed the lag after dragging a node in the explorer. A dropped card can be grabbed at its new place
  immediately (the pointer canvas is refreshed on drop, settle and zoom instead of every 800 ms); a drop
  no longer replays a paused simulation or reheats the layout; canvas callbacks keep stable identities
  (a new one made force-graph repaint synchronously on every render); the canvas repaints only while
  something animates or moves; group hulls are cached; the glow is skipped on graphs over 150 nodes or
  with reduced motion; live updates keep the graph and card positions and only repaint unless a node or
  edge was added or removed; node lookups use maps, and the inspector memoises its JSON.
- New explorer props, all optional: `nodeDetail`, `nodeFooter`, `showNodeList`, `nodeListCollapsible`,
  `nodeListInitiallyCollapsed` and `reducedMotion`; theme variables `--tracery-border`,
  `--tracery-canvas-bg` and `--tracery-panel-bg` (theme fields `border`, `canvasBg`, `panelBg`); a Fit
  button in the graph toolbar.
- The node list under the graph has a visible top border, and every panel line follows
  `--tracery-border`.
- `fitView` (and the Fit button) frames the cards' full extents and solves the zoom directly, so edge
  cards stay inside the canvas at any zoom and viewport width.
- Visualizer: `HullCache`, `hitTestShape`, `sameStructure`, and a `shadows` argument on `drawNode`/`drawLink`.
  `groupAlpha` also takes a set of dimmed group ids.

### Hub image and deployment

- The hub image is now shell-less: a FROM scratch runtime with the Node binary
  and six pinned Alpine packages (musl, libgcc, libstdc++, ca-certificates-bundle,
  alpine-release, alpine-keys). No shell, busybox, apk, wget, nc or su. It keeps
  only the hub's production dependencies and uses an exec-form HEALTHCHECK. Size
  (amd64): 422 MB to 166 MB unpacked, 231 MB to 53 MB compressed.
- The image runs as a fixed numeric user, uid/gid 10001, so Kubernetes
  runAsNonRoot can verify it. App code is owned by root and read-only to that
  user; only /data belongs to it. The 0.1.1 image let the runtime user modify
  the app code.
- OS package sources moved out of the runtime image. They are published as
  <version>-sources Docker Hub tags and as GitHub release assets, and
  /usr/share/tracery/SOURCES.txt in the image says where to get them.
- The Helm chart and apps/hub/k8s/deployment.yaml run the hub as uid 10001 with
  a read-only root filesystem, a /tmp emptyDir, all capabilities dropped, no
  privilege escalation and RuntimeDefault seccomp. apps/hub/docker-compose.yaml
  uses a read-only root filesystem, a /tmp tmpfs, no capabilities and
  no-new-privileges. These settings also work with the 0.1.1 image.
- Fixed the Helm chart appVersion (the default image tag) and the
  apps/hub/k8s/deployment.yaml image tag, which pointed at 0.1.0, a tag that was
  never published. Both now use 0.1.1, and the chart version is 0.1.1.
- The release workflow now fails if the Helm appVersion or the k8s manifest
  image tag differ from the package version.
- The Docker, Kubernetes and getting-started docs recommend the non-root user,
  a read-only root filesystem and dropped capabilities, with examples.

## v0.1.1 — released 2026-09-26

The npm packages and the multi-arch Docker Hub image (atriarchsystems/tracery-hub)
are published. The Python client is not on PyPI yet; install it from a checkout.

- Renamed the product to Tracery Graph (the name Tracery belongs to Kate
  Compton's long-standing story-grammar library). Code-level names are
  unchanged: npm packages @atriarch-systems/tracery-*, the tracery-hub command,
  TRACERY_* variables and the Docker image. The Python distribution is now
  atriarch-tracery-graph (import atriarch.tracery is unchanged), and the Claude
  Code plugin installs as tracery-graph@atriarch-systems.
- Publish tested npm packages and Docker images through tag-triggered GitHub
  Actions, with manual validate/publish controls and retained SBOM/scan evidence.
- Create annotated release tags and draft GitHub releases from the manual workflow.
- Build and test AMD64 and ARM64 containers on native runners; publish combined
  version/latest tags plus explicit architecture tags after both pass.
- Include matching Alpine sources, patches, build recipes and notices with each
  container; preserve Node's complete license and enforce the reviewed inventory.
- Preserve Vite and bundled runtime-helper notices in browser builds and exports.
- Pin new and restored guided-layout nodes before the first physics tick.
- Remove unused npm/Corepack/Yarn from the runtime image and pin upstream images.
- Reject unreviewed final-artifact licenses, secrets and high/critical
  vulnerability findings before publication.
- Release workflow reads the npmjs.com token from NPMJS_TOKEN (was NPM_TOKEN) so
  it cannot be confused with the internal Nexus registry's credentials.
- Prepare core/client/React/hub 0.1.1 and visualizer 0.3.1. Python remains 0.1.0.
- Packages are published under the @atriarch-systems npm scope (the org that
  exists); the visualizer's package name changes with it.
- Container images publish as atriarchsystems/tracery-hub on Docker Hub (the
  org that exists; Docker Hub namespaces cannot contain hyphens).

- Make the client flush-concurrency regression deterministic: control timer ticks
  and transport completion instead of assuming eleven sends finish within 500 ms.

- Make source builds the active hub/plugin quick start; mark npm, PyPI and
  prebuilt Docker distribution as pending. Add the missing local image build
  step and correct Docker smoke commands for explicit local authentication opt-out.

## v0.1.0 — source release

This is the first coordinated GitHub source release. npm, PyPI and container
publication are separate; use the checkout/build instructions in README.md.
The visualizer retains its existing package version 0.3.0; this repository tag
does not reset independent package or wire-contract versions.

### Fixes

- Remember manually dragged node/group positions across live updates, follow-latest
  flow changes and temporarily leaving a scope. Reload/remount clears this cache.
- Close active live shares on revocation and expiry; recheck authorization before
  sending snapshots, updates and heartbeats, and handle store errors safely.
- Restrict browser HTTP and WebSocket origins to the hub and an explicit allowlist;
  reject opaque origins and local-mode DNS-rebinding hostnames.
- Remove the container's implicit unauthenticated network default. Local container
  use now requires an explicit opt-out and should publish its port on loopback.
- Ship renderer-free core projection declarations that compile in an isolated
  TypeScript consumer. Import ActivityGraphProps/ActivityGraphHandle from
  @atriarch-systems/tracery-visualizer, rather than the core package.
- Freeze animation-test clocks to eliminate the default-theme CI race.
- Upgrade @fastify/static to 10.1.4; the updated npm dependency audit reports no findings.

### Distribution and contribution

- Generate complete third-party notices for hosted, offline and example UI builds;
  preserve reviewed upstream license fallbacks and copy notices into the Dockerfile.
- Add the locked-dependency license gate, Trivy license inventory and CycloneDX
  source SBOM artifacts to CI. Final container scanning remains a separate check.
- Add CONTRIBUTING.md, SECURITY.md and redistribution guidance. Enable GitHub private
  vulnerability reporting. Skip fork PR execution on shared self-hosted runners;
  trusted CI uses read-only repository permissions and non-persisted credentials.
- Document source-release installation and remove unverified service/trial claims.

### Migration and scope

Set TRACERY_ALLOWED_ORIGINS to exact comma-separated origins for cross-origin
browser clients, including the generator demo. Set TRACERY_PUBLIC_URL behind a
proxy whose public origin differs from the hub request origin. Native SDKs still
work without an Origin header and require keys in authenticated mode.

This release is for early testing. Stored traces may contain sensitive data;
context-redacted shares are not anonymized, and downloaded exports cannot be
revoked. npm/PyPI installs, final container SBOMs and registry publication are not
claimed by this source release. Enterprise extensions and commercial terms are
outside this repository.
