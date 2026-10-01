import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { EXPECTED_PACKAGES, loadVerifiedPackages, planPublish, publishArgs, releaseNpm, requireProvenance } from './release-npm.mjs';

const directory = path.resolve('artifacts/npm');
const names = ['core', 'visualizer', 'client', 'react', 'hub'];
const bytes = Object.fromEntries(names.map(name => [name, Buffer.from(`tarball ${name}`)]));
const meta = name => ({
  name: `@atriarch-systems/tracery-${name}`, version: '0.1.3', filename: `atriarch-systems-tracery-${name}-0.1.3.tgz`,
  sha256: createHash('sha256').update(bytes[name]).digest('hex'), integrity: `sha512-${createHash('sha512').update(bytes[name]).digest('base64')}`,
});
const packages = names.map(meta);
function files(overrides = {}) {
  const table = { [path.join(directory, 'packages.json')]: JSON.stringify(packages), ...overrides };
  for (const name of names) table[path.join(directory, meta(name).filename)] ??= bytes[name];
  return file => { if (!(file in table)) throw new Error(`unexpected read ${file}`); return table[file]; };
}
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

/** A fake registry: `published` maps package name to its dist; publishing through `run` adds an entry (with attestations unless told otherwise). */
function registry({ published = {}, attest = true } = {}) {
  const state = { ...published };
  const commands = [];
  return {
    commands,
    state,
    fetcher: async url => {
      const name = decodeURIComponent(url.replace('https://registry.npmjs.org/', '').split('/0.1.3')[0]);
      return state[name] ? json(200, { dist: state[name] }) : json(404, {});
    },
    run: (command, args) => {
      commands.push([command, ...args]);
      const pkg = packages.find(candidate => args[1].endsWith(candidate.filename));
      state[pkg.name] = { integrity: pkg.integrity, ...(attest ? { attestations: { url: 'https://registry.npmjs.org/-/npm/v1/attestations/x' } } : {}) };
      return { status: 0 };
    },
  };
}
const fast = { attestation: { attempts: 2, delayMs: 0, sleep: async () => {} } };

test('expected package set is the five published workspaces in dependency order', () => {
  assert.deepEqual(EXPECTED_PACKAGES.map(name => name.split('-').pop()), names);
});

test('every tarball must match its recorded digests, the package set and order', () => {
  assert.equal(loadVerifiedPackages(directory, files()).length, 5);
  assert.throws(() => loadVerifiedPackages(directory, files({ [path.join(directory, meta('core').filename)]: Buffer.from('tampered') })), /Artifact digest mismatch: @atriarch-systems\/tracery-core/);
  assert.throws(() => loadVerifiedPackages(directory, files({ [path.join(directory, 'packages.json')]: JSON.stringify([...packages].reverse()) })), /Unexpected package set\/order/);
  assert.throws(() => loadVerifiedPackages(directory, files({ [path.join(directory, 'packages.json')]: JSON.stringify(packages.map(pkg => ({ ...pkg, filename: '../x.tgz' }))) })), /Invalid tarball filename/);
});

test('publishes the exact tarballs in order with --provenance and without lifecycle scripts', async () => {
  const fake = registry();
  const result = await releaseNpm(directory, { fetcher: fake.fetcher, run: fake.run, readFile: files(), ...fast });
  assert.equal(result.published.length, 5);
  assert.deepEqual(fake.commands.map(command => path.basename(command[2])), packages.map(pkg => pkg.filename));
  for (const command of fake.commands) {
    assert.equal(command[0], 'npm');
    for (const flag of ['--provenance', '--ignore-scripts', '--access', 'public']) assert.ok(command.includes(flag), flag);
  }
  assert.ok(!publishArgs('x.tgz', { provenance: false }).includes('--provenance'));
});

test('already published with matching integrity is skipped, and only the rest is published', async () => {
  const attested = pkg => ({ integrity: pkg.integrity, attestations: { url: 'https://registry.npmjs.org/-/npm/v1/attestations/x' } });
  const fake = registry({ published: { [packages[0].name]: attested(packages[0]), [packages[1].name]: attested(packages[1]) } });
  const result = await releaseNpm(directory, { fetcher: fake.fetcher, run: fake.run, readFile: files(), ...fast });
  assert.equal(result.skipped.length, 2);
  assert.deepEqual(fake.commands.map(command => path.basename(command[2])), packages.slice(2).map(pkg => pkg.filename));
});

test('a version that exists with different bytes stops everything before any publish', async () => {
  const fake = registry({ published: { [packages[3].name]: { integrity: 'sha512-other', attestations: { url: 'x' } } } });
  await assert.rejects(releaseNpm(directory, { fetcher: fake.fetcher, run: fake.run, readFile: files(), ...fast }), /different bytes: @atriarch-systems\/tracery-react@0\.1\.3/);
  assert.equal(fake.commands.length, 0);
});

test('a registry lookup failure stops before any publish', async () => {
  const fake = registry();
  await assert.rejects(planPublish(packages, async () => json(503, {})), /Registry lookup failed: 503/);
  assert.equal(fake.commands.length, 0);
});

test('a failed npm publish fails the release', async () => {
  const fake = registry();
  await assert.rejects(releaseNpm(directory, { fetcher: fake.fetcher, run: () => ({ status: 1 }), readFile: files(), ...fast }), /Publish failed: @atriarch-systems\/tracery-core@0\.1\.3/);
});

test('a version published by this run without a provenance attestation fails the release', async () => {
  const fake = registry({ attest: false });
  await assert.rejects(releaseNpm(directory, { fetcher: fake.fetcher, run: fake.run, readFile: files(), ...fast }), /No provenance attestation on the registry for @atriarch-systems\/tracery-core@0\.1\.3/);
  await assert.rejects(requireProvenance(packages[0], { fetcher: async () => json(200, { dist: { integrity: packages[0].integrity } }), attempts: 2, delayMs: 0, sleep: async () => {} }), /No provenance/);
  // An identical package that was already published without provenance is skipped, not failed.
  const old = registry({ published: { [packages[1].name]: { integrity: packages[1].integrity } } });
  const result = await releaseNpm(directory, { fetcher: old.fetcher, run: old.run, readFile: files(), ...fast });
  assert.deepEqual(result.skipped, [`${packages[1].name}@0.1.3`]);
  // Without --provenance the attestation is not required.
  const plain = registry({ attest: false });
  await releaseNpm(directory, { provenance: false, fetcher: plain.fetcher, run: plain.run, readFile: files(), ...fast });
  assert.ok(plain.commands.every(command => !command.includes('--provenance')));
});
