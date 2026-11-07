import test from 'node:test';
import assert from 'node:assert/strict';
import { forceSimulation, forceManyBody } from 'd3-force';
import { reconcile, emptyGraph, intensity, opacity, edgeWidth } from '../dist/model.js';
import { VISUALIZER_CONTRACT_VERSION } from '../dist/types.js';

const freeze = value => { Object.freeze(value); for (const item of Object.values(value)) if (item && typeof item === 'object' && !Object.isFrozen(item)) freeze(item); return value; };
test('contract version and immutable consumer data survive engine mutation', () => {
  assert.equal(VISUALIZER_CONTRACT_VERSION, 3);
  const nodes = freeze([{ id:'a',label:'Inbox',position:{x:10,y:20,anchored:true}, data:{domain:'consumer'} },{id:'b',label:'Worker'}]);
  const edges = freeze([{id:'request',source:'a',target:'b',label:'request',count:1}]);
  const graph = reconcile(emptyGraph(),nodes,edges);
  graph.nodes[1].x = 100;
  graph.links[0].source = graph.nodes[0];
  assert.equal(nodes[1].x, undefined);
  assert.equal(edges[0].source,'a');
  assert.deepEqual(nodes[0].data,{domain:'consumer'});
});
test('updates keep layout and allocate new arrays; new edges never leak into old engine arrays', () => {
  const original = reconcile(emptyGraph(),[{id:'a',label:'A'}],[]);
  original.nodes[0].x=77;
  const next = reconcile(original,[{id:'a',label:'Renamed'},{id:'b',label:'B'}],[{id:'ab',source:'a',target:'b'}]);
  assert.equal(next.nodes[0],original.nodes[0]);
  assert.equal(next.nodes[0].x,77);
  assert.equal(original.nodes.length,1);
  assert.equal(original.links.length,0);
  assert.equal(next.nodes[0].spec.label,'Renamed');
});
test('opposite directions and multiple relationships stay separate', () => {
  const graph = reconcile(emptyGraph(),[{id:'a',label:'A'},{id:'b',label:'B'}],[
    {id:'in',source:'a',target:'b',count:1},{id:'out',source:'b',target:'a',count:4},{id:'listen',source:'b',target:'a',count:2}]);
  assert.deepEqual(graph.links.map(l=>l.spec.count),[1,4,2]);
  assert.ok(edgeWidth(4)>edgeWidth(1));
});
test('anchors can move or be released; removals drop dangling edges; reinsertion starts fresh', () => {
  const first = reconcile(emptyGraph(),[{id:'a',label:'A',position:{x:1,y:2,anchored:true}}],[]);
  const moved = reconcile(first,[{id:'a',label:'A',position:{x:3,y:4,anchored:true}}],[]);
  assert.equal(moved.nodes[0].fx,3);
  const free = reconcile(moved,[{id:'a',label:'A'}],[]);
  assert.equal(free.nodes[0].fx,undefined);
  const gone = reconcile(free,[],[{id:'missing',source:'a',target:'b'}]);
  assert.equal(gone.links.length,0);
  assert.notEqual(reconcile(gone,[{id:'a',label:'A'}],[]).nodes[0],first.nodes[0]);
});
test('edge-first updates render once endpoints arrive; self edges are accepted', () => {
  const edges=[{id:'loop',source:'a',target:'a'}];
  const first = reconcile(emptyGraph(),[],edges);
  assert.equal(first.links.length,0);
  assert.equal(reconcile(first,[{id:'a',label:'A'}],edges).links.length,1);
});
// Regression (ui-2): a namespaced (trace/ancestors) scope can project two
// flows onto the same node id (e.g. two flows sharing an actor and a node);
// `reconcile` used to throw here, and since it runs inside `ActivityGraph`'s
// effect with no error boundary above it in the hosted UI, that unmounted the
// whole page over one bad projection. It must degrade instead: keep the
// first occurrence, drop the rest, never throw.
test('duplicate node/edge IDs are deduped (first occurrence wins), never thrown', () => {
  const warnCalls = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnCalls.push(args);
  try {
    const graph = reconcile(emptyGraph(), [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }], []);
    assert.equal(graph.nodes.length, 1);
    assert.equal(graph.nodes[0].spec.label, 'A');

    const withEdges = reconcile(emptyGraph(), [{ id: 'a', label: 'A' }],
      [{ id: 'e', source: 'a', target: 'a' }, { id: 'e', source: 'a', target: 'a' }]);
    assert.equal(withEdges.links.length, 1);
    assert.ok(warnCalls.length >= 2, 'expected a warning for each dropped duplicate');
  } finally {
    console.warn = originalWarn;
  }
});
test('two namespaced flows that collapse onto the same actor::node id render as one node, not a crash', () => {
  // Mirrors the trace-scope repro: two flows sharing an actor resolve both
  // nodes to `agent:saga::llm:main`; project() is expected to merge these
  // (packages/core), but reconcile must survive even if it has not.
  const id = 'agent:saga::llm:main';
  const graph = reconcile(emptyGraph(), [
    { id, label: 'llm:main', data: { flow: 'flow:f1' } },
    { id, label: 'llm:main', data: { flow: 'flow:f2' } },
  ], []);
  assert.equal(graph.nodes.length, 1);
});
test('presentation lifecycle needs no turns or agent event protocol', () => {
  assert.equal(intensity({highlighted:true},1000),1);
  assert.equal(intensity({highlighted:true,completedAt:1000},2000),0);
  assert.equal(intensity({highlighted:false},1000),0);
  assert.equal(opacity({removedAt:1000},2000),0);
  assert.equal(opacity({enteredAt:1000},1450),1);
});

