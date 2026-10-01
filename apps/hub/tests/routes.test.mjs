import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVITY_CONTRACT_VERSION } from '@atriarch-systems/tracery-core/contract';
import { sampleTraceEvents, sampleFlowIds } from '@atriarch-systems/tracery-core/fixtures';
import { createTestServer, bearer, makeUiDir } from './route-helpers.mjs';

const KEYS = [
  { id: 'full', key: 'key-full', workspace: 'default', roles: ['ingest', 'read', 'admin'] },
  { id: 'readonly', key: 'key-read', workspace: 'default', roles: ['read'] },
  { id: 'other-ws', key: 'key-other', workspace: 'other', roles: ['ingest', 'read', 'admin'] },
  { id: 'operator', key: 'key-op', workspace: '*', roles: ['ingest', 'read', 'admin'] },
];

function batchOf(events, workspace) {
  return { v: ACTIVITY_CONTRACT_VERSION, ...(workspace ? { workspace } : {}), events };
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

// ---------------------------------------------------------------------------
// auth matrix
// ---------------------------------------------------------------------------

test('auth: missing key is rejected', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    const res = await created.app.inject({ method: 'GET', url: '/v1/flows' });
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error.code, 'unauthorized');
    assert.ok(res.headers['x-request-id']);
  } finally {
    await created.close();
  }
});

test('auth: wrong key is rejected', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    const res = await created.app.inject({ method: 'GET', url: '/v1/flows', headers: bearer('not-a-real-key') });
    assert.equal(res.statusCode, 401);
  } finally {
    await created.close();
  }
});

test('auth: a read-only key may not ingest', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    const res = await created.app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: bearer('key-read'),
      payload: batchOf([oneEvent()]),
    });
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error.code, 'forbidden');
  } finally {
    await created.close();
  }
});

test('auth: workspace isolation -- a key bound to one workspace cannot read another, even by naming it', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    await created.app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: bearer('key-full'),
      payload: batchOf([oneEvent({ id: 'default-e1' })]),
    });
    await created.app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: bearer('key-other'),
      payload: batchOf([oneEvent({ id: 'other-e1' })]),
    });

    const own = await created.app.inject({ method: 'GET', url: '/v1/flows', headers: bearer('key-full') });
    assert.equal(JSON.parse(own.body).flows.length, 1);

    const forbidden = await created.app.inject({
      method: 'GET',
      url: '/v1/flows?workspace=other',
      headers: bearer('key-full'),
    });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(JSON.parse(forbidden.body).error.code, 'workspace_forbidden');
  } finally {
    await created.close();
  }
});

test('auth: an explicitly empty TRACERY_API_KEYS (apiKeys: []) refuses to boot into an accidental all-roles dev key (hub-15)', async () => {
  await assert.rejects(() => createTestServer({ apiKeys: [] }), /TRACERY_API_KEYS is explicitly empty/);
});

test('auth: the operator key must be given an explicit workspace, then may act on it', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    const noWorkspace = await created.app.inject({ method: 'GET', url: '/v1/flows', headers: bearer('key-op') });
    assert.equal(noWorkspace.statusCode, 400);
    assert.equal(JSON.parse(noWorkspace.body).error.code, 'workspace_required');

    const withWorkspace = await created.app.inject({
      method: 'GET',
      url: '/v1/flows?workspace=default',
      headers: bearer('key-op'),
    });
    assert.equal(withWorkspace.statusCode, 200);
  } finally {
    await created.close();
  }
});

// ---------------------------------------------------------------------------
// ingest
// ---------------------------------------------------------------------------

test('ingest: a fully valid batch is accepted with a 200 and an advancing cursor', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    const res = await created.app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: bearer('key-full'),
      payload: batchOf([oneEvent({ id: 'v1' }), oneEvent({ id: 'v2', op: 'o1', type: 'end', status: 'success' })]),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.accepted, 2);
    assert.equal(body.duplicates, 0);
    assert.deepEqual(body.rejected, []);
    assert.equal(body.cursor, 2);
  } finally {
    await created.close();
  }
});

