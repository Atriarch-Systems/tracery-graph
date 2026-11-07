# Container redistribution review

Reviewed for the release candidate on 2026-09-23 and updated on 2026-09-26 for
the slimmed, shell-less runtime image. This records the engineering basis for
distribution; it is not a legal opinion or a guarantee of ownership.

## Application and commercial use

Tracery Graph's original code is Apache-2.0. The locked JavaScript application
dependencies reviewed here have permissive licenses; no GPL, LGPL, AGPL or SSPL
application dependency was found. Keep the package license gate and browser
notice generation enabled. Atriarch's ownership confirmation covers the original
visualizer code, not the separately licensed packages it uses.

Nothing identified in this review requires the independent Tracery Graph application
or private managed-service implementation to be relicensed under the GPL.
Commercial hosting and distribution still require respecting third-party
notices and any applicable source obligations. This review covers the public
community artifacts, not a future private enterprise distribution.

The release matrix applies this review independently to Linux AMD64 and ARM64.
Each native image must match the reviewed package versions and source commits;
its recorded APK architecture must match the tested image. Each has its own
published source archive and retained scan/SBOM evidence.

## Exact runtime

- Node 22.23.2, from the digest-pinned official `node:22.23.2-alpine3.24` image.
  Copy its unmodified binary and the complete reviewed upstream LICENSE from
  licenses/vendor; the official ARM image omits /usr/local/LICENSE. npm, Corepack and
  Yarn are absent from the final image, including its base layers.
- Alpine 3.24.4 packages, version pinned, installed with `apk --root` into an
  empty root filesystem (the final stage is `FROM scratch`). The exact 6
  packages, source commits and declared licenses are recorded in
  [container-policy.json](container-policy.json): musl, libgcc, libstdc++ (the
  libraries the Node binary links against), ca-certificates-bundle, and
  alpine-release with its dependency alpine-keys (OS identification for
  scanners). The APK database lists exactly these, so Trivy and SBOM tools see
  every installed package.
- There is no shell, busybox, apk-tools, wget, nc, su, scanelf, musl-utils,
  OpenSSL or zlib package in the image (Node bundles its own OpenSSL and zlib).
  The health check runs `node` in exec form. `/etc/passwd` and `/etc/group`
  are three-line files written by the build, not a package.
- The application's `node_modules` is only the hub's production dependency
  closure, installed from the lockfile with `npm ci --omit=dev -w
  @atriarch-systems/tracery-hub`. RUNTIME-NOTICES.txt is generated from that tree.
- Changes to that inventory or Node's full license-text digest fail the release
  gate until the new material is reviewed. This is not a blanket GPL exception
  for application code.

## Operating-system components

These are independent, unmodified distribution components. GPL components in an
aggregate do not automatically relicense the other independent programs in it.
See [GPLv2 section 2](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html) and
the [GNU aggregation FAQ](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation).
They do still have their own redistribution obligations.

| Source origin | Scope and treatment |
| --- | --- |
| gcc (libgcc, libstdc++) | The only GPL/LGPL-family packages left. Alpine metadata combines GPL/LGPL labels; the libraries carry GCC runtime permissions. Full corresponding source (the GCC release archive), notices including COPYING.RUNTIME, Alpine patches/configuration and build recipes are published with the binaries. No application source exemption is inferred solely from Alpine's metadata. |
| musl | MIT libc; all origin sources and recipes are published as well. |
| ca-certificates | MPL-2.0/MIT certificate material; matching source and notices are published with the image. |
| alpine-base (alpine-release), alpine-keys | Permissive components; full matching source, recipe and notices are published as well. |

The earlier 18-package runtime also shipped alpine-baselayout, apk-tools,
busybox and pax-utils (GPL-2.0), musl-utils, OpenSSL and zlib. None of them is
in the image any more, so they carry no source obligation for new releases.
Images already published keep their embedded source archives.

