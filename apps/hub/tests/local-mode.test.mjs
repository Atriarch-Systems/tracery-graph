// "Local mode" (task: `npx @atriarch-systems/tracery-hub` with no env): authMode
// 'none' treats every request as a full-access principal on the single
// "default" workspace, with no key ever checked. Covers every HTTP route,
// the single-workspace rejection, GET /v1/info in both auth modes and both
// editions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVITY_CONTRACT_VERSION } from '@atriarch-systems/tracery-core/contract';
import { sampleTraceEvents, sampleFlowIds } from '@atriarch-systems/tracery-core/fixtures';
import { createTestServer } from './route-helpers.mjs';

/** authMode 'none': no `apiKeys` configured at all -- see `route-helpers.mjs`'s `testConfig`. */
function createLocalServer(overrides = {}) {
  return createTestServer({ apiKeys: undefined, authMode: 'none', ...overrides });
}

function oneEvent(overrides = {}) {
  return {
    v: ACTIVITY_CONTRACT_VERSION,
    id: 'e1',
    ts: 1000,
    flow: 'f1',
    op: 'o1',
    node: 'n1',
    type: 'start',
    name: 'x',
    root: true,
    ...overrides,
  };
}

function batchOf(events, workspace) {
  return { v: ACTIVITY_CONTRACT_VERSION, ...(workspace ? { workspace } : {}), events };
}

test('local mode: POST /v1/events with no Authorization header at all is accepted', async () => {
  const created = await createLocalServer();
  try {
    const res = await created.app.inject({ method: 'POST', url: '/v1/events', payload: batchOf([oneEvent()]) });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(JSON.parse(res.body).accepted, 1);
  } finally {
    await created.close();
  }
});

test('local mode: every read/admin route works with no key, on the implicit "default" workspace', async () => {
  const created = await createLocalServer();
  try {
    const seed = await created.app.inject({ method: 'POST', url: '/v1/events', payload: batchOf(sampleTraceEvents) });
    assert.equal(seed.statusCode, 200, seed.body);

    const list = await created.app.inject({ method: 'GET', url: '/v1/flows' });
    assert.equal(list.statusCode, 200);
    assert.equal(JSON.parse(list.body).flows.length, 3);

    const one = await created.app.inject({ method: 'GET', url: `/v1/flows/${encodeURIComponent(sampleFlowIds.research2)}` });
    assert.equal(one.statusCode, 200);

    const events = await created.app.inject({ method: 'GET', url: `/v1/flows/${encodeURIComponent(sampleFlowIds.parent)}/events` });
    assert.equal(events.statusCode, 200);

    const trace = await created.app.inject({ method: 'GET', url: `/v1/traces/${encodeURIComponent(sampleFlowIds.parent)}` });
    assert.equal(trace.statusCode, 200);
    assert.equal(JSON.parse(trace.body).flows.length, 3);

    const traceEvents = await created.app.inject({ method: 'GET', url: `/v1/traces/${encodeURIComponent(sampleFlowIds.parent)}/events` });
    assert.equal(traceEvents.statusCode, 200);

    const workspaces = await created.app.inject({ method: 'GET', url: '/v1/workspaces' });
    assert.equal(workspaces.statusCode, 200);
    const wsBody = JSON.parse(workspaces.body);
    assert.deepEqual(
      wsBody.workspaces.map((w) => w.workspace),
      ['default'],
    );

    const deleted = await created.app.inject({ method: 'DELETE', url: `/v1/flows/${encodeURIComponent(sampleFlowIds.research1)}` });
    assert.equal(deleted.statusCode, 204);

    const notFound = await created.app.inject({ method: 'GET', url: '/v1/flows/no-such-flow' });
    assert.equal(notFound.statusCode, 404);
  } finally {
    await created.close();
  }
});

test('local mode: naming any workspace other than "default" is rejected with 400, not silently redirected', async () => {
  const created = await createLocalServer();
  try {
    const listOther = await created.app.inject({ method: 'GET', url: '/v1/flows?workspace=other' });
    assert.equal(listOther.statusCode, 400);
    assert.equal(JSON.parse(listOther.body).error.code, 'workspace_not_local');

    const ingestOther = await created.app.inject({ method: 'POST', url: '/v1/events', payload: batchOf([oneEvent()], 'other') });
    assert.equal(ingestOther.statusCode, 400);
    assert.equal(JSON.parse(ingestOther.body).error.code, 'workspace_not_local');

    // Naming "default" explicitly is fine -- it's the only workspace this mode serves.
    const listDefault = await created.app.inject({ method: 'GET', url: '/v1/flows?workspace=default' });
    assert.equal(listDefault.statusCode, 200);
  } finally {
    await created.close();
  }
});

test('local mode: no x-request-id or /healthz behavior regression -- unauthenticated routes are unaffected', async () => {
  const created = await createLocalServer();
  try {
    const health = await created.app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(health.statusCode, 200);
    assert.ok(health.headers['x-request-id']);
  } finally {
    await created.close();
  }
});

// ---------------------------------------------------------------------------
// GET /v1/info
// ---------------------------------------------------------------------------

test('GET /v1/info: authMode "none" reports auth: "none" and workspace: "default", no auth required', async () => {
  const created = await createLocalServer();
  try {
    const res = await created.app.inject({ method: 'GET', url: '/v1/info' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.product, 'tracery');
    assert.equal(typeof body.version, 'string');
    assert.ok(body.version.length > 0);
    assert.equal(body.auth, 'none');
    assert.equal(body.workspace, 'default');
    assert.equal(body.edition, 'community');
  } finally {
    await created.close();
  }
});

test('GET /v1/info: authMode "keys" reports auth: "keys" and no workspace field, no auth required', async () => {
  const KEYS = [{ id: 'full', key: 'key-full', workspace: 'default', roles: ['ingest', 'read', 'admin'] }];
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    const res = await created.app.inject({ method: 'GET', url: '/v1/info' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.auth, 'keys');
    assert.equal('workspace' in body, false, `expected no "workspace" field in keys mode, got ${JSON.stringify(body)}`);
  } finally {
    await created.close();
  }
});

test('GET /v1/info: edition reflects extensions.isLicensed(), in both auth modes', async () => {
  const unlicensedLocal = await createLocalServer();
  try {
    const res = await unlicensedLocal.app.inject({ method: 'GET', url: '/v1/info' });
    assert.equal(JSON.parse(res.body).edition, 'community');
  } finally {
    await unlicensedLocal.close();
  }

  const licensedLocal = await createLocalServer({ extensions: { isLicensed: () => true } });
  try {
    const res = await licensedLocal.app.inject({ method: 'GET', url: '/v1/info' });
    assert.equal(JSON.parse(res.body).edition, 'licensed');
  } finally {
    await licensedLocal.close();
  }

  const KEYS = [{ id: 'full', key: 'key-full', workspace: 'default', roles: ['ingest', 'read', 'admin'] }];
  const licensedKeys = await createTestServer({ apiKeys: KEYS, extensions: { isLicensed: () => true } });
  try {
    const res = await licensedKeys.app.inject({ method: 'GET', url: '/v1/info' });
    const body = JSON.parse(res.body);
    assert.equal(body.edition, 'licensed');
    assert.equal(body.auth, 'keys');
  } finally {
    await licensedKeys.close();
  }
});