test('ingest: a partially-invalid batch 207s with a precise rejected[] and still accepts the valid events', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    const res = await created.app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: bearer('key-full'),
      payload: batchOf([oneEvent({ id: 'ok1' }), { id: 'missing-fields' }]),
    });
    assert.equal(res.statusCode, 207);
    const body = JSON.parse(res.body);
    assert.equal(body.accepted, 1);
    assert.equal(body.rejected.length, 1);
    assert.equal(body.rejected[0].index, 1);
    assert.ok(body.rejected[0].reason.length > 0);
  } finally {
    await created.close();
  }
});

test('ingest: duplicates are counted, not re-accepted', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    const payload = batchOf([oneEvent({ id: 'dup1' })]);
    const first = await created.app.inject({ method: 'POST', url: '/v1/events', headers: bearer('key-full'), payload });
    assert.equal(JSON.parse(first.body).accepted, 1);

    const second = await created.app.inject({ method: 'POST', url: '/v1/events', headers: bearer('key-full'), payload });
    const body = JSON.parse(second.body);
    assert.equal(body.accepted, 0);
    assert.equal(body.duplicates, 1);
  } finally {
    await created.close();
  }
});

test('ingest: an oversized event is rejected per-event (207) with a maxEventBytes reason', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    const huge = { note: 'x'.repeat(70 * 1024) };
    const res = await created.app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: bearer('key-full'),
      payload: batchOf([oneEvent({ id: 'huge', context: huge })]),
    });
    assert.equal(res.statusCode, 207);
    const body = JSON.parse(res.body);
    assert.equal(body.accepted, 0);
    assert.equal(body.rejected.length, 1);
    assert.match(body.rejected[0].reason, /maxEventBytes/);
  } finally {
    await created.close();
  }
});

test('ingest: a malformed workspace field is rejected outright, not silently replaced by the key\'s workspace (hub-21)', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    const empty = await created.app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: bearer('key-full'),
      payload: { v: ACTIVITY_CONTRACT_VERSION, workspace: '', events: [oneEvent()] },
    });
    assert.equal(empty.statusCode, 400);
    assert.equal(JSON.parse(empty.body).error.code, 'invalid_batch');

    const wrongType = await created.app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: bearer('key-full'),
      payload: { v: ACTIVITY_CONTRACT_VERSION, workspace: 42, events: [oneEvent()] },
    });
    assert.equal(wrongType.statusCode, 400);
    assert.equal(JSON.parse(wrongType.body).error.code, 'invalid_batch');
  } finally {
    await created.close();
  }
});

test('ingest: malformed JSON is rejected with 400 invalid_json, not 500 (hub-4)', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    const res = await created.app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { ...bearer('key-full'), 'content-type': 'application/json' },
      payload: '{not valid json',
    });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error.code, 'invalid_json');
  } finally {
    await created.close();
  }
});

test('ingest: a body over the configured limit is rejected 413 body_too_large, not 500 (hub-4)', async () => {
  const created = await createTestServer({ apiKeys: KEYS, bodyLimitBytes: 200 });
  try {
    const res = await created.app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { ...bearer('key-full'), 'content-type': 'application/json' },
      payload: batchOf([oneEvent({ context: { note: 'x'.repeat(1000) } })]),
    });
    assert.equal(res.statusCode, 413);
    assert.equal(JSON.parse(res.body).error.code, 'body_too_large');
  } finally {
    await created.close();
  }
});

test('ingest: a spec-legal near-max batch is never rejected by the body size limit (hub-4)', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    // 500 events x ~1KB context each: well within maxEventsPerBatch (1000) and
    // maxEventBytes (64KB) per event, but comfortably over Fastify's old 1 MiB default.
    const events = Array.from({ length: 500 }, (_, i) => oneEvent({ id: `big-${i}`, context: { note: 'x'.repeat(1000) } }));
    const res = await created.app.inject({ method: 'POST', url: '/v1/events', headers: bearer('key-full'), payload: batchOf(events) });
    assert.equal(res.statusCode, 200, `expected the batch to be accepted, got ${res.statusCode}: ${res.body}`);
    assert.equal(JSON.parse(res.body).accepted, 500);
  } finally {
    await created.close();
  }
});

