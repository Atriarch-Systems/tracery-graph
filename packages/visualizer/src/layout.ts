import type { ActivityNode, ActivityEdge } from './types.js';

export interface Placement { x: number; y: number; width: number; height: number; group?: string; slot?: number }
export type PlacementState = ReadonlyMap<string, Placement>;
const dimensions = (n: ActivityNode) => ({ width: Math.max(70, n.presentation?.width ?? 138), height: Math.max(62, n.presentation?.height ?? 62) });

/** Incremental placement: append beside the first observed parent; never reflow existing cards.
 * Return edges and repeated counts have no influence on placement. Hints are presentation only.
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
      if (node.position?.anchored || !parent || !byId.has(parent) || positions.has(parent)) {
        insert(node); pending.splice(i,1); progress = true;
      } else i++;
    }
    if (!progress) insert(pending.shift()!);
  }
  return { positions, nodes: nodes.map(node => ({...node, position: {
    x: positions.get(node.id)!.x, y: positions.get(node.id)!.y, anchored: node.position?.anchored,
  }})) };
}
