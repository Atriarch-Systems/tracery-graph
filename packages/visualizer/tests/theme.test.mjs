import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, emptyGraph } from '../dist/model.js';
import { drawNode, drawLink } from '../dist/drawing.js';
import { drawGroupHull } from '../dist/groups.js';
import { DEFAULT_GRAPH_THEME, resolveGraphTheme } from '../dist/theme.js';

// Animation comparisons must render the same instant, including elapsed-time fades.
test.beforeEach((t) => t.mock.method(Date, 'now', () => 1_700_000_000_000));

const fakeCtx = () => {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (_target, key) => key === 'measureText' ? value => ({ width: value.length * 6 })
      : (...args) => calls.push([key, ...args]),
    set: (_target, key, value) => { calls.push([key, value]); return true; },
  });
  return { ctx, calls };
};

const fillStyles = calls => calls.filter(c => c[0] === 'fillStyle').map(c => c[1]);
const strokeStyles = calls => calls.filter(c => c[0] === 'strokeStyle').map(c => c[1]);
const shadowColors = calls => calls.filter(c => c[0] === 'shadowColor').map(c => c[1]);

const nodeOf = (spec = {}) => reconcile(emptyGraph(),
  [{ id: 'n', label: 'Node', position: { x: 0, y: 0, anchored: true }, ...spec }], []).nodes[0];

