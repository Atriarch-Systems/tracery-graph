#!/usr/bin/env python3
"""Archive corresponding Alpine sources, recipes and notices for the runtime.

Runs only in the isolated Docker source-collection stage, without credentials.
The installed APK database, not a hand-maintained package list, is authoritative.
Every upstream source must pass the exact recipe's abuild checksum verification.

  collect   fetch and verify sources; write /out/sources.tar.gz,
            /out/sources.tar.gz.sha256 and /out/alpine-packages.json
  describe  write /out/SOURCES.txt: where the archive is published (from the
            SOURCE_IMAGE_REPOSITORY / SOURCE_RELEASE_REPOSITORY build args and
            the hub version), its SHA-256, the package list and a written offer
"""
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile

ARCHITECTURES = {'x86_64': 'amd64', 'aarch64': 'arm64'}
# Alpine license expressions naming a GPL-family license.
GPL_FAMILY = re.compile(r'\b(A?GPL|LGPL)-')


def run(*args, cwd=None, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def read_inventory():
    db = Path('/runtime-installed').read_text()
    packages = []
    for record in db.strip().split('\n\n'):
        fields = dict(line.split(':', 1) for line in record.splitlines() if ':' in line)
        if 'P' not in fields:
            continue
        package = {key: fields.get(field, '') for key, field in {
            'name': 'P', 'version': 'V', 'license': 'L', 'origin': 'o',
            'aportsCommit': 'c', 'architecture': 'A',
        }.items()}
        if not re.fullmatch(r'[a-z0-9][a-z0-9+._-]*', package['origin']):
            raise RuntimeError(f'Invalid source origin: {package}')
        if not re.fullmatch(r'[0-9a-f]{40}', package['aportsCommit']):
            raise RuntimeError(f'Missing exact source revision: {package}')
        packages.append(package)
    if not packages:
        raise RuntimeError('Empty runtime inventory')
    return packages


def normalize(member):
    # Fresh files get "now" as their mtime, so a plain tar.gz differs on every
    # build. Zero everything build-specific so identical content always yields
    # the identical archive and SHA-256, whichever build produced it.
    member.mtime = 0
    member.uid = member.gid = 0
    member.uname = member.gname = ''
    if member.isdir():
        member.mode = 0o755
    elif member.isfile():
        member.mode = 0o755 if member.mode & 0o111 else 0o644
    elif member.issym():
        member.mode = 0o777
    else:
        raise RuntimeError(f'Unexpected special file in source bundle: {member.name}')
    return member


def write_reproducible_archive(root, destination):
    # tarfile.add walks directories in sorted order. GzipFile(mtime=0) with an
    # empty filename keeps the gzip header free of timestamps and paths.
    with (
        open(destination, 'wb') as raw,
        gzip.GzipFile(filename='', mode='wb', fileobj=raw, compresslevel=9, mtime=0) as compressed,
        tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as tar,
    ):
        tar.add(root, arcname='sources', filter=normalize)


def collect():
    packages = read_inventory()
    root = Path('/source-bundle')
    root.mkdir()
    git = Path('/aports')
    run('git', 'init', str(git))
    # The canonical aports repository: the GitHub mirror can lag a point release behind the packages.
    run('git', 'remote', 'add', 'origin', 'https://gitlab.alpinelinux.org/alpine/aports.git', cwd=git)
    origins = sorted({(p['origin'], p['aportsCommit']) for p in packages})
    run('git', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', 'fetch', '--depth=1',
        'origin', *sorted({commit for _, commit in origins}), cwd=git)
    for origin, commit in origins:
        print(f'Collecting {origin} at {commit}', flush=True)
        directory = root / 'recipes' / origin
        directory.mkdir(parents=True)
        archive = Path('/recipe.tar')
        run('git', 'archive', '--format=tar', f'--output={archive}', commit, f'main/{origin}', cwd=git)
        with tarfile.open(archive) as tar:
            tar.extractall('/recipe', filter='data')
        shutil.copytree(Path('/recipe/main') / origin, directory, dirs_exist_ok=True)
        shutil.rmtree('/recipe')
        version = subprocess.check_output(
            ['sh', '-c', '. ./APKBUILD; printf "%s-r%s" "$pkgver" "$pkgrel"'],
            cwd=directory, text=True)
        if any(p['version'] != version for p in packages if (p['origin'], p['aportsCommit']) == (origin, commit)):
            raise RuntimeError(f'Recipe version mismatch for {origin}: {version}')
        dist = root / 'distfiles' / origin
        dist.mkdir(parents=True)
        env = {**os.environ, 'SRCDEST': str(dist)}
        if (directory / 'src').exists():
            raise RuntimeError(f'Recipe unexpectedly includes a src directory: {origin}')
        run('abuild', '-F', 'fetch', 'verify', cwd=directory, env=env)
        # abuild makes absolute convenience symlinks here. They are not source;
        # exclude them so the delivered archive is relocatable on another machine.
        if (directory / 'src').exists():
            shutil.rmtree(directory / 'src')
        (directory / 'APORTS_COMMIT').write_text(commit + '\n')

    # Full source archives retain all notices, not just the filenames recognized here.
    # Also expose common upstream license texts without requiring archive extraction.
    notices = root / 'notices'
    notices.mkdir()
    for archive in sorted((root / 'distfiles').rglob('*')):
        if not archive.is_file() or not tarfile.is_tarfile(archive):
            continue
        with tarfile.open(archive) as tar:
            for member in tar:
                if not member.isfile() or member.size > 2_000_000:
                    continue
                if not re.match(r'^(LICENSE|LICENCE|COPYING|COPYRIGHT|NOTICE)([._-].*)?$', Path(member.name).name, re.I):
                    continue
                safe_name = re.sub(r'[^a-zA-Z0-9._-]', '_', member.name)
                destination = notices / archive.parent.name
                destination.mkdir(exist_ok=True)
                (destination / safe_name).write_bytes(tar.extractfile(member).read())

    shutil.copy('/runtime-installed', root / 'installed.apk.txt')
    (root / 'packages.json').write_text(json.dumps(packages, indent=2) + '\n')
    (root / 'README.txt').write_text('''Corresponding sources for the Alpine components in a Tracery Graph hub image.

packages.json records each installed binary package, version, declared license,
architecture, source origin and exact Alpine aports commit. installed.apk.txt is
the image's APK database (/lib/apk/db/installed). recipes/ contains that
commit's APKBUILD, patches and configuration. distfiles/ contains the upstream
source archives verified by abuild against that recipe's checksums. notices/
exposes common license texts; full archives retain all original notices.
SHA256SUMS covers every other file. No base-package source was modified by
Tracery Graph.

To rebuild a package, use an Alpine 3.24 environment of the recorded architecture
with alpine-sdk and the dependencies listed in its APKBUILD. Copy the recipe to
a writable directory, set SRCDEST to the corresponding distfiles/<origin>
directory, then run abuild -r as an unprivileged abuild user. See the Alpine
abuild documentation: https://wiki.alpinelinux.org/wiki/Abuild_and_Helpers
Toolchain/system dependencies are supplied by Alpine's v3.24 repositories.

The runtime image does not contain this archive. It is published next to the
image, as the <version>-sources tag of the same Docker Hub repository and as a
GitHub release asset. /usr/share/tracery/SOURCES.txt in the image gives the
exact locations and this archive's SHA-256.

Tracery Graph is Apache-2.0. These independent operating-system components retain
their own licenses; they are not relicensed by Tracery Graph. Node's complete license
and bundled notices are at /usr/share/licenses/node/LICENSE in the image.
''')
    hashes = []
    for item in sorted(root.rglob('*')):
        if item.is_file():
            hashes.append(f'{hashlib.sha256(item.read_bytes()).hexdigest()}  {item.relative_to(root)}')
    (root / 'SHA256SUMS').write_text('\n'.join(hashes) + '\n')
    Path('/out').mkdir()
    shutil.copy(root / 'packages.json', '/out/alpine-packages.json')
    write_reproducible_archive(root, Path('/out/sources.tar.gz'))
    digest = hashlib.sha256(Path('/out/sources.tar.gz').read_bytes()).hexdigest()
    Path('/out/sources.tar.gz.sha256').write_text(f'{digest}  sources.tar.gz\n')
    print(f'Collected verified sources for {len(packages)} packages / {len(origins)} origins', flush=True)


def describe():
    packages = json.loads(Path('/out/alpine-packages.json').read_text())
    if packages != read_inventory():
        raise RuntimeError('Collected inventory differs from the runtime APK database')
    digest = Path('/out/sources.tar.gz.sha256').read_text().split()[0]
    image = os.environ.get('SOURCE_IMAGE_REPOSITORY', '')
    github = os.environ.get('SOURCE_RELEASE_REPOSITORY', '')
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]*/[a-z0-9][a-z0-9._-]*', image):
        raise RuntimeError(f'Invalid SOURCE_IMAGE_REPOSITORY: {image!r}')
    if not re.fullmatch(r'[\w.-]+/[\w.-]+', github):
        raise RuntimeError(f'Invalid SOURCE_RELEASE_REPOSITORY: {github!r}')
    version = json.loads(Path('/hub-package.json').read_text())['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise RuntimeError(f'Invalid hub version: {version!r}')
    arches = {ARCHITECTURES.get(p['architecture']) for p in packages if p['architecture'] != 'noarch'}
    if len(arches) != 1 or None in arches:
        raise RuntimeError(f'Expected one supported image architecture, got {arches}')
    arch = arches.pop()
    width = max(len(p['name']) for p in packages)
    listing = '\n'.join(
        f"  {p['name']:<{width}}  {p['version']:<14} {p['license']}  (origin {p['origin']}, aports {p['aportsCommit'][:12]})"
        for p in packages)
    gpl = sorted(p['name'] for p in packages if GPL_FAMILY.search(p['license']))
    gpl_text = ', '.join(gpl) if gpl else 'none'
    Path('/out/SOURCES.txt').write_text(f'''Tracery Graph hub {version} ({arch}): operating-system package sources

This image contains these unmodified Alpine Linux 3.24 packages
(/lib/apk/db/installed; alpine-packages.json lists the same data as JSON):

{listing}

GPL/LGPL-family packages: {gpl_text}.

The complete corresponding source for every package above (the upstream
source archives, verified against Alpine's recorded checksums, plus Alpine's
build recipes, patches, configuration and the license notices) is in one
archive for this architecture:

  sources.tar.gz  SHA-256 {digest}

It is published in the same places as this image:

1. Docker Hub, in the same repository as this image:
     {image}:{version}-sources          (linux/amd64 + linux/arm64)
     {image}:{version}-sources-{arch}
   The source image holds /sources.tar.gz and this file. To copy them out:
     docker create --name tracery-sources --platform linux/{arch} {image}:{version}-sources unused
     docker cp tracery-sources:/sources.tar.gz .
     docker rm tracery-sources
   ("unused" is a placeholder command; the source image cannot run.)

2. GitHub, as an asset of the matching release:
     https://github.com/{github}/releases/tag/v{version}
     asset container-{arch}-sources.tar.gz

Check the download with: sha256sum sources.tar.gz
Its README.txt explains the layout and how to rebuild each package.

Written offer. For at least three years after Atriarch Systems last
distributes this image version, Atriarch Systems will give any third party,
for a charge no more than its cost of physically performing the distribution,
a complete machine-readable copy of the corresponding source code for the
packages listed above, on a medium customarily used for software interchange.
Request it by opening an issue naming this image version and architecture at
https://github.com/{github}/issues

Tracery Graph is Apache-2.0. These independent operating-system components keep
their own licenses; they are not relicensed by Tracery Graph. Node's complete license
and bundled notices are at /usr/share/licenses/node/LICENSE in the image.
''')
    print(f'Described sources for {image}:{version} ({arch}); GPL-family: {gpl_text}', flush=True)


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else ''
    if mode == 'collect':
        collect()
    elif mode == 'describe':
        describe()
    else:
        raise SystemExit('usage: container-sources.py collect|describe')