The [GCC Runtime Library Exception](https://www.gnu.org/licenses/gcc-exception-3.1.html)
permits qualifying independent programs to use the runtime under their own
licenses. Tracery Graph copies the official, unmodified Node runtime and dynamically
linked Alpine runtime libraries; it does not modify GCC or use proprietary GCC
compiler plugins. Including the library sources avoids relying on that exception
as a reason to omit the libraries' own source material.

`scripts/container-sources.py` reads the actual runtime APK database, fetches
each origin's exact aports revision, and verifies every source against its
APKBUILD checksums using `abuild`. Recipes, patches, configuration, upstream
archives, common license texts and an inventory are archived together.
The archive is reproducible: entries are written in sorted order with zeroed
timestamps and owners and normalized modes, and the gzip header carries no
timestamp or file name. The same verified sources always give the same
`sources.tar.gz` and SHA-256, whichever build produced them, so the runtime
image and the separately built source image agree even without a shared
build cache.

The archive is **not inside the runtime image**. It is published with each
release from the same places as the binaries, as GPLv2 section 3 and LGPL-2.1
section 4 allow ("equivalent access to copy the source code from the same
place"):

- **Docker Hub**, same repository: `<version>-sources-amd64`,
  `<version>-sources-arm64` and the multi-platform `<version>-sources`. Each
  is a `FROM scratch` image holding only `/sources.tar.gz`, `SOURCES.txt`,
  `alpine-packages.json` and `sources.tar.gz.sha256`, built by the
  Dockerfile's `sources-image` target in the same build as the runtime image.
  The release pushes these tags **before** the runtime tags, and all of them
  are immutable.
- **GitHub release**: `container-<arch>-sources.tar.gz`, plus its
  `SOURCES.txt` and checksum. `scripts/release-github.mjs` refuses to
  publish a release without them.

The runtime image carries `/usr/share/tracery/SOURCES.txt` (and
`alpine-packages.json`, `sources.tar.gz.sha256`): the package list and
licenses, both published locations, the archive's SHA-256, extraction
instructions and a three-year written offer. The release smoke test
(`scripts/release-image-check.mjs`) copies the archive out of the source image,
checks it against the SHA-256 recorded in the runtime image, verifies every
SHA256SUMS entry (and that nothing is unlisted), and compares its inventory and
APK database with the live runtime image. The publish job checks that each
SOURCES.txt names the Docker Hub repository and GitHub release it publishes to.

Keep the `-sources` tags and release assets available for as long as the
matching runtime tags are offered. Do not delete them while the image is
still pullable. The written offer names GitHub issues as the request channel;
a postal or email contact can be added there if one is preferred.

## Node's bundled notices

Node's full license file includes MIT/BSD/ISC/Zlib/Apache notices, ICU, c-ares,
NAIST, Artistic-2.0, and Autoconf exception text. Trivy reports the latter as GPL
findings even though the additional permissions apply to generated output.
These findings are accepted **only** at `/usr/share/licenses/node/LICENSE`, with
the exact reviewed SHA-256 in the policy. The exception never applies to a GPL
application dependency or a different file. Preserve the entire upstream file,
not just its leading MIT paragraph.

Sources: [Node 22.23.2 LICENSE](https://github.com/nodejs/node/blob/v22.23.2/LICENSE),
[Autoconf exception](https://www.gnu.org/licenses/autoconf-exception-3.0.html),
and [official Node image runtime guidance](https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md#smaller-images-without-npmyarn).

## Evidence and limits

The release workflow retains source and final-image CycloneDX SBOMs, full Trivy
license/vulnerability/secret reports, exact tested npm tarballs, package
integrities, source archive and SHA-256 checksums. It rejects empty scans,
unreviewed licenses, detected secrets and HIGH/CRITICAL vulnerabilities.
Permissive BlueOak-1.0.0 is explicitly recognized even though Trivy labels it
unknown. Reports retain those findings instead of suppressing them.

Scans do not prove authorship, patent clearance or trademark rights. Do not turn
this review into an unconditional claim that all third-party software is
Apache-2.0, or reuse it to approve a changed enterprise artifact.