test('package imports and server-renders without a window or document', async () => {
  const { ActivityGraph } = await import('../dist/index.js');
  const { createElement } = await import('react');
  const { renderToString } = await import('react-dom/server');
  const markup = renderToString(createElement(ActivityGraph, {
    nodes:[{id:'custom-job',label:'Entirely consumer-defined',presentation:{badge:'CUSTOM',icon:'Z',radius:20}}],edges:[]
  }));
  assert.match(markup,/Activity graph/);
});

test('custom cards and self edges render without any registered domain kind', async () => {
  const { drawNode, drawLink } = await import('../dist/drawing.js');
  const text = [], curves = [];
  const ctx = new Proxy({}, { get: (_target, key) => key === 'measureText' ? value => ({width:value.length*6})
    : key === 'fillText' ? value => text.push(value)
    : key === 'quadraticCurveTo' ? (...values) => curves.push(values) : () => {}, set: () => true });
  const graph = reconcile(emptyGraph(), [{id:'job',label:'Custom activity',detail:'Checking',footer:'Configured by consumer',
    presentation:{badge:'POLICY',icon:'Z',accent:'#d98aff',width:190,height:80,radius:22},activity:{highlighted:true}}],
    [{id:'repeat',source:'job',target:'job',label:'repeat',showLabel:true}]);
  drawNode(graph.nodes[0],ctx,null,true);
  graph.links[0].source=graph.nodes[0]; graph.links[0].target=graph.nodes[0];
  drawLink(graph.links[0],ctx,null,true);
  assert.ok(text.includes('Z  POLICY'));
  assert.ok(text.includes('Configured by consumer'));
  assert.ok(text.includes('repeat'), 'a single edge is labelled by name alone');
  assert.ok(!text.some(t => t.includes('×1')), 'no lone ×1 count');
  assert.ok(curves[0][0]>95, 'self edge must curve outside its card');
});