const linkOf = (spec = {}) => {
  const graph = reconcile(emptyGraph(), [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    [{ id: 'e', source: 'a', target: 'b', ...spec }]);
  graph.links[0].source = graph.nodes[0];
  graph.links[0].target = graph.nodes[1];
  return graph.links[0];
};

// --- "no regression when theme is omitted" proof --------------------------
// drawNode/drawLink default their theme parameter to DEFAULT_GRAPH_THEME, so
// calling with no theme argument at all must be byte-for-byte identical to
// calling with DEFAULT_GRAPH_THEME passed explicitly -- proving the resolved
// default theme is exactly what was hardcoded before this contract existed
// (see the report's literal-by-literal audit for the other half of that proof).
test('omitting theme entirely reproduces the exact same drawNode calls as passing DEFAULT_GRAPH_THEME explicitly', () => {
  const idle = nodeOf();
  const { ctx: implicitCtx, calls: implicitCalls } = fakeCtx();
  drawNode(idle, implicitCtx, null, true, 1);
  const { ctx: explicitCtx, calls: explicitCalls } = fakeCtx();
  drawNode(idle, explicitCtx, null, true, 1, DEFAULT_GRAPH_THEME);
  assert.deepEqual(implicitCalls, explicitCalls);

  const active = nodeOf({ status: 'running', activity: { highlighted: true } });
  const { ctx: implicitActiveCtx, calls: implicitActiveCalls } = fakeCtx();
  drawNode(active, implicitActiveCtx, 'n', false, 1);
  const { ctx: explicitActiveCtx, calls: explicitActiveCalls } = fakeCtx();
  drawNode(active, explicitActiveCtx, 'n', false, 1, DEFAULT_GRAPH_THEME);
  assert.deepEqual(implicitActiveCalls, explicitActiveCalls);
});

test('omitting theme entirely reproduces the exact same drawLink calls as passing DEFAULT_GRAPH_THEME explicitly', () => {
  const link = linkOf({ showLabel: true, activity: { highlighted: true, updatedAt: Date.now() } });
  const { ctx: implicitCtx, calls: implicitCalls } = fakeCtx();
  drawLink(link, implicitCtx, null, false);
  const { ctx: explicitCtx, calls: explicitCalls } = fakeCtx();
  drawLink(link, explicitCtx, null, false, DEFAULT_GRAPH_THEME);
  assert.deepEqual(implicitCalls, explicitCalls);
});

test('omitting theme entirely reproduces the exact same drawGroupHull calls as passing DEFAULT_GRAPH_THEME explicitly', () => {
  const nodes = reconcile(emptyGraph(), [{ id: 'a', label: 'A', group: 'g', position: { x: 0, y: 0, anchored: true } }], []).nodes;
  const group = { id: 'g', label: 'G' };
  const { ctx: implicitCtx, calls: implicitCalls } = fakeCtx();
  drawGroupHull(implicitCtx, group, nodes);
  const { ctx: explicitCtx, calls: explicitCalls } = fakeCtx();
  drawGroupHull(explicitCtx, group, nodes, DEFAULT_GRAPH_THEME);
  assert.deepEqual(implicitCalls, explicitCalls);
});

// --- per-slot: a custom theme value changes the corresponding draw call ---

test('theme.nodeAccentIdle changes the idle accent bar/detail fillStyle', () => {
  const node = nodeOf();
  const { ctx: defaultCtx, calls: defaultCalls } = fakeCtx();
  drawNode(node, defaultCtx, null, true, 1);
  const { ctx: customCtx, calls: customCalls } = fakeCtx();
  drawNode(node, customCtx, null, true, 1, resolveGraphTheme({ nodeAccentIdle: '#123456' }));
  assert.notDeepEqual(fillStyles(customCalls), fillStyles(defaultCalls));
});

test('theme.nodeAccentFallback changes the highlighted accent bar/detail fillStyle when no presentation.accent is set', () => {
  const node = nodeOf({ activity: { highlighted: true } });
  const { ctx: defaultCtx, calls: defaultCalls } = fakeCtx();
  drawNode(node, defaultCtx, null, true, 1);
  const { ctx: customCtx, calls: customCalls } = fakeCtx();
  drawNode(node, customCtx, null, true, 1, resolveGraphTheme({ nodeAccentFallback: '#123456' }));
  assert.notDeepEqual(fillStyles(customCalls), fillStyles(defaultCalls));
});

test("a node's own presentation.accent still wins over theme.nodeAccentFallback", () => {
  const node = nodeOf({ activity: { highlighted: true }, presentation: { accent: '#00ff00' } });
  const { ctx: defaultCtx, calls: defaultCalls } = fakeCtx();
  drawNode(node, defaultCtx, null, true, 1);
  const { ctx: customCtx, calls: customCalls } = fakeCtx();
  drawNode(node, customCtx, null, true, 1, resolveGraphTheme({ nodeAccentFallback: '#123456' }));
  // Changing only the fallback must have no effect once the node supplies its own accent.
  assert.deepEqual(fillStyles(customCalls), fillStyles(defaultCalls));
});

test('theme.nodeFillIdle changes the idle card fill', () => {
  const node = nodeOf();
  const { calls: defaultCalls } = (() => { const c = fakeCtx(); drawNode(node, c.ctx, null, true, 1); return c; })();
  const { calls: customCalls } = (() => { const c = fakeCtx(); drawNode(node, c.ctx, null, true, 1, resolveGraphTheme({ nodeFillIdle: '#123456' })); return c; })();
  assert.notDeepEqual(fillStyles(customCalls), fillStyles(defaultCalls));
});

test('theme.nodeFillActive changes the fully-highlighted card fill', () => {
  const node = nodeOf({ activity: { highlighted: true } });
  const { calls: defaultCalls } = (() => { const c = fakeCtx(); drawNode(node, c.ctx, null, true, 1); return c; })();
  const { calls: customCalls } = (() => { const c = fakeCtx(); drawNode(node, c.ctx, null, true, 1, resolveGraphTheme({ nodeFillActive: '#123456' })); return c; })();
  assert.notDeepEqual(fillStyles(customCalls), fillStyles(defaultCalls));
});

test('theme.nodeBorderIdle changes the idle card border', () => {
  const node = nodeOf();
  const { calls: defaultCalls } = (() => { const c = fakeCtx(); drawNode(node, c.ctx, null, true, 1); return c; })();
  const { calls: customCalls } = (() => { const c = fakeCtx(); drawNode(node, c.ctx, null, true, 1, resolveGraphTheme({ nodeBorderIdle: '#123456' })); return c; })();
  assert.notDeepEqual(strokeStyles(customCalls), strokeStyles(defaultCalls));
});

test('theme.nodeBorderActive changes the fully-highlighted (not selected, not pulsing) border', () => {
  const node = nodeOf({ activity: { highlighted: true } });
  const { calls: defaultCalls } = (() => { const c = fakeCtx(); drawNode(node, c.ctx, null, true, 1); return c; })();
  const { calls: customCalls } = (() => { const c = fakeCtx(); drawNode(node, c.ctx, null, true, 1, resolveGraphTheme({ nodeBorderActive: '#123456' })); return c; })();
  assert.notDeepEqual(strokeStyles(customCalls), strokeStyles(defaultCalls));
});

test('theme.nodeBorderPulsing changes the actively-running (pulsing) border', () => {
  const node = nodeOf({ status: 'running', activity: { highlighted: true } });
  // reducedMotion=true freezes breath at 0 so the blend amount is deterministic.
  const { calls: defaultCalls } = (() => { const c = fakeCtx(); drawNode(node, c.ctx, null, true, 1); return c; })();
  const { calls: customCalls } = (() => { const c = fakeCtx(); drawNode(node, c.ctx, null, true, 1, resolveGraphTheme({ nodeBorderPulsing: '#123456' })); return c; })();
  assert.notDeepEqual(strokeStyles(customCalls), strokeStyles(defaultCalls));
});

test('theme.nodeBorderSelected changes the selected-node border', () => {
  const node = nodeOf();
  const { calls: defaultCalls } = (() => { const c = fakeCtx(); drawNode(node, c.ctx, 'n', true, 1); return c; })();
  const { calls: customCalls } = (() => { const c = fakeCtx(); drawNode(node, c.ctx, 'n', true, 1, resolveGraphTheme({ nodeBorderSelected: '#123456' })); return c; })();
  assert.notDeepEqual(strokeStyles(customCalls), strokeStyles(defaultCalls));
});

test('theme.labelSubIdle / labelSubBright change the badge/icon sub-text color', () => {
  const idle = nodeOf();
  const { calls: idleDefault } = (() => { const c = fakeCtx(); drawNode(idle, c.ctx, null, true, 1); return c; })();
  const { calls: idleCustom } = (() => { const c = fakeCtx(); drawNode(idle, c.ctx, null, true, 1, resolveGraphTheme({ labelSubIdle: '#123456' })); return c; })();
  assert.notDeepEqual(fillStyles(idleCustom), fillStyles(idleDefault));

  const bright = nodeOf({ activity: { highlighted: true } });
  const { calls: brightDefault } = (() => { const c = fakeCtx(); drawNode(bright, c.ctx, null, true, 1); return c; })();
  const { calls: brightCustom } = (() => { const c = fakeCtx(); drawNode(bright, c.ctx, null, true, 1, resolveGraphTheme({ labelSubBright: '#123456' })); return c; })();
  assert.notDeepEqual(fillStyles(brightCustom), fillStyles(brightDefault));
});

test('theme.labelTitleIdle / labelTitleBright change the title text color', () => {
  const idle = nodeOf();
  const { calls: idleDefault } = (() => { const c = fakeCtx(); drawNode(idle, c.ctx, null, true, 1); return c; })();
  const { calls: idleCustom } = (() => { const c = fakeCtx(); drawNode(idle, c.ctx, null, true, 1, resolveGraphTheme({ labelTitleIdle: '#123456' })); return c; })();
  assert.notDeepEqual(fillStyles(idleCustom), fillStyles(idleDefault));

  const bright = nodeOf({ activity: { highlighted: true } });
  const { calls: brightDefault } = (() => { const c = fakeCtx(); drawNode(bright, c.ctx, null, true, 1); return c; })();
  const { calls: brightCustom } = (() => { const c = fakeCtx(); drawNode(bright, c.ctx, null, true, 1, resolveGraphTheme({ labelTitleBright: '#123456' })); return c; })();
  assert.notDeepEqual(fillStyles(brightCustom), fillStyles(brightDefault));
});

test('theme.errorDim / errorBright change an errored node\'s detail/summary text', () => {
  const idleError = nodeOf({ status: 'error' });
  const { calls: idleDefault } = (() => { const c = fakeCtx(); drawNode(idleError, c.ctx, null, true, 1); return c; })();
  const { calls: idleCustom } = (() => { const c = fakeCtx(); drawNode(idleError, c.ctx, null, true, 1, resolveGraphTheme({ errorDim: '#123456' })); return c; })();
  assert.notDeepEqual(fillStyles(idleCustom), fillStyles(idleDefault));

  const brightError = nodeOf({ status: 'error', activity: { highlighted: true } });
  const { calls: brightDefault } = (() => { const c = fakeCtx(); drawNode(brightError, c.ctx, null, true, 1); return c; })();
  const { calls: brightCustom } = (() => { const c = fakeCtx(); drawNode(brightError, c.ctx, null, true, 1, resolveGraphTheme({ errorBright: '#123456' })); return c; })();
  assert.notDeepEqual(fillStyles(brightCustom), fillStyles(brightDefault));
});

test('theme.edgeLineIdle / edgeAccentFallback change a call edge\'s line color', () => {
  const idle = linkOf();
  const { calls: idleDefault } = (() => { const c = fakeCtx(); drawLink(idle, c.ctx, null, true); return c; })();
  const { calls: idleCustom } = (() => { const c = fakeCtx(); drawLink(idle, c.ctx, null, true, resolveGraphTheme({ edgeLineIdle: '#123456' })); return c; })();
  assert.notDeepEqual(strokeStyles(idleCustom), strokeStyles(idleDefault));

  const bright = linkOf({ activity: { highlighted: true } });
  const { calls: brightDefault } = (() => { const c = fakeCtx(); drawLink(bright, c.ctx, null, true); return c; })();
  const { calls: brightCustom } = (() => { const c = fakeCtx(); drawLink(bright, c.ctx, null, true, resolveGraphTheme({ edgeAccentFallback: '#123456' })); return c; })();
  assert.notDeepEqual(strokeStyles(brightCustom), strokeStyles(brightDefault));
});

test("an edge's own accent still wins over theme.edgeAccentFallback", () => {
  const link = linkOf({ activity: { highlighted: true }, accent: '#00ff00' });
  const { calls: defaultCalls } = (() => { const c = fakeCtx(); drawLink(link, c.ctx, null, true); return c; })();
  const { calls: customCalls } = (() => { const c = fakeCtx(); drawLink(link, c.ctx, null, true, resolveGraphTheme({ edgeAccentFallback: '#123456' })); return c; })();
  assert.deepEqual(strokeStyles(customCalls), strokeStyles(defaultCalls));
});

test('theme.arrowIdle / arrowBright change the arrowhead fill', () => {
  const idle = linkOf();
  const { calls: idleDefault } = (() => { const c = fakeCtx(); drawLink(idle, c.ctx, null, true); return c; })();
  const { calls: idleCustom } = (() => { const c = fakeCtx(); drawLink(idle, c.ctx, null, true, resolveGraphTheme({ arrowIdle: '#123456' })); return c; })();
  assert.notDeepEqual(fillStyles(idleCustom), fillStyles(idleDefault));

  const bright = linkOf({ activity: { highlighted: true } });
  const { calls: brightDefault } = (() => { const c = fakeCtx(); drawLink(bright, c.ctx, null, true); return c; })();
  const { calls: brightCustom } = (() => { const c = fakeCtx(); drawLink(bright, c.ctx, null, true, resolveGraphTheme({ arrowBright: '#123456' })); return c; })();
  assert.notDeepEqual(fillStyles(brightCustom), fillStyles(brightDefault));
});

test('theme.travelingDot / travelingDotGlow change the traveling-call dot', () => {
  const now = Date.now();
  const traveling = linkOf({ activity: { highlighted: true, updatedAt: now } });
  const { calls: defaultCalls } = (() => { const c = fakeCtx(); drawLink(traveling, c.ctx, null, false); return c; })();
  const { calls: dotCustom } = (() => { const c = fakeCtx(); drawLink(traveling, c.ctx, null, false, resolveGraphTheme({ travelingDot: '#123456' })); return c; })();
  assert.notDeepEqual(fillStyles(dotCustom), fillStyles(defaultCalls));
  const { calls: glowCustom } = (() => { const c = fakeCtx(); drawLink(traveling, c.ctx, null, false, resolveGraphTheme({ travelingDotGlow: '#123456' })); return c; })();
  assert.notDeepEqual(shadowColors(glowCustom), shadowColors(defaultCalls));
});

test('theme.edgeLabelBg changes the edge label pill background', () => {
  const link = linkOf({ label: 'call', showLabel: true });
  const { calls: defaultCalls } = (() => { const c = fakeCtx(); drawLink(link, c.ctx, null, true); return c; })();
  const { calls: customCalls } = (() => { const c = fakeCtx(); drawLink(link, c.ctx, null, true, resolveGraphTheme({ edgeLabelBg: '#123456' })); return c; })();
  assert.notDeepEqual(fillStyles(customCalls), fillStyles(defaultCalls));
});

test('theme.edgeLabelTextIdle / edgeLabelTextBright change the edge label text color', () => {
  const idle = linkOf({ label: 'call', showLabel: true });
  const { calls: idleDefault } = (() => { const c = fakeCtx(); drawLink(idle, c.ctx, null, true); return c; })();
  const { calls: idleCustom } = (() => { const c = fakeCtx(); drawLink(idle, c.ctx, null, true, resolveGraphTheme({ edgeLabelTextIdle: '#123456' })); return c; })();
  assert.notDeepEqual(fillStyles(idleCustom), fillStyles(idleDefault));

  const bright = linkOf({ label: 'call', showLabel: true, activity: { highlighted: true } });
  const { calls: brightDefault } = (() => { const c = fakeCtx(); drawLink(bright, c.ctx, null, true); return c; })();
  const { calls: brightCustom } = (() => { const c = fakeCtx(); drawLink(bright, c.ctx, null, true, resolveGraphTheme({ edgeLabelTextBright: '#123456' })); return c; })();
  assert.notDeepEqual(fillStyles(brightCustom), fillStyles(brightDefault));
});

test('theme.groupAccentFallback changes a hull\'s fill/stroke/label color when the group has no own accent', () => {
  const nodes = reconcile(emptyGraph(), [{ id: 'a', label: 'A', group: 'g', position: { x: 0, y: 0, anchored: true } }], []).nodes;
  const group = { id: 'g', label: 'G' };
  const { calls: defaultCalls } = (() => { const c = fakeCtx(); drawGroupHull(c.ctx, group, nodes); return c; })();
  const { calls: customCalls } = (() => { const c = fakeCtx(); drawGroupHull(c.ctx, group, nodes, resolveGraphTheme({ groupAccentFallback: '#123456' })); return c; })();
  assert.notDeepEqual(fillStyles(customCalls), fillStyles(defaultCalls));
  assert.notDeepEqual(strokeStyles(customCalls), strokeStyles(defaultCalls));
});

test("a group's own accent still wins over theme.groupAccentFallback", () => {
  const nodes = reconcile(emptyGraph(), [{ id: 'a', label: 'A', group: 'g', position: { x: 0, y: 0, anchored: true } }], []).nodes;
  const group = { id: 'g', label: 'G', accent: '#00ff00' };
  const { calls: defaultCalls } = (() => { const c = fakeCtx(); drawGroupHull(c.ctx, group, nodes); return c; })();
  const { calls: customCalls } = (() => { const c = fakeCtx(); drawGroupHull(c.ctx, group, nodes, resolveGraphTheme({ groupAccentFallback: '#123456' })); return c; })();
  assert.deepEqual(fillStyles(customCalls), fillStyles(defaultCalls));
  assert.deepEqual(strokeStyles(customCalls), strokeStyles(defaultCalls));
});

test('resolveGraphTheme fills unset fields with DEFAULT_GRAPH_THEME defaults and keeps set fields', () => {
  const resolved = resolveGraphTheme({ nodeFillIdle: '#123456' });
  assert.equal(resolved.nodeFillIdle, '#123456');
  assert.equal(resolved.nodeFillActive, DEFAULT_GRAPH_THEME.nodeFillActive);
  assert.deepEqual(resolveGraphTheme(), DEFAULT_GRAPH_THEME);
  assert.deepEqual(resolveGraphTheme(undefined), DEFAULT_GRAPH_THEME);
});

test('theme.nodeAccentIdleMix shows an idle node its own accent; unset keeps the grey idle accent', () => {
  const idle = nodeOf({ presentation: { accent: '#ff0000' } });
  const draw = (theme) => { const c = fakeCtx(); drawNode(idle, c.ctx, null, true, 1, theme); return fillStyles(c.calls); };
  const plain = draw(DEFAULT_GRAPH_THEME);
  assert.ok(plain.includes('rgb(119,130,125)'), 'unset: the bar is nodeAccentIdle');
  assert.deepEqual(draw(resolveGraphTheme({ nodeAccentIdleMix: 0 })), plain);
  const full = draw(resolveGraphTheme({ nodeAccentIdleMix: 1 }));
  assert.ok(full.includes('rgb(255,0,0)'), 'mix 1: the bar is the node accent');
  assert.ok(!full.includes('rgb(119,130,125)'));
  assert.deepEqual(draw(resolveGraphTheme({ nodeAccentIdleMix: 7 })), full, 'clamped to 1');
});
