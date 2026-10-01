# Tracery Graph Hub (SPEC.md §6 "Packaging"). Build from the REPO ROOT:
#
#   docker build -f apps/hub/Dockerfile -t atriarchsystems/tracery-hub:dev .
#
# Multi-stage: builds the npm workspaces this image actually needs
# (@atriarch-systems/tracery-core + @atriarch-systems/tracery-hub), builds the hosted UI in
# apps/hub/web when that directory exists (workstream E), and ships a final
# shell-less runtime: the pinned Node binary, the few Alpine libraries it links
# against, and only the hub's production dependency closure. App code is owned
# by root and read-only to the runtime user (uid/gid 10001); only /data is theirs.
#
# The matching OS package sources are not inside the runtime image. They are
# built as a companion image (`--target sources-image`, published as
# <version>-sources) and attached to the GitHub release. The runtime image
# carries /usr/share/tracery/SOURCES.txt, which says where to get them, gives
# the archive's SHA-256 and includes a written offer. See licenses/CONTAINER-REVIEW.md.

FROM node:22.23.2-alpine3.24@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS build
WORKDIR /repo

# Full monorepo context: apps/hub/web may or may not exist yet, and copying
# the whole tree sidesteps having to conditionally COPY a maybe-missing
# directory (Docker COPY fails outright on a source that isn't there).
# .dockerignore excludes node_modules/dist/.git so this is always a clean
# source-only tree, never a developer's already-built working copy.
COPY . .

RUN npm ci

# Build all server and UI packages in dependency order. Core ships self-contained
# data declarations and never imports the renderer at runtime.
RUN npm run build -w @atriarch-systems/tracery-visualizer -w @atriarch-systems/tracery-core -w @atriarch-systems/tracery-client -w @atriarch-systems/tracery-react -w @atriarch-systems/tracery-hub

# Hosted UI (apps/hub/web, workstream E) is optional: when its package.json
# is present it is also an npm workspace (see the root package.json), so the
# `npm ci` above already installed its deps and it just needs building. When
# it is absent, leave an empty dist/ so the final stage's COPY always has
# something to copy; the hub then falls back to its "UI not built" placeholder
# page (apps/hub/src/routes/ui.ts) at runtime.
RUN if [ -f apps/hub/web/package.json ]; then \
      echo "building apps/hub/web"; \
      npm run build -w @atriarch-systems/tracery-hub-web; \
    else \
      echo "apps/hub/web not present yet; shipping without a hosted UI"; \
      mkdir -p apps/hub/web/dist; \
    fi

# Replace the whole workspace's install (react-dom, force-graph, vite, ...)
# with only the hub's production dependency closure, resolved from the same
# lockfile. The hub imports @atriarch-systems/tracery-core at runtime (a
# workspace link); core has no dependencies and only type-imports the
# visualizer, and apps/hub/web/dist is a prebuilt, self-contained bundle.
# The runtime copies only the root node_modules, so nothing may be nested in a
# workspace's own node_modules (an empty directory left behind for dev-only
# nested packages, e.g. apps/hub's pinned @fastify/swagger, is fine). Notices are
# generated from exactly this tree.
RUN rm -rf node_modules packages/*/node_modules apps/*/node_modules apps/hub/web/node_modules \
      clients/*/node_modules examples/*/node_modules \
 && npm ci --omit=dev --ignore-scripts --no-audit --no-fund -w @atriarch-systems/tracery-hub \
 && for dir in packages/*/node_modules apps/*/node_modules apps/hub/web/node_modules; do \
      if [ -d "$dir" ] && [ -n "$(find "$dir" -mindepth 2 -maxdepth 3 -name package.json -print -quit)" ]; then \
        echo "unexpected nested runtime dependencies: $dir"; ls -A "$dir"; exit 1; \
      fi; \
    done \
 && node scripts/runtime-notices.mjs

# Minimal runtime root filesystem, installed with apk into an empty root, so
# the final image has no shell, busybox, apk or other OS tooling. The APK
# database written here (lib/apk/db/installed) lists exactly the packages
# present, so Trivy and SBOM tools still see them, and it drives the source
# collection below. Versions are pinned; changing them requires a new review
# (licenses/container-policy.json).
FROM alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 AS rootfs
RUN apk add --no-cache --root /rootfs --initdb --no-scripts \
      --keys-dir /etc/apk/keys --repositories-file /etc/apk/repositories \
      alpine-release=3.24.2-r0 musl=1.2.6-r2 libgcc=15.2.0-r5 libstdc++=15.2.0-r5 \
      ca-certificates-bundle=20260909-r0 \
 && rm -rf /rootfs/var/log /rootfs/var/cache \
 && mkdir -p /rootfs/tmp /rootfs/usr/local/bin /volume/data \
 && chmod 1777 /rootfs/tmp \
 && printf '%s\n' 'root:x:0:0:root:/root:/sbin/nologin' 'tracery:x:10001:10001:tracery:/data:/sbin/nologin' \
      'nobody:x:65534:65534:nobody:/:/sbin/nologin' > /rootfs/etc/passwd \
 && printf '%s\n' 'root:x:0:' 'tracery:x:10001:' 'nobody:x:65534:' > /rootfs/etc/group