test('active cards pulse; idle, completed, gray and reduced-motion cards stay still', async () => {
  const { drawNode } = await import('../dist/drawing.js');
  const { isNodeActive } = await import('../dist/model.js');
  const render = (spec, now, reduced = false) => {
    const commands = [];
    const ctx = new Proxy({}, {
      get: (_target, key) => (...args) => commands.push([key, ...args]),
      set: (_target, key, value) => { commands.push([key, value]); return true; },
    });
    const saved = Date.now;
    Date.now = () => now;
    try { drawNode(reconcile(emptyGraph(), [spec], []).nodes[0], ctx, null, reduced); }
    finally { Date.now = saved; }
    return commands;
  };
  const busy = {id:'llm', label:'Thinking',status:'running',activity:{highlighted:true}};
  assert.notDeepEqual(render(busy, 450), render(busy, 1350));
  assert.deepEqual(render(busy, 450, true), render(busy, 1350, true));
  for (const spec of [
    {...busy,status:'idle'}, {...busy,active:false},
    {...busy,activity:{highlighted:false}},
    {...busy,activity:{highlighted:true,completedAt:0}},
  ]) {
    assert.equal(isNodeActive(spec, 2000), false);
    assert.deepEqual(render(spec, 2000), render(spec, 2900));
  }
  const erroredBusy = {...busy,status:'error',active:true};
  assert.equal(isNodeActive(erroredBusy,450),true);
  assert.notDeepEqual(render(erroredBusy,450),render(erroredBusy,1350));
  assert.ok(render(erroredBusy,450).some(([key,value]) => key==='shadowColor' && value==='#f28b82aa'));
  assert.equal(isNodeActive({...busy,activity:{highlighted:true,completedAt:449}},450),false);
});

test('guided nodes retain exact placements through the first physics ticks, updates and scope restoration', () => {
  const specs = [
    { id: 'parent', label: 'Parent', position: { x: 120, y: 78 } },
    { id: 'child', label: 'Child', position: { x: 120, y: 220 } },
  ];
  const verifyTicks = (graph, expected) => {
    // A renderer can tick before its forces are configured. Guided positions
    // must survive that ordering, including the first frame after a scope swap.
    const simulation = forceSimulation(graph.nodes).force('charge', forceManyBody()).stop();
    simulation.tick(5);
    assert.deepEqual(graph.nodes.map(({ id, x, y }) => ({ id, x, y })), expected);
  };
  const expected = specs.map(({ id, position }) => ({ id, x: position.x, y: position.y }));
  const first = reconcile(emptyGraph(), specs, [], 'guided');
  verifyTicks(first, expected);
  first.nodes[0].x += 70; first.nodes[0].y += 45;
  const moved = expected.map(node => node.id === 'parent' ? { ...node, x: node.x + 70, y: node.y + 45 } : node);
  verifyTicks(reconcile(first, specs, [], 'guided'), moved);
  const restored = specs.map(spec => ({ ...spec, position: moved.find(node => node.id === spec.id) }));
  verifyTicks(reconcile(emptyGraph(), restored, [], 'guided'), moved);
  const free = reconcile(emptyGraph(), specs, [], 'force');
  const simulation = forceSimulation(free.nodes).force('charge', forceManyBody()).stop();
  simulation.tick(5);
  assert.notEqual(free.nodes[0].y, expected[0].y, 'force layout must remain free to move');
});test('edge labels: name alone for one call, name ×n when repeated, nothing for an unnamed single edge', async () => {
  const { drawLink } = await import('../dist/drawing.js');
  const draw = (spec) => {
    const text = [];
    const ctx = new Proxy({}, { get: (_t, key) => key === 'measureText' ? v => ({width:v.length*6}) : key === 'fillText' ? v => text.push(v) : () => {}, set: () => true });
    const graph = reconcile(emptyGraph(), [{id:'a',label:'A'},{id:'b',label:'B'}], [{id:'e',source:'a',target:'b',...spec}]);
    graph.links[0].source = graph.nodes[0]; graph.links[0].target = graph.nodes[1];
    drawLink(graph.links[0], ctx, null, true);
    return text;
  };
  assert.deepEqual(draw({label:'invoke', showLabel:true}), ['invoke']);
  assert.deepEqual(draw({label:'invoke', count:3}), ['invoke ×3']);
  assert.deepEqual(draw({label:'invoke'}), [], 'a single call edge is unlabelled unless asked or selected');
  assert.deepEqual(draw({showLabel:true}), []);
  assert.deepEqual(draw({count:2}), ['×2']);
});