test('ingest: a batch over 1000 events is rejected outright with 400', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    const events = Array.from({ length: 1001 }, (_, i) => oneEvent({ id: `bulk-${i}` }));
    const res = await created.app.inject({ method: 'POST', url: '/v1/events', headers: bearer('key-full'), payload: batchOf(events) });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error.code, 'batch_too_large');
  } finally {
    await created.close();
  }
});

// ---------------------------------------------------------------------------
// list / paging, flows, traces -- via core's fixture trace
// ---------------------------------------------------------------------------

async function seedFixtureTrace(app) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/events',
    headers: bearer('key-full'),
    payload: batchOf(sampleTraceEvents),
  });
  assert.equal(res.statusCode, 200, `seed failed: ${res.body}`);
}

test('flows: list/paging and GET /v1/flows/:id against the fixture trace', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    await seedFixtureTrace(created.app);

    const list = await created.app.inject({ method: 'GET', url: '/v1/flows?limit=2', headers: bearer('key-full') });
    assert.equal(list.statusCode, 200);
    const listBody = JSON.parse(list.body);
    assert.equal(listBody.flows.length, 2);
    assert.ok(listBody.nextBefore);

    const full = await created.app.inject({ method: 'GET', url: '/v1/flows', headers: bearer('key-full') });
    assert.equal(JSON.parse(full.body).flows.length, 3);

    const one = await created.app.inject({
      method: 'GET',
      url: `/v1/flows/${encodeURIComponent(sampleFlowIds.research2)}`,
      headers: bearer('key-full'),
    });
    assert.equal(one.statusCode, 200);
    const flow = JSON.parse(one.body);
    assert.equal(flow.id, sampleFlowIds.research2);
    assert.equal(flow.status, 'error');

    const missing = await created.app.inject({ method: 'GET', url: '/v1/flows/no-such-flow', headers: bearer('key-full') });
    assert.equal(missing.statusCode, 404);
  } finally {
    await created.close();
  }
});

test('flows: a garbage after/before/limit query param 400s instead of silently returning an empty page (hub-5)', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    await seedFixtureTrace(created.app);

    const badAfter = await created.app.inject({
      method: 'GET',
      url: `/v1/flows/${encodeURIComponent(sampleFlowIds.parent)}/events?after=abc`,
      headers: bearer('key-full'),
    });
    assert.equal(badAfter.statusCode, 400);
    assert.equal(JSON.parse(badAfter.body).error.code, 'invalid_query');

    const badBefore = await created.app.inject({ method: 'GET', url: '/v1/flows?before=abc', headers: bearer('key-full') });
    assert.equal(badBefore.statusCode, 400);
    assert.equal(JSON.parse(badBefore.body).error.code, 'invalid_query');

    const badLimit = await created.app.inject({ method: 'GET', url: '/v1/flows?limit=-3', headers: bearer('key-full') });
    assert.equal(badLimit.statusCode, 400);
    assert.equal(JSON.parse(badLimit.body).error.code, 'invalid_query');

    const overMaxLimit = await created.app.inject({ method: 'GET', url: '/v1/flows?limit=1001', headers: bearer('key-full') });
    assert.equal(overMaxLimit.statusCode, 400);
  } finally {
    await created.close();
  }
});

