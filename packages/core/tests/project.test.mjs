import test from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../dist/project.js';
import { buildFlows, buildFlow } from '../dist/flows.js';
import { buildSampleFlows, sampleFlowIds, sampleTraceEvents } from '../dist/fixtures.js';
import { evt } from './helpers.mjs';

const byId = (arr) => new Map(arr.map((x) => [x.id, x]));

// ---------------------------------------------------------------------------
// flow scope
// ---------------------------------------------------------------------------

test('flow scope: raw (unnamespaced) node ids, self-edges suppressed, one group', () => {
  const flows = buildSampleFlows();
  const projection = project(flows, { mode: 'flow', flow: sampleFlowIds.parent });
  const nodes = byId(projection.nodes);

  assert.deepEqual([...nodes.keys()].sort(), ['guard:policy', 'human:approval', 'llm:main', 'tool:search']);
  assert.equal(nodes.get('llm:main').group, undefined);
  assert.equal(nodes.get('llm:main').layout, undefined);

  // op:p-report's self edge (llm:main -> llm:main) and the spawn ops' self
  // edges (tool:search -> tool:search) are both suppressed...
  assert.equal(projection.edges.some((e) => e.source === e.target), false);
  // ...but the op stays in the node's history.
  assert.ok(nodes.get('llm:main').data.ops.some((op) => op.id === 'op:p-report'));

  assert.equal(projection.groups.length, 1);
  assert.equal(projection.groups[0].id, sampleFlowIds.parent);
  assert.equal(projection.groups[0].status, 'complete');
});

test('flow scope: detail is the node\'s last op name, footer counts ops (or errors)', () => {
  const flows = buildSampleFlows();
  const projection = project(flows, { mode: 'flow', flow: sampleFlowIds.research2 });
  const nodes = byId(projection.nodes);

  const search = nodes.get('tool:search');
  assert.equal(search.detail, 'tool.search');
  assert.equal(search.footer, '1 errors');
  assert.equal(search.status, 'error');

  const memory = nodes.get('memory:notes');
  assert.equal(memory.footer, '1 ops');
  assert.equal(memory.status, 'idle');
});

test('flow scope: call and data edges carry counts and kinds', () => {
  const flows = buildSampleFlows();
  const projection = project(flows, { mode: 'flow', flow: sampleFlowIds.research1 });
  const dataEdge = projection.edges.find((e) => e.kind === 'data');
  assert.ok(dataEdge, 'expected a data edge from the dataFrom on op:r1-memory');
  assert.equal(dataEdge.source, 'tool:search');
  assert.equal(dataEdge.target, 'memory:notes');

  const callEdge = projection.edges.find((e) => e.source === 'llm:main' && e.target === 'tool:search');
  assert.equal(callEdge.kind, 'call');
  assert.equal(callEdge.count, 1);
  assert.equal(callEdge.showLabel, false, 'a single call is unlabelled until it repeats or an end is selected');
});

test('flow scope: never emits a spawn edge even though the flow has a link', () => {
  const flows = buildSampleFlows();
  const projection = project(flows, { mode: 'flow', flow: sampleFlowIds.research1 });
  assert.equal(projection.edges.some((e) => e.kind === 'spawn'), false);
});

test('flow scope: unknown flow yields an empty projection', () => {
  const flows = buildSampleFlows();
  const projection = project(flows, { mode: 'flow', flow: 'does-not-exist' });
  assert.deepEqual(projection, { nodes: [], edges: [], groups: [] });
});

// ---------------------------------------------------------------------------
// ancestors scope
// ---------------------------------------------------------------------------

test('ancestors scope: namespaced ids keep each actor\'s llm:main apart', () => {
  const flows = buildSampleFlows();
  const projection = project(flows, { mode: 'ancestors', flow: sampleFlowIds.research1 });
  const nodes = byId(projection.nodes);

  assert.ok(nodes.has('agent:orchestrator::llm:main'));
  assert.ok(nodes.has('subagent:research-1::llm:main'));
  assert.notEqual(nodes.get('agent:orchestrator::llm:main'), nodes.get('subagent:research-1::llm:main'));
});

