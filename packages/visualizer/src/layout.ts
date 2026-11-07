import type { ActivityNode, ActivityEdge } from './types.js';

export interface Placement { x: number; y: number; width: number; height: number; group?: string; slot?: number }
export type PlacementState = ReadonlyMap<string, Placement>;
const dimensions = (n: ActivityNode) => ({ width: Math.max(70, n.presentation?.width ?? 138), height: Math.max(62, n.presentation?.height ?? 62) });

/** Incremental placement: append beside the first observed parent; never reflow existing cards.
 * A node with 'data' edges from siblings (same placement parent) goes right of them, on the row of the
 * furthest one. Return edges and repeated counts have no influence on placement. Hints are presentation only.
 */
export function placeBranches<N>(nodes: readonly ActivityNode<N>[], edges: readonly ActivityEdge[], previous: PlacementState = new Map()) {
  const positions = new Map<string, Placement>();
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const node of nodes) {
    const old = previous.get(node.id);
    if (old) positions.set(node.id, old);
  }
  const pending = nodes.filter(n => !positions.has(n.id));
  // 'data' edges never imply placement parenthood (SPEC §3); 'call' and 'spawn' do.
  // First qualifying incoming edge per target, indexed once instead of scanned per node.
  const firstParent = new Map<string, string>();
  for (const e of edges) {
    if (e.source !== e.target && (e.kind ?? 'call') !== 'data' && !firstParent.has(e.target)) firstParent.set(e.target, e.source);
  }
  const parentOf = (node: ActivityNode) => node.layout?.parentId ?? firstParent.get(node.id);
  // 'data' edges between siblings (nodes sharing a placement parent) order them into columns: a node sits
  // to the right of the siblings it reads from, so a pipeline under one parent reads left to right instead
  // of stacking in a single column. They still never make a node anyone's placement parent.
  const dataSources = new Map<string, string[]>();
  for (const e of edges) {
    if ((e.kind ?? 'call') !== 'data' || e.source === e.target || !byId.has(e.source)) continue;
    const list = dataSources.get(e.target);
    if (list) { if (!list.includes(e.source)) list.push(e.source); } else dataSources.set(e.target, [e.source]);
  }
  const siblingSources = (node: ActivityNode) => {
    const parentId = parentOf(node);
    if (!parentId || node.position?.anchored) return [];
    return (dataSources.get(node.id) ?? []).filter(id => parentOf(byId.get(id)!) === parentId);
  };
  let anchoredCount = 0;
  for (const id of positions.keys()) if (byId.get(id)?.position?.anchored) anchoredCount++;
  const collides = (x: number, y: number, size: {width: number; height: number}) => [...positions.values()].some(p =>
    Math.abs(p.x - x) < (p.width + size.width) / 2 + 28 && Math.abs(p.y - y) < (p.height + size.height) / 2 + 24);
  const insert = (node: ActivityNode) => {
    const size = dimensions(node), parentId = parentOf(node), parent = parentId ? positions.get(parentId) : undefined;
    const group = node.layout?.leaf ? (node.layout.group ?? parentId ?? 'leaves') : undefined;
    const siblings = group ? [...positions.values()].filter(p => p.group === group) : [];
    const slot = group ? Math.max(-1, ...siblings.map(p => p.slot ?? -1)) + 1 : 0;
    const rootCount = anchoredCount;
    let x = parent ? parent.x + parent.width / 2 + size.width / 2 + 76 : 0;
    let y = node.layout?.lane !== undefined ? node.layout.lane * 90 : parent?.y ?? rootCount * 260;
    // Right of the furthest placed sibling it reads from, on that sibling's row (a lane hint still wins).
    let upstream: Placement | undefined;
    for (const id of siblingSources(node)) {
      const p = positions.get(id);
      if (p && (!upstream || p.x > upstream.x)) upstream = p;
    }
    if (upstream) {
      x = Math.max(x, upstream.x + upstream.width / 2 + size.width / 2 + 76);
      if (node.layout?.lane === undefined) y = upstream.y;
    }
    if (node.position?.anchored) { x = 0; y = rootCount * 310; }
    if (group) { x += (slot % 3) * (size.width + 42); y += Math.floor(slot / 3) * (size.height + 38); }
    // Search nearby free rows, preserving a forward-growing branch and all occupied slots.
    const origin = y;
    for (let attempt = 0; collides(x,y,size) && attempt < nodes.length * 4 + 8; attempt++) {
      y = origin + (attempt % 2 === 0 ? 1 : -1) * (Math.floor(attempt / 2) + 1) * (size.height + 40);
    }
    positions.set(node.id, {x,y,...size,group,slot});
    if (node.position?.anchored) anchoredCount++;
  };
  // Topological admission where possible; missing parents and cycles remain renderable.
  while (pending.length) {
    let progress = false;
    for (let i = 0; i < pending.length;) {
      const node = pending[i], parent = parentOf(node);
      const ready = node.position?.anchored || !parent || !byId.has(parent) || positions.has(parent);
      // Wait for the siblings it reads from too; a data cycle falls through to the forced insert below.
      if (ready && siblingSources(node).every(id => positions.has(id))) {
        insert(node); pending.splice(i,1); progress = true;
      } else i++;
    }
    if (!progress) insert(pending.shift()!);
  }
  return { positions, nodes: nodes.map(node => ({...node, position: {
    x: positions.get(node.id)!.x, y: positions.get(node.id)!.y, anchored: node.position?.anchored,
  }})) };
}
