# Changelog

## Unreleased

## v0.1.3

Supply-chain hardening: a smaller hub dependency tree, an opt-in OpenAPI document and npm provenance.
Core, client, React and hub 0.1.3; visualizer stays 0.3.2.

### Hub

- **OpenAPI is pre-generated and off by default.** The hub no longer builds its OpenAPI document at
  runtime. It is generated at build time from the real route schemas (`npm run openapi`, using
  `@fastify/swagger` as a devDependency), committed as `apps/hub/openapi.json`, and shipped in the
  package and the Docker image. `GET /v1/openapi.json` is served only when `TRACERY_OPENAPI=1`;
  otherwise it is a 404. Behaviour when enabled is unchanged (same document, no authentication).
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
- The job works with the existing `NPMJS_TOKEN` secret and is ready for npm Trusted Publishing (no token):
  docs/PUBLISHING.md lists the exact Trusted Publisher settings to enter for each package.
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