test('ancestors scope: the chosen flow is highlighted, ancestors are dimmed', () => {
  const flows = buildSampleFlows();
  const projection = project(flows, { mode: 'ancestors', flow: sampleFlowIds.research1 });
  const nodes = byId(projection.nodes);

  assert.equal(nodes.get('subagent:research-1::llm:main').activity.highlighted, true);
  assert.equal(nodes.get('agent:orchestrator::llm:main').activity.highlighted, false);
});

test('ancestors scope: spawn edge with layout.parentId pointing at the spawner node', () => {
  const flows = buildSampleFlows();
  const projection = project(flows, { mode: 'ancestors', flow: sampleFlowIds.research1 });

  const spawnEdge = projection.edges.find((e) => e.kind === 'spawn');
  assert.ok(spawnEdge, 'expected a spawn edge');
  assert.equal(spawnEdge.showLabel, true);
  assert.equal(spawnEdge.source, 'agent:orchestrator::tool:search');
  assert.equal(spawnEdge.target, 'subagent:research-1::llm:main');

  const target = byId(projection.nodes).get('subagent:research-1::llm:main');
  assert.equal(target.layout.parentId, 'agent:orchestrator::tool:search');
});

test('ancestors scope: only includes the ancestor chain and the flow itself (two groups)', () => {
  const flows = buildSampleFlows();
  const projection = project(flows, { mode: 'ancestors', flow: sampleFlowIds.research1 });
  assert.deepEqual(projection.groups.map((g) => g.flow).sort(), [sampleFlowIds.parent, sampleFlowIds.research1].sort());
});

test('ancestors scope: when the parent flow is unobserved, only the flow itself is in scope and no spawn edge is drawn', () => {
  const all = buildSampleFlows();
  const withoutParent = new Map([...all].filter(([id]) => id !== sampleFlowIds.parent));
  const projection = project(withoutParent, { mode: 'ancestors', flow: sampleFlowIds.research1 });
  assert.equal(projection.groups.length, 1);
  assert.equal(projection.edges.some((e) => e.kind === 'spawn'), false);
});

test('ancestors scope: unknown flow yields an empty projection', () => {
  const flows = buildSampleFlows();
  const projection = project(flows, { mode: 'ancestors', flow: 'does-not-exist' });
  assert.deepEqual(projection, { nodes: [], edges: [], groups: [] });
});

// ---------------------------------------------------------------------------
// trace scope
// ---------------------------------------------------------------------------

test('trace scope: includes every flow in the trace, all highlighted, one group per flow', () => {
  const flows = buildSampleFlows();
  const traceId = flows.get(sampleFlowIds.parent).trace;
  const projection = project(flows, { mode: 'trace', trace: traceId });

  assert.equal(projection.groups.length, 3);
  assert.ok(projection.nodes.every((n) => n.activity.highlighted === true));

  // Two children spawned from the same parent op/node -> two spawn edges.
  assert.equal(projection.edges.filter((e) => e.kind === 'spawn').length, 2);
});

test('trace scope: an error in a child flow shows up on that flow\'s node and group, not the parent\'s', () => {
  const flows = buildSampleFlows();
  const traceId = flows.get(sampleFlowIds.parent).trace;
  const projection = project(flows, { mode: 'trace', trace: traceId });
  const nodes = byId(projection.nodes);

  const erroredSearch = nodes.get('subagent:research-2::tool:search');
  assert.equal(erroredSearch.status, 'error');

  const groups = new Map(projection.groups.map((g) => [g.flow, g]));
  assert.equal(groups.get(sampleFlowIds.research2).status, 'error');
  assert.equal(groups.get(sampleFlowIds.parent).status, 'complete');
});

