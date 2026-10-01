import type { Activity, ActivityNode, ActivityEdge } from './types.js';
export type RuntimeNode = {
  id: string; spec: ActivityNode; x: number; y: number; vx?: number; vy?: number;
  fx?: number; fy?: number; homeX: number; homeY: number; placed?: boolean;
};
export type RuntimeEdge = { id: string; spec: ActivityEdge; source: string | RuntimeNode; target: string | RuntimeNode };
export type RuntimeGraph = { nodes: RuntimeNode[]; links: RuntimeEdge[] };
export const emptyGraph = (): RuntimeGraph => ({ nodes: [], links: [] });
export const box = (n: RuntimeNode) => ({ w: Math.max(70, n.spec.presentation?.width ?? 138), h: Math.max(62, n.spec.presentation?.height ?? 62) });
export const edgeWidth = (count = 1) => Math.min(7, 1.2 + Math.log2(Math.max(1, count)) * 1.8);
export const intensity = (a: Activity | undefined, now: number) => !a?.highlighted ? 0 : a.completedAt === undefined ? 1
  : Math.max(0, 1 - Math.max(0, now - a.completedAt - 250) / 750);
export const opacity = (a: Activity | undefined, now: number) => a?.removedAt === undefined
  ? a?.enteredAt === undefined ? 1 : Math.min(1, Math.max(0, (now - a.enteredAt) / 450))
  : Math.max(0, 1 - (now - a.removedAt) / 1000);

/**
 * Mutations belong to private wrappers, never consumer objects or live d3 arrays.
 *
 * A duplicate node/edge id reaching here is a projector bug upstream (e.g. a
 * namespaced trace/ancestors scope that fails to merge two flows collapsing
 * onto the same `${actor}::${node}` id), not something the canvas should die
 * over: this used to throw, and called from `ActivityGraph`'s effect with no
 * error boundary above it, that unmounted the whole hosted UI over one bad
 * projection. Keep the first occurrence and drop the rest instead.
 */
export function reconcile(previous: RuntimeGraph, nodes: readonly ActivityNode[], edges: readonly ActivityEdge[], layoutMode: 'force' | 'guided' = 'force'): RuntimeGraph {
  const old = new Map(previous.nodes.map(n => [n.id, n]));
  const ids = new Set<string>();
  const next: RuntimeNode[] = [];
  for (const spec of nodes) {
    if (ids.has(spec.id)) {
      console.warn('[tracery-visualizer] dropping duplicate activity node ID:', spec.id);
      continue;
    }
    ids.add(spec.id);
    const node: RuntimeNode = old.get(spec.id) ?? { id: spec.id, spec, x: spec.position?.x ?? 0, y: spec.position?.y ?? 0, homeX: 0, homeY: 0 };
    node.spec = spec;
    node.homeX = spec.position?.x ?? 0; node.homeY = spec.position?.y ?? 0;
    // Guided positions are final, including newly admitted and restored nodes.
    // Pin them before the renderer's first simulation tick, not only after it
    // settles or the next update arrives.
    if (layoutMode === 'guided') node.placed = true;
    node.fx = spec.position?.anchored ? node.homeX : node.placed ? node.x : undefined;
    node.fy = spec.position?.anchored ? node.homeY : node.placed ? node.y : undefined;
    next.push(node);
  }
  const edgeIds = new Set<string>();
  const links: RuntimeEdge[] = [];
  // Reuse a link object (and so the endpoints force-graph already resolved on it) while its ends are unchanged.
  const oldLinks = new Map(previous.links.map(l => [l.id, l]));
  for (const spec of edges) {
    if (edgeIds.has(spec.id)) {
      console.warn('[tracery-visualizer] dropping duplicate activity edge ID:', spec.id);
      continue;
    }
    edgeIds.add(spec.id);
    // Partial streams can deliver edges first. Render once both nodes exist.
    if (!ids.has(spec.source) || !ids.has(spec.target)) continue;
    const reused = oldLinks.get(spec.id);
    if (reused && endpointId(reused.source) === spec.source && endpointId(reused.target) === spec.target) {
      reused.spec = spec;
      links.push(reused);
    } else links.push({ id: spec.id, source: spec.source, target: spec.target, spec });
  }
  return { nodes: next, links };
}

const endpointId = (end: string | RuntimeNode): string => typeof end === 'string' ? end : end.id;

/** Whether `next` holds exactly the node and link objects `previous` does, in the same order. A data-only
 * update (a node's label, status or activity changed) reconciles to the same objects, so the renderer
 * needs a redraw, not a new graph: handing it a new graph re-initialises its links and reheats the
 * simulation. */
export function sameStructure(previous: RuntimeGraph, next: RuntimeGraph): boolean {
  return previous.nodes.length === next.nodes.length && previous.links.length === next.links.length &&
    previous.nodes.every((n, i) => n === next.nodes[i]) && previous.links.every((l, i) => l === next.links[i]);
}

/** Only executing, highlighted nodes animate; completion stops the pulse immediately. */
export const isNodeActive = (node: ActivityNode, now: number): boolean =>
  (node.active ?? node.status === 'running') && node.activity?.completedAt === undefined &&
  node.activity?.removedAt === undefined && intensity(node.activity, now) > 0;