COPY --from=build /usr/local/bin/node /rootfs/usr/local/bin/node
# Fail the build if the unmodified Node binary needs a library the root lacks.
RUN chroot /rootfs /usr/local/bin/node -e "require('node:crypto').randomUUID(); new Intl.DateTimeFormat('en').format(0)"

# Collect sources for the runtime inventory. This runs in every build, so a
# runtime image is only produced once its matching sources have verified.
FROM alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 AS sources
RUN apk add --no-cache python3 git abuild xz
COPY --from=rootfs /rootfs/lib/apk/db/installed /runtime-installed
COPY scripts/container-sources.py /container-sources.py
RUN python3 /container-sources.py collect
# Where the archive is published. Only this cheap step depends on these values.
ARG SOURCE_IMAGE_REPOSITORY=atriarchsystems/tracery-hub
ARG SOURCE_RELEASE_REPOSITORY=Atriarch-Systems/tracery-graph
COPY apps/hub/package.json /hub-package.json
RUN python3 /container-sources.py describe

# Companion source image, published as <version>-sources next to the runtime
# image: docker build -f apps/hub/Dockerfile --target sources-image .
FROM scratch AS sources-image
COPY --from=sources /out/ /
LABEL org.opencontainers.image.title="Tracery Graph hub OS package sources" \
      org.opencontainers.image.description="Corresponding sources, recipes and notices for the Alpine packages in the matching tracery-hub image" \
      org.opencontainers.image.source="https://github.com/Atriarch-Systems/tracery-graph"

FROM scratch
COPY --from=rootfs /rootfs/ /
# Some official ARM builds omit /usr/local/LICENSE; preserve the same reviewed
# upstream license on both architectures. The release gate verifies its SHA-256.
COPY licenses/vendor/node-v22.23.2-LICENSE /usr/share/licenses/node/LICENSE
COPY --from=sources /out/SOURCES.txt /out/alpine-packages.json /out/sources.tar.gz.sha256 /usr/share/tracery/
# COPY makes files root-owned; only the data directory belongs to the runtime
# user. Copying its parent's contents chowns /data itself, not just its contents.
COPY --from=rootfs --chown=10001:10001 /volume/ /

# TRACERY_HOST=0.0.0.0: config.ts's local-mode default (127.0.0.1) is a
# Node-process convenience (`npx @atriarch-systems/tracery-hub`), not a container one
# -- a container needs to accept connections from outside its network
# namespace, so this image binds all interfaces explicitly.
#
# Network-exposed containers require API keys or an explicit runtime auth opt-out.
# PATH is the Alpine base image's value; a scratch image has none.
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NODE_ENV=production \
    TRACERY_HOST=0.0.0.0 \
    TRACERY_PORT=8971 \
    TRACERY_STORE=memory \
    TRACERY_SQLITE_PATH=/data/tracery.db

# Copied without --chown: root-owned and not writable by the runtime user.
WORKDIR /app
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/LICENSE /repo/NOTICE /repo/RUNTIME-NOTICES.txt ./
COPY --from=build /repo/apps/hub/web/dist/THIRD-PARTY-NOTICES.txt ./THIRD-PARTY-NOTICES.txt
COPY --from=build /repo/packages/core/package.json ./packages/core/package.json
COPY --from=build /repo/packages/core/dist ./packages/core/dist
COPY --from=build /repo/apps/hub/package.json ./apps/hub/package.json
COPY --from=build /repo/apps/hub/openapi.json ./apps/hub/openapi.json
COPY --from=build /repo/apps/hub/dist ./apps/hub/dist
COPY --from=build /repo/apps/hub/bin ./apps/hub/bin
COPY --from=build /repo/apps/hub/web/dist ./apps/hub/web/dist

# Numeric, so Kubernetes runAsNonRoot can verify it without reading /etc/passwd.
USER 10001:10001

VOLUME ["/data"]
EXPOSE 8971

# Exec form: this image has no shell.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.TRACERY_PORT||8971)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

WORKDIR /app/apps/hub
ENTRYPOINT ["node", "bin/hub.mjs"]