test('trace scope: node count matches distinct (actor, node) pairs across all member flows', () => {
  const flows = buildSampleFlows();
  const traceId = flows.get(sampleFlowIds.parent).trace;
  const projection = project(flows, { mode: 'trace', trace: traceId });
  // parent: llm:main, tool:search, guard:policy, human:approval (4)
  // each child: llm:main, tool:search, memory:notes (3 + 3)
  assert.equal(projection.nodes.length, 10);
});

test('trace scope: data edge from research-1\'s dataFrom is present with namespaced endpoints', () => {
  const flows = buildSampleFlows();
  const traceId = flows.get(sampleFlowIds.parent).trace;
  const projection = project(flows, { mode: 'trace', trace: traceId });
  const dataEdge = projection.edges.find((e) => e.kind === 'data');
  assert.ok(dataEdge);
  assert.equal(dataEdge.source, 'subagent:research-1::tool:search');
  assert.equal(dataEdge.target, 'subagent:research-1::memory:notes');
});

test('trace scope: can be queried from any member flow id and yields the same trace', () => {
  const flows = buildSampleFlows();
  const fromParent = project(flows, { mode: 'trace', trace: flows.get(sampleFlowIds.parent).trace });
  const fromChild = project(flows, { mode: 'trace', trace: flows.get(sampleFlowIds.research1).trace });
  assert.deepEqual(fromParent.groups.map((g) => g.flow).sort(), fromChild.groups.map((g) => g.flow).sort());
});

// ---------------------------------------------------------------------------
// core-2: namespaced scopes merge two same-actor flows onto shared node ids
// ---------------------------------------------------------------------------

test('core-2: two flows of the same actor in one trace merge onto one namespaced node id, no duplicate ids and no self-loop spawn edge', () => {
  const flows = buildFlows([
    evt({ id: 'p1', ts: 1000, flow: 'p', op: 'p-root', node: 'llm:main', type: 'start', name: 'root', root: true, actor: { id: 'agent:saga' } }),
    evt({ id: 'p2', ts: 1100, flow: 'p', op: 'p-root', node: 'llm:main', type: 'end', name: 'root', status: 'error' }),
    evt({ id: 'c1', ts: 1200, flow: 'c', op: 'c-root', node: 'llm:main', type: 'start', name: 'root', root: true,
      actor: { id: 'agent:saga' }, link: { parentFlow: 'p' } }), // no parentNode: falls back to parent's root node
    // op 'c-root' is left open (no end): contributes a running op to the merged node.
  ]);

  const traceId = flows.get('p').trace;
  const projection = project(flows, { mode: 'trace', trace: traceId });

  // No duplicate node ids, in particular no two entries for 'agent:saga::llm:main'.
  assert.equal(new Set(projection.nodes.map((n) => n.id)).size, projection.nodes.length);
  assert.equal(projection.nodes.length, 1);

  const merged = projection.nodes[0];
  assert.equal(merged.id, 'agent:saga::llm:main');
  // Ops from both flows are unioned.
  assert.deepEqual(merged.data.ops.map((op) => op.id).sort(), ['c-root', 'p-root']);
  // errorCount (from p) and running (from c) are summed; error takes precedence.
  assert.equal(merged.status, 'error');
  assert.equal(merged.footer, '1 errors');
  assert.equal(merged.active, true); // running > 0 from the still-open child op

  // The spawn edge from parent's llm:main to child's llm:main collapses onto the
  // same namespaced id, so it must be suppressed like a self-edge, not rendered
  // as a self-loop.
  assert.equal(projection.edges.some((e) => e.kind === 'spawn'), false);
  assert.equal(projection.edges.some((e) => e.source === e.target), false);

  // Both flows still get their own group, each listing the shared node id.
  assert.equal(projection.groups.length, 2);
  for (const group of projection.groups) assert.ok(group.nodeIds.includes('agent:saga::llm:main'));
});

test('core-2: distinct actors are unaffected by the merge (regression against ancestors-scope namespacing)', () => {
  const flows = buildSampleFlows();
  const projection = project(flows, { mode: 'ancestors', flow: sampleFlowIds.research1 });
  assert.equal(new Set(projection.nodes.map((n) => n.id)).size, projection.nodes.length);
});

