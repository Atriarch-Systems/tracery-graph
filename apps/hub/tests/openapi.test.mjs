// The OpenAPI document is generated at build time from the route schemas
// (scripts/generate-openapi.mjs, @fastify/swagger as a devDependency) and
// committed as apps/hub/openapi.json. The running hub only serves that file,
// and only when TRACERY_OPENAPI=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../dist/config.js';
import { generateOpenApi, openApiPath } from '../scripts/generate-openapi.mjs';
import { createTestServer } from './route-helpers.mjs';

const KEYS = [{ id: 'admin', key: 'k-admin', workspace: '*', roles: ['ingest', 'read', 'admin'] }];
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const committed = () => fs.readFileSync(openApiPath, 'utf8').replace(/\r\n/g, '\n');

test('openapi: the committed document matches the route schemas (run `npm run openapi` to refresh)', async () => {
  assert.equal(committed(), await generateOpenApi());
});

test('openapi: the document covers every public route', () => {
  const doc = JSON.parse(committed());
  assert.equal(doc.openapi, '3.1.0');
  assert.equal(doc.info.version, JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version);
  const paths = Object.keys(doc.paths);
  for (const expected of ['/v1/info', '/v1/events', '/v1/flows', '/v1/flows/{id}', '/v1/flows/{id}/events', '/v1/traces/{id}',
    '/v1/traces/{id}/events', '/v1/workspaces', '/healthz', '/readyz', '/metrics']) {
    assert.ok(paths.includes(expected), `openapi document missing path ${expected}; had ${paths.join(', ')}`);
  }
  assert.ok(!paths.includes('/v1/openapi.json'), 'the document must not describe its own route');
});

test('openapi: off by default, /v1/openapi.json is not served', async () => {
  for (const overrides of [{ apiKeys: KEYS }, { apiKeys: undefined, authMode: 'none' }]) {
    const created = await createTestServer(overrides);
    try {
      const res = await created.app.inject({ method: 'GET', url: '/v1/openapi.json' });
      assert.equal(res.statusCode, 404);
    } finally {
      await created.close();
    }
  }
});

test('openapi: TRACERY_OPENAPI=1 serves the shipped document without auth', async () => {
  const created = await createTestServer({ apiKeys: KEYS, openapi: true });
  try {
    const res = await created.app.inject({ method: 'GET', url: '/v1/openapi.json' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /^application\/json/);
    assert.equal(res.body.replace(/\r\n/g, '\n'), committed());
  } finally {
    await created.close();
  }
});

test('openapi: TRACERY_OPENAPI parsing', () => {
  const env = { TRACERY_HOST: '127.0.0.1' };
  assert.equal(loadConfig(env).openapi, false);
  assert.equal(loadConfig({ ...env, TRACERY_OPENAPI: '' }).openapi, false);
  assert.equal(loadConfig({ ...env, TRACERY_OPENAPI: '0' }).openapi, false);
  assert.equal(loadConfig({ ...env, TRACERY_OPENAPI: '1' }).openapi, true);
  assert.equal(loadConfig({ ...env, TRACERY_OPENAPI: 'true' }).openapi, true);
  assert.throws(() => loadConfig({ ...env, TRACERY_OPENAPI: 'yes' }), /TRACERY_OPENAPI must be 1 or 0/);
});

test('openapi: the swagger plugin stays a build-time devDependency', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies['@fastify/swagger'], undefined);
  assert.ok(pkg.devDependencies['@fastify/swagger']);
  assert.ok(pkg.files.includes('openapi.json'));
  const sources = fs.readdirSync(path.join(packageRoot, 'dist'), { recursive: true }).filter(file => String(file).endsWith('.js'));
  for (const file of sources) {
    assert.ok(!fs.readFileSync(path.join(packageRoot, 'dist', String(file)), 'utf8').includes('@fastify/swagger'), `dist/${file} imports @fastify/swagger`);
  }
});