test('flows: GET /v1/flows/:id/events supports an incremental after=', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    await seedFixtureTrace(created.app);

    const snapshot = await created.app.inject({
      method: 'GET',
      url: `/v1/flows/${encodeURIComponent(sampleFlowIds.parent)}/events`,
      headers: bearer('key-full'),
    });
    const snapBody = JSON.parse(snapshot.body);
    assert.equal(snapBody.type, 'snapshot');
    assert.ok(snapBody.events.length > 0);

    const midCursor = snapBody.events[Math.floor(snapBody.events.length / 2)].cursor;
    const delta = await created.app.inject({
      method: 'GET',
      url: `/v1/flows/${encodeURIComponent(sampleFlowIds.parent)}/events?after=${midCursor}`,
      headers: bearer('key-full'),
    });
    const deltaBody = JSON.parse(delta.body);
    assert.equal(deltaBody.type, 'events');
    assert.ok(deltaBody.events.every((e) => e.cursor > midCursor));
  } finally {
    await created.close();
  }
});

test('traces: GET /v1/traces/:id has all three fixture flows; GET /v1/traces/:id/events has every event', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    await seedFixtureTrace(created.app);

    const trace = await created.app.inject({
      method: 'GET',
      url: `/v1/traces/${encodeURIComponent(sampleFlowIds.parent)}`,
      headers: bearer('key-full'),
    });
    assert.equal(trace.statusCode, 200);
    const traceBody = JSON.parse(trace.body);
    assert.equal(traceBody.flows.length, 3);
    assert.deepEqual(
      traceBody.flows.map((f) => f.id).sort(),
      [sampleFlowIds.parent, sampleFlowIds.research1, sampleFlowIds.research2].sort(),
    );

    const events = await created.app.inject({
      method: 'GET',
      url: `/v1/traces/${encodeURIComponent(sampleFlowIds.parent)}/events`,
      headers: bearer('key-full'),
    });
    assert.equal(JSON.parse(events.body).length, sampleTraceEvents.length);
  } finally {
    await created.close();
  }
});

test('flows: DELETE /v1/flows/:id requires admin and is idempotent-404 the second time', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    await seedFixtureTrace(created.app);

    const forbidden = await created.app.inject({
      method: 'DELETE',
      url: `/v1/flows/${encodeURIComponent(sampleFlowIds.research1)}`,
      headers: bearer('key-read'),
    });
    assert.equal(forbidden.statusCode, 403);

    const first = await created.app.inject({
      method: 'DELETE',
      url: `/v1/flows/${encodeURIComponent(sampleFlowIds.research1)}`,
      headers: bearer('key-full'),
    });
    assert.equal(first.statusCode, 204);

    const second = await created.app.inject({
      method: 'DELETE',
      url: `/v1/flows/${encodeURIComponent(sampleFlowIds.research1)}`,
      headers: bearer('key-full'),
    });
    assert.equal(second.statusCode, 404);
  } finally {
    await created.close();
  }
});

// ---------------------------------------------------------------------------
// health / ready / metrics / openapi / ui
// ---------------------------------------------------------------------------

test('health: /healthz and /readyz need no auth', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    const live = await created.app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(live.statusCode, 200);
    assert.equal(JSON.parse(live.body).status, 'ok');

    const ready = await created.app.inject({ method: 'GET', url: '/readyz' });
    assert.equal(ready.statusCode, 200);
  } finally {
    await created.close();
  }
});

// Funding: apps/hub/README.md "Headers" -- a friendly tip-jar link, community edition only.
test('headers: x-ko-fi is set on every response with no extensions (community edition), and omitted once "licensed"', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    const res = await created.app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(res.headers['x-ko-fi'], 'https://ko-fi.com/demonslyr');
  } finally {
    await created.close();
  }

  const licensed = await createTestServer({ apiKeys: KEYS, extensions: { isLicensed: () => true } });
  try {
    const res = await licensed.app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(res.headers['x-ko-fi'], undefined);
  } finally {
    await licensed.close();
  }
});

test('metrics: text exposition carries every documented metric name and reflects ingest activity', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    await seedFixtureTrace(created.app);

    const res = await created.app.inject({ method: 'GET', url: '/metrics' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/plain/);
    for (const name of [
      'tracery_events_ingested_total',
      'tracery_events_rejected_total',
      'tracery_events_duplicate_total',
      'tracery_flows_total',
      'tracery_store_events',
      'tracery_ws_clients',
      'tracery_sweeps_total',
      'tracery_swept_flows_total',
    ]) {
      assert.match(res.body, new RegExp(`^${name} `, 'm'), `missing metric ${name}`);
    }
    assert.match(res.body, new RegExp(`tracery_events_ingested_total ${sampleTraceEvents.length}`));
  } finally {
    await created.close();
  }
});

