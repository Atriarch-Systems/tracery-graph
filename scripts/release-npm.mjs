// Publish only the exact tarballs that passed publish:check in this workflow run,
// each with an npm provenance attestation (`npm publish --provenance`).
//
//   node scripts/release-npm.mjs [artifacts/npm] [--no-provenance]
//
// Runs in the `publish-npm` job on a GitHub-hosted runner (`id-token: write`),
// the only place npm can sign provenance. Authentication is NODE_AUTH_TOKEN
// (the NPMJS_TOKEN secret) or, once each package has a Trusted Publisher on
// npmjs.com, OIDC with no token at all; npm picks whichever applies.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const REGISTRY = 'https://registry.npmjs.org';
export const EXPECTED_PACKAGES = ['core', 'visualizer', 'client', 'react', 'hub'].map(name => `@atriarch-systems/tracery-${name}`);

/** Reads packages.json and proves every tarball on disk still has the digests recorded by publish:check. */
export function loadVerifiedPackages(directory, readFile = readFileSync) {
  const packages = JSON.parse(readFile(path.join(directory, 'packages.json'), 'utf8'));
  if (JSON.stringify(packages.map(pkg => pkg.name)) !== JSON.stringify(EXPECTED_PACKAGES)) throw new Error('Unexpected package set/order');
  for (const pkg of packages) {
    if (!/^[a-z0-9.-]+\.tgz$/.test(pkg.filename)) throw new Error('Invalid tarball filename');
    const bytes = readFile(path.join(directory, pkg.filename));
    if (createHash('sha256').update(bytes).digest('hex') !== pkg.sha256 ||
        `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== pkg.integrity) {
      throw new Error(`Artifact digest mismatch: ${pkg.name}`);
    }
  }
  return packages;
}

/**
 * Looks up every version before anything is published. A retry may skip an
 * identical immutable package, but never silently skips different bytes.
 */
export async function planPublish(packages, fetcher = fetch) {
  const pending = [];
  const existing = [];
  for (const pkg of packages) {
    const response = await fetcher(`${REGISTRY}/${encodeURIComponent(pkg.name)}/${pkg.version}`);
    if (response.status === 404) { pending.push(pkg); continue; }
    if (!response.ok) throw new Error(`Registry lookup failed: ${response.status} for ${pkg.name}`);
    const published = await response.json();
    if (published.dist?.integrity !== pkg.integrity) throw new Error(`Version already exists with different bytes: ${pkg.name}@${pkg.version}`);
    console.log(`Already published, matching integrity: ${pkg.name}@${pkg.version}`);
    existing.push(pkg);
  }
  return { pending, existing };
}

export function publishArgs(tarball, { provenance = true } = {}) {
  return ['publish', tarball, '--access', 'public', '--ignore-scripts', ...(provenance ? ['--provenance'] : []), '--registry', `${REGISTRY}/`];
}

/** Waits for the registry to list the provenance attestation of a published version. */
export async function requireProvenance(pkg, { fetcher = fetch, attempts = 12, delayMs = 10_000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await fetcher(`${REGISTRY}/${encodeURIComponent(pkg.name)}/${pkg.version}`);
    if (response.ok) {
      const published = await response.json();
      if (published.dist?.integrity === pkg.integrity && published.dist?.attestations?.url) return;
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  throw new Error(`No provenance attestation on the registry for ${pkg.name}@${pkg.version}`);
}

export async function releaseNpm(directory, { provenance = true, fetcher = fetch, run = defaultRun, readFile = readFileSync, attestation = {} } = {}) {
  const packages = loadVerifiedPackages(directory, readFile);
  const { pending, existing } = await planPublish(packages, fetcher);
  for (const pkg of pending) {
    const result = run('npm', publishArgs(path.join(directory, pkg.filename), { provenance }));
    if (result.status !== 0) throw new Error(`Publish failed: ${pkg.name}@${pkg.version}`);
  }
  if (provenance) {
    // Only what this run published must carry an attestation. A package skipped as
    // already published may predate provenance (an unchanged visualizer released
    // under an earlier version, for example), so it is not held against this release.
    for (const pkg of pending) await requireProvenance(pkg, { fetcher, ...attestation });
  }
  return { published: pending.map(pkg => `${pkg.name}@${pkg.version}`), skipped: existing.map(pkg => `${pkg.name}@${pkg.version}`) };
}

function defaultRun(command, args) {
  return spawnSync(command, args, { stdio: 'inherit' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const directory = path.resolve(args.find(arg => !arg.startsWith('--')) ?? 'artifacts/npm');
  await releaseNpm(directory, { provenance: !args.includes('--no-provenance') });
}
