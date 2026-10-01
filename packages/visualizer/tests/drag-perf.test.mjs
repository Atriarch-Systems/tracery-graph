// Pure pieces behind the explorer's drag/live-update performance: data-only updates must not look like
// new graphs (a new graph reheats the layout), hulls are cached per layout version, big graphs skip
// canvas shadows, and placement indexes parents instead of scanning edges per node.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, emptyGraph, sameStructure } from '../dist/model.js';
import { drawNode, drawLink } from '../dist/drawing.js';
import { HullCache, drawGroups, groupAlpha, groupHullShape, hitTestShape } from '../dist/groups.js';
import { placeBranches } from '../dist/layout.js';

const recordingCtx = () => {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (_t, key) => key === 'measureText' ? (s) => ({ width: String(s).length * 6 }) : (...args) => calls.push([key, ...args]),
    set: (_t, key, value) => { calls.push(['set', key, value]); return true; },
  });
  return { ctx, calls };
};

const specs = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }];
const links = [{ id: 'ab', source: 'a', target: 'b' }, { id: 'bc', source: 'b', target: 'c' }];

test('reconcile keeps node and link objects across a data-only update, and sameStructure says so', () => {
  const first = reconcile(emptyGraph(), specs, links);
  // force-graph replaces link ends with the node objects it resolved; the next reconcile must cope with that
  for (const link of first.links) { link.source = first.nodes.find((n) => n.id === link.source); link.target = first.nodes.find((n) => n.id === link.target); }
  const renamed = specs.map((s) => (s.id === 'b' ? { ...s, label: 'B renamed', status: 'running' } : s));
  const second = reconcile(first, renamed, links.map((l) => ({ ...l, count: 3 })));
  assert.equal(second.nodes[1], first.nodes[1], 'same node object');
  assert.equal(second.links[0], first.links[0], 'same link object');
  assert.equal(second.nodes[1].spec.label, 'B renamed', 'spec updated in place');
  assert.equal(second.links[0].spec.count, 3, 'link spec updated in place');
  assert.ok(sameStructure(first, second), 'a data-only update is not a structural change');
});

test('sameStructure is false when a node or an edge is added or removed', () => {
  const first = reconcile(emptyGraph(), specs, links);
  const moreNodes = reconcile(first, [...specs, { id: 'd', label: 'D' }], links);
  assert.equal(sameStructure(first, moreNodes), false);
  const fewerLinks = reconcile(first, specs, links.slice(0, 1));
  assert.equal(sameStructure(first, fewerLinks), false);
  const rewired = reconcile(first, specs, [{ id: 'ab', source: 'a', target: 'c' }, links[1]]);
  assert.equal(sameStructure(first, rewired), false, 'an edge whose ends changed is a new link');
});

test('HullCache computes a hull once per layout version', () => {
  const nodes = reconcile(emptyGraph(), [
    { id: 'a', label: 'A', group: 'g', position: { x: 0, y: 0, anchored: true } },
    { id: 'b', label: 'B', group: 'g', position: { x: 300, y: 0, anchored: true } },
    { id: 'c', label: 'C', group: 'g', position: { x: 150, y: 200, anchored: true } },
  ], []).nodes;
  const groups = [{ id: 'g', label: 'G' }];
  const cache = new HullCache();
  cache.sync(1);
  const { ctx } = recordingCtx();
  drawGroups(ctx, groups, nodes, undefined, cache);
  const first = cache.shapeOf('g', cache.membersOf(nodes, groups).get('g'));
  nodes[0].x = -500; // moved without the owner bumping the version: the cached shape is still served
  drawGroups(ctx, groups, nodes, undefined, cache);
  assert.equal(cache.shapeOf('g', cache.membersOf(nodes, groups).get('g')), first);
  cache.sync(2);
  const fresh = cache.shapeOf('g', cache.membersOf(nodes, groups).get('g'));
  assert.notEqual(fresh, first);
  assert.deepEqual(fresh, groupHullShape(nodes));
  assert.ok(hitTestShape(fresh, { x: -480, y: 10 }), 'the new hull covers the moved node');
});

test('groupAlpha accepts a set of dimmed group ids as well as the group list', () => {
  const [node] = reconcile(emptyGraph(), [{ id: 'a', label: 'A', group: 'g' }], []).nodes;
  assert.equal(groupAlpha(node, new Set(['g'])), 0.45);
  assert.equal(groupAlpha(node, new Set()), 1);
  assert.equal(groupAlpha(node, [{ id: 'g', label: 'G', dimmed: true }]), 0.45);
});

test('drawNode and drawLink skip canvas shadows when shadows is false', () => {
  const now = Date.now();
  const [node] = reconcile(emptyGraph(), [{ id: 'a', label: 'A', status: 'running', activity: { highlighted: true, enteredAt: now - 5000, updatedAt: now } }], []).nodes;
  const withShadow = recordingCtx();
  drawNode(node, withShadow.ctx, null, false, 1, undefined, true);
  assert.ok(withShadow.calls.some((c) => c[0] === 'set' && c[1] === 'shadowBlur' && c[2] > 0), 'glow is drawn by default');
  const without = recordingCtx();
  drawNode(node, without.ctx, null, false, 1, undefined, false);
  assert.equal(without.calls.some((c) => c[0] === 'set' && c[1] === 'shadowBlur' && c[2] > 0), false);

  const graph = reconcile(emptyGraph(), [{ id: 'a', label: 'A', position: { x: 0, y: 0, anchored: true } }, { id: 'b', label: 'B', position: { x: 300, y: 0, anchored: true } }],
    [{ id: 'ab', source: 'a', target: 'b', activity: { highlighted: true, updatedAt: now } }]);
  const [link] = graph.links;
  link.source = graph.nodes[0]; link.target = graph.nodes[1];
  const linkWith = recordingCtx();
  drawLink(link, linkWith.ctx, null, false, undefined, true);
  assert.ok(linkWith.calls.some((c) => c[0] === 'set' && c[1] === 'shadowBlur' && c[2] > 0), 'the travelling dot glows by default');
  const linkWithout = recordingCtx();
  drawLink(link, linkWithout.ctx, null, false, undefined, false);
  assert.equal(linkWithout.calls.some((c) => c[0] === 'set' && c[1] === 'shadowBlur' && c[2] > 0), false);
});

test('placeBranches places a large tree quickly and keeps earlier placements', () => {
  const count = 1500;
  const nodes = Array.from({ length: count }, (_, i) => ({ id: `n${i}`, label: `N${i}` }));
  const edges = nodes.slice(1).map((n, i) => ({ id: `e${i}`, source: `n${Math.floor(i / 2)}`, target: n.id }));
  const started = performance.now();
  const first = placeBranches(nodes, edges);
  const elapsed = performance.now() - started;
  assert.equal(first.positions.size, count);
  assert.ok(elapsed < 3000, `placing ${count} nodes took ${Math.round(elapsed)} ms`);
  const again = placeBranches([...nodes, { id: 'extra', label: 'Extra' }], [...edges, { id: 'ex', source: 'n0', target: 'extra' }], first.positions);
  for (const [id, placed] of first.positions) assert.deepEqual(again.positions.get(id), placed, `${id} did not move`);
});
