import test from 'node:test';
import assert from 'node:assert/strict';
import {placeBranches} from '../dist/layout.js';

test('growing camera cluster retains ordered slots and never moves existing cards', () => {
  let nodes=[{id:'source',label:'Source',position:{x:0,y:0,anchored:true}},{id:'camera',label:'Camera'}];
  let edges=[{id:'c',source:'source',target:'camera'}];
  let result=placeBranches(nodes,edges);
  const original=new Map(result.positions);
  for(let i=0;i<9;i++) {
    nodes=[...nodes,{id:'frame'+i,label:'Frame '+i,layout:{leaf:true,lane:-2,group:'frames'}}];
    edges=[...edges,{id:'f'+i,source:'camera',target:'frame'+i}];
    const before=result.positions;
    result=placeBranches(nodes,edges,before);
    for(const [id,p] of before) assert.deepEqual(result.positions.get(id),p);
    assert.equal(result.positions.get('frame'+i).slot,i);
  }
  const again=placeBranches(nodes,[...edges,{id:'back',source:'frame8',target:'source',count:900}],result.positions);
  assert.deepEqual(again.positions,result.positions);
  assert.deepEqual(result.positions.get('camera'),original.get('camera'));
  for(const a of result.positions.values()) for(const b of result.positions.values()) if(a!==b)
    assert.ok(Math.abs(a.x-b.x)>=(a.width+b.width)/2 || Math.abs(a.y-b.y)>=(a.height+b.height)/2);
});
test('parent can arrive later in array; missing parents and cycles remain finite', () => {
 const nodes=[{id:'b',label:'B'},{id:'a',label:'A',position:{x:0,y:0,anchored:true}},{id:'c',label:'C'}];
 const result=placeBranches(nodes,[{id:'ab',source:'a',target:'b'},{id:'cb',source:'c',target:'b'},{id:'bc',source:'b',target:'c'}]);
 assert.ok(result.positions.get('b').x>result.positions.get('a').x);
 assert.ok([...result.positions.values()].every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)));
 assert.equal(nodes[0].position,undefined);
 assert.equal(placeBranches([],[],result.positions).positions.size,0);
});
test('data edges are never a placement parent; spawn edges are valid parents', () => {
  // Two anchored roots land in the same left column (x=0) at different rows (y), so 'y' is
  // what distinguishes which one actually acted as the child's placement parent.
  // 'real' is a call-edge parent, 'observer' only reaches the node via a data edge.
  const nodes = [
    {id:'real', label:'Real parent', position:{x:0,y:0,anchored:true}},
    {id:'observer', label:'Data-only observer', position:{x:0,y:0,anchored:true}},
    {id:'child', label:'Child'},
  ];
  const edges = [
    {id:'data-edge', source:'observer', target:'child', kind:'data'},
    {id:'call-edge', source:'real', target:'child', kind:'call'},
  ];
  const result = placeBranches(nodes, edges);
  const real = result.positions.get('real'), observer = result.positions.get('observer'), child = result.positions.get('child');
  assert.notEqual(real.y, observer.y, 'the two anchored roots must land in different rows for this test to distinguish parents');
  // Placed beside its call-edge parent ('real'), not the data-only 'observer'.
  assert.equal(child.y, real.y);
  assert.notEqual(child.y, observer.y);
  assert.ok(child.x > real.x);

  // With only a data edge available, the node has no placement parent (falls back to a root slot).
  const dataOnly = placeBranches(
    [{id:'observer', label:'Observer', position:{x:0,y:0,anchored:true}}, {id:'orphan', label:'Orphan'}],
    [{id:'d', source:'observer', target:'orphan', kind:'data'}],
  );
  assert.equal(dataOnly.positions.get('orphan').x, 0);

  // A spawn edge is a valid placement parent, same as the default 'call'.
  const spawned = placeBranches(
    [{id:'parent', label:'Parent', position:{x:0,y:0,anchored:true}}, {id:'child2', label:'Spawned child'}],
    [{id:'s', source:'parent', target:'child2', kind:'spawn'}],
  );
  assert.ok(spawned.positions.get('child2').x > spawned.positions.get('parent').x);
});
test('data edges between siblings order them left to right without changing their parent', () => {
  // run -> {fetch, draft, render, publish} (calls); fetch -> draft -> render -> publish, draft -> publish (data)
  const nodes = [
    {id:'run', label:'Run', position:{x:0,y:0,anchored:true}},
    {id:'publish', label:'Publish'}, {id:'render', label:'Render'}, {id:'draft', label:'Draft'}, {id:'fetch', label:'Fetch'},
  ];
  const calls = ['fetch','draft','render','publish'].map(id => ({id:'c-'+id, source:'run', target:id}));
  const data = [['fetch','draft'],['draft','render'],['render','publish'],['draft','publish']]
    .map(([s,t]) => ({id:`d-${s}-${t}`, source:s, target:t, kind:'data'}));
  const {positions} = placeBranches(nodes, [...calls, ...data]);
  const x = id => positions.get(id).x, y = id => positions.get(id).y;
  assert.ok(x('run') < x('fetch') && x('fetch') < x('draft') && x('draft') < x('render') && x('render') < x('publish'));
  // A chain stays on one row.
  assert.equal(y('draft'), y('fetch'));
  assert.equal(y('publish'), y('render'));
  // Siblings without data edges between them still share the column beside the parent.
  const flat = placeBranches(nodes, calls).positions;
  assert.equal(flat.get('fetch').x, flat.get('publish').x);
  // A data cycle between siblings stays finite and placed.
  const cyc = placeBranches(nodes, [...calls, {id:'a',source:'fetch',target:'draft',kind:'data'}, {id:'b',source:'draft',target:'fetch',kind:'data'}]);
  assert.equal(cyc.positions.size, nodes.length);
  assert.ok([...cyc.positions.values()].every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
  // Non-overlap holds.
  for (const a of positions.values()) for (const b of positions.values()) if (a !== b)
    assert.ok(Math.abs(a.x-b.x) >= (a.width+b.width)/2 || Math.abs(a.y-b.y) >= (a.height+b.height)/2);
});