// ---------------------------------------------------------------------------
// spawn edge fallback to the parent's root node
// ---------------------------------------------------------------------------

test('spawn edge falls back to the parent flow\'s root node when link.parentNode is unset', () => {
  const flows = buildFlows([
    evt({ id: '1', ts: 1000, flow: 'parent', op: 'root', node: 'root-node', type: 'start', name: 'root', root: true, actor: { id: 'agent:p' } }),
    evt({ id: '2', ts: 1100, flow: 'child', op: 'root', node: 'child-node', type: 'start', name: 'root', root: true,
      actor: { id: 'agent:c' }, link: { parentFlow: 'parent' } }), // no parentNode
  ]);
  const projection = project(flows, { mode: 'trace', trace: flows.get('parent').trace });
  const spawnEdge = projection.edges.find((e) => e.kind === 'spawn');
  assert.equal(spawnEdge.source, 'agent:p::root-node');
  assert.equal(spawnEdge.target, 'agent:c::child-node');
});

// ---------------------------------------------------------------------------
// history retention (ProjectOptions.history.keepCompletedMs)
// ---------------------------------------------------------------------------

test('history.keepCompletedMs drops long-completed nodes but keeps running ones', () => {
  const flows = buildFlows([
    evt({ id: '1', ts: 1000, flow: 'f1', op: 'root', node: 'n0', type: 'start', name: 'root', root: true }),
    evt({ id: '2', ts: 1500, flow: 'f1', op: 'root', node: 'n0', type: 'end', name: 'root', status: 'success' }),
    evt({ id: '3', ts: 1600, flow: 'f1', op: 'open', node: 'n1', type: 'start', name: 'still-running' }),
  ]);
  const now = 100_000;
  const projection = project(flows, { mode: 'flow', flow: 'f1' }, { now, history: { keepCompletedMs: 1000 } });
  const ids = projection.nodes.map((n) => n.id);
  assert.ok(!ids.includes('n0'), 'completed node far in the past should be dropped');
  assert.ok(ids.includes('n1'), 'still-running node should be kept regardless of age');
});

test('without history.keepCompletedMs, all nodes are kept regardless of age', () => {
  const flows = buildFlow([
    evt({ id: '1', ts: 1000, flow: 'f1', op: 'root', node: 'n0', type: 'start', name: 'root', root: true }),
    evt({ id: '2', ts: 1500, flow: 'f1', op: 'root', node: 'n0', type: 'end', name: 'root', status: 'success' }),
  ]);
  const projection = project(new Map([['f1', flows]]), { mode: 'flow', flow: 'f1' }, { now: 10_000_000 });
  assert.equal(projection.nodes.length, 1);
});

// ---------------------------------------------------------------------------
// custom catalog
// ---------------------------------------------------------------------------

test('a custom catalog function overrides the default presentation', () => {
  const flows = buildSampleFlows();
  const projection = project(flows, { mode: 'flow', flow: sampleFlowIds.parent }, {
    catalog: (node) => ({ badge: node.kind?.toUpperCase() ?? 'NODE', icon: '!' }),
  });
  const llm = byId(projection.nodes).get('llm:main');
  assert.deepEqual(llm.presentation, { badge: 'LLM', icon: '!' });
});

// ---------------------------------------------------------------------------
// sample trace sanity (also exercises fixtures.ts)
// ---------------------------------------------------------------------------

test('sample trace fixture: ~40 events, three flows, one erroring child', () => {
  assert.ok(sampleTraceEvents.length >= 35 && sampleTraceEvents.length <= 45);
  const flows = buildSampleFlows();
  assert.equal(flows.size, 3);
  assert.equal(flows.get(sampleFlowIds.research2).status, 'error');
  assert.equal(flows.get(sampleFlowIds.research1).status, 'complete');
  assert.equal(flows.get(sampleFlowIds.parent).status, 'complete');
});