test('metrics: a configured TRACERY_METRICS_TOKEN is required', async () => {
  const created = await createTestServer({ apiKeys: KEYS, metricsToken: 'secret-token' });
  try {
    const denied = await created.app.inject({ method: 'GET', url: '/metrics' });
    assert.equal(denied.statusCode, 401);

    const allowed = await created.app.inject({ method: 'GET', url: '/metrics?token=secret-token' });
    assert.equal(allowed.statusCode, 200);
  } finally {
    await created.close();
  }
});

test('metrics: a token of a different length than the configured one is rejected cleanly, not thrown on (hub-14)', async () => {
  // Regression for the constant-time comparison: it hashes both sides to a fixed
  // length first specifically so a length mismatch between the presented and
  // configured token can never throw out of `crypto.timingSafeEqual`.
  const created = await createTestServer({ apiKeys: KEYS, metricsToken: 'secret-token' });
  try {
    const shorter = await created.app.inject({ method: 'GET', url: '/metrics?token=short' });
    assert.equal(shorter.statusCode, 401);

    const longer = await created.app.inject({ method: 'GET', url: `/metrics?token=${'x'.repeat(500)}` });
    assert.equal(longer.statusCode, 401);
  } finally {
    await created.close();
  }
});

test('ui: without a build, /ui serves a plain placeholder page; with one, it serves the SPA and falls back to index.html for deep links', async () => {
  const notBuilt = await createTestServer({ apiKeys: KEYS });
  try {
    const res = await notBuilt.app.inject({ method: 'GET', url: '/ui/' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /not built/);
  } finally {
    await notBuilt.close();
  }

  const uiDir = makeUiDir();
  const built = await createTestServer({ apiKeys: KEYS, uiDir });
  try {
    const index = await built.app.inject({ method: 'GET', url: '/ui/' });
    assert.equal(index.statusCode, 200);
    assert.match(index.body, /ui-shell/);

    const deepLink = await built.app.inject({ method: 'GET', url: `/ui/flows/${encodeURIComponent(sampleFlowIds.parent)}` });
    assert.equal(deepLink.statusCode, 200);
    assert.match(deepLink.body, /ui-shell/); // SPA fallback to index.html

    const asset = await built.app.inject({ method: 'GET', url: '/ui/app.js' });
    assert.equal(asset.statusCode, 200);
    assert.match(asset.body, /console\.log/);

    const notFound = await built.app.inject({ method: 'GET', url: '/no-such-route' });
    assert.equal(notFound.statusCode, 404);
    assert.equal(JSON.parse(notFound.body).error.code, 'not_found');
  } finally {
    await built.close();
  }
});

test('cors: a browser preflight for a cross-origin POST /v1/events succeeds and reflects the caller\'s origin', async () => {
  const created = await createTestServer({ apiKeys: KEYS, allowedOrigins: ['http://localhost:5173'] });
  try {
    const res = await created.app.inject({
      method: 'OPTIONS',
      url: '/v1/events',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,authorization',
      },
    });
    // A third-party browser app (the whole point of "library or hub, your
    // choice") runs on a different origin than the hub it pushes events to.
    // Community auth is a bearer token the caller sets explicitly, never an
    // ambient cookie, so reflecting the origin carries no CSRF risk -- but
    // with no CORS plugin registered at all, the browser's own preflight
    // fails before the real request is ever sent, which is invisible from
    // any server-side or Node-script test (fetch from Node has no CORS).
    assert.equal(res.statusCode, 204);
    assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:5173');
    assert.match(res.headers['access-control-allow-methods'] ?? '', /POST/);
    assert.match(res.headers['access-control-allow-headers'] ?? '', /authorization/);
  } finally {
    await created.close();
  }
});
