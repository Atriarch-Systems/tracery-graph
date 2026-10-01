import { box, type RuntimeNode } from './model.js';
import type { ActivityGroup } from './types.js';
import { DEFAULT_GRAPH_THEME, type GraphTheme } from './theme.js';

type Point = { x: number; y: number };

const HULL_PAD = 28;
const HULL_RADIUS = 16;

const hex = (color: string | undefined, fallback: string) => /^#[0-9a-f]{6}$/i.test(color ?? '') ? color! : fallback;
const rgb = (color: string) => [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));

/** Members currently on the graph for each configured group, keyed by group id. Groups with no
 * live members are omitted; membership never feeds back into layout. */
export function groupMembers(nodes: readonly RuntimeNode[], groups: readonly ActivityGroup[]): Map<string, RuntimeNode[]> {
  const byGroup = new Map<string, RuntimeNode[]>();
  const known = new Set(groups.map(g => g.id));
  for (const node of nodes) {
    const id = node.spec.group;
    if (id === undefined || !known.has(id)) continue;
    const list = byGroup.get(id);
    if (list) list.push(node); else byGroup.set(id, [node]);
  }
  return byGroup;
}

/** Andrew's monotone-chain convex hull. Input order is irrelevant; output is counter-clockwise. */
export function convexHull(points: readonly Point[]): Point[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length <= 2) return pts;
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return [...lower, ...upper];
}

/** Traces a rounded polygon path (Canvas 2D `arcTo` trick) into the current path. Assumes a
 * convex, counter-clockwise `points` list with at least 3 vertices. */
function roundedPolygonPath(ctx: CanvasRenderingContext2D, points: readonly Point[], radius: number) {
  const n = points.length;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n]!, cur = points[i]!, next = points[(i + 1) % n]!;
    const v1x = prev.x - cur.x, v1y = prev.y - cur.y, len1 = Math.hypot(v1x, v1y) || 1;
    const v2x = next.x - cur.x, v2y = next.y - cur.y, len2 = Math.hypot(v2x, v2y) || 1;
    const r = Math.min(radius, len1 / 2, len2 / 2);
    const a1 = { x: cur.x + (v1x / len1) * r, y: cur.y + (v1y / len1) * r };
    const a2 = { x: cur.x + (v2x / len2) * r, y: cur.y + (v2y / len2) * r };
    if (i === 0) ctx.moveTo(a1.x, a1.y); else ctx.lineTo(a1.x, a1.y);
    ctx.arcTo(cur.x, cur.y, a2.x, a2.y, r);
  }
  ctx.closePath();
}

/** Padded corners of a node's card box, used as hull input so the hull clears the cards. */
export const paddedCorners = (node: RuntimeNode): Point[] => {
  const { w, h } = box(node);
  const x0 = node.x - w / 2 - HULL_PAD, x1 = node.x + w / 2 + HULL_PAD;
  const y0 = node.y - h / 2 - HULL_PAD, y1 = node.y + h / 2 + HULL_PAD;
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
};

/** The one shape `drawGroupHull` fills/strokes and `hitTestGroup` hit-tests against -- factored
 * out so a future change to the padding/shape math here cannot silently desync drawing from hit
 * testing. One and two member groups synthesize a `HULL_PAD`-padded bounding rect (a true convex
 * hull is a visually thin sliver at that size); three or more take the convex hull of every
 * member's padded card corners. */
export type GroupHullShape =
  | { readonly kind: 'rect'; readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }
  | { readonly kind: 'polygon'; readonly points: readonly Point[] };

export function groupHullShape(members: readonly RuntimeNode[]): GroupHullShape {
  if (members.length <= 2) {
    const boxes = members.map(n => ({ n, ...box(n) }));
    const x0 = Math.min(...boxes.map(({ n, w }) => n.x - w / 2)) - HULL_PAD;
    const x1 = Math.max(...boxes.map(({ n, w }) => n.x + w / 2)) + HULL_PAD;
    const y0 = Math.min(...boxes.map(({ n, h }) => n.y - h / 2)) - HULL_PAD;
    const y1 = Math.max(...boxes.map(({ n, h }) => n.y + h / 2)) + HULL_PAD;
    return { kind: 'rect', x0, y0, x1, y1 };
  }
  return { kind: 'polygon', points: convexHull(members.flatMap(paddedCorners)) };
}

/** Standard ray-casting point-in-polygon test against a convex (or arbitrary simple) polygon.
 * Boundary behavior follows the classic half-open-edge convention of this algorithm: a point
 * lying exactly on an edge tests as inside or outside depending on which of that edge's two
 * endpoints is above it in `y` -- sane (no point is ever double-counted or missed entirely by
 * two adjoining edges) but not a guaranteed "always inside" for exact boundary points. */
function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i]!, pj = polygon[j]!;
    const crosses = (pi.y > point.y) !== (pj.y > point.y);
    if (crosses && point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x) inside = !inside;
  }
  return inside;
}

/** Whether `point` (graph coordinates) falls within `group`'s current hull, computed from the
 * exact same `groupHullShape` that `drawGroupHull` fills/strokes -- so a click can never land
 * "inside" a hull the user cannot see, or miss one that is visibly under the pointer. */
export function hitTestGroup(group: ActivityGroup, members: readonly RuntimeNode[], point: Point): boolean {
  void group; // shape depends only on member positions; kept for a symmetrical, self-describing call site
  if (members.length === 0) return false;
  return hitTestShape(groupHullShape(members), point);
}

/** Whether `point` lies in an already computed hull shape (see `HullCache`). */
export function hitTestShape(shape: GroupHullShape, point: Point): boolean {
  return shape.kind === 'rect'
    ? point.x >= shape.x0 && point.x <= shape.x1 && point.y >= shape.y0 && point.y <= shape.y1
    : pointInPolygon(point, shape.points);
}

/**
 * Members and hull shapes per group, valid for one layout version. Computing a hull sorts four
 * corners per member on every frame; node positions only change while something moves them, so the
 * owner bumps `version` then (drag, engine tick, new graph) and a still graph reuses the shapes.
 */
export class HullCache {
  private version = Number.NaN;
  private members = new Map<string, RuntimeNode[]>();
  private shapes = new Map<string, GroupHullShape>();

  /** Drops everything unless `version` is the one the cache was filled for. */
  sync(version: number): void {
    if (version === this.version) return;
    this.version = version;
    this.members.clear();
    this.shapes.clear();
  }

  membersOf(nodes: readonly RuntimeNode[], groups: readonly ActivityGroup[]): Map<string, RuntimeNode[]> {
    if (this.members.size === 0) for (const [id, list] of groupMembers(nodes, groups)) this.members.set(id, list);
    return this.members;
  }

  shapeOf(groupId: string, members: readonly RuntimeNode[]): GroupHullShape {
    let shape = this.shapes.get(groupId);
    if (!shape) { shape = groupHullShape(members); this.shapes.set(groupId, shape); }
    return shape;
  }
}

/** Draws one group's hull (filled at low alpha, stroked faintly) and its label. One and two
 * member groups use a padded, rounded bounding rectangle (a proper hull looks like a sliver at
 * that size); three or more members get a rounded convex hull around the padded card corners. */
export function drawGroupHull(ctx: CanvasRenderingContext2D, group: ActivityGroup, members: readonly RuntimeNode[], theme: GraphTheme = DEFAULT_GRAPH_THEME, precomputed?: GroupHullShape) {
  if (members.length === 0) return;
  const color = hex(group.accent, theme.groupAccentFallback);
  const [r, g, b] = rgb(color);
  let labelX: number, labelY: number;
  ctx.save();
  ctx.globalAlpha = group.dimmed ? 0.45 : 1;
  ctx.fillStyle = `rgba(${r},${g},${b},0.12)`;
  ctx.strokeStyle = `rgba(${r},${g},${b},0.35)`;
  ctx.lineWidth = 1;
  const shape = precomputed ?? groupHullShape(members);
  if (shape.kind === 'rect') {
    ctx.beginPath();
    ctx.roundRect(shape.x0, shape.y0, shape.x1 - shape.x0, shape.y1 - shape.y0, HULL_RADIUS);
    ctx.fill(); ctx.stroke();
    labelX = shape.x0 + 10; labelY = shape.y0 + 12;
  } else {
    roundedPolygonPath(ctx, shape.points, HULL_RADIUS);
    ctx.fill(); ctx.stroke();
    labelX = Math.min(...shape.points.map(p => p.x)) + 10;
    labelY = Math.min(...shape.points.map(p => p.y)) + 12;
  }
  ctx.font = '10px system-ui';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = `rgba(${r},${g},${b},0.85)`;
  ctx.fillText(group.label, labelX, labelY);
  ctx.restore();
}

/** Draws every configured group with live members, beneath the nodes. Call from
 * `onRenderFramePre` so hulls land under the node/link canvas objects. */
export function drawGroups(ctx: CanvasRenderingContext2D, groups: readonly ActivityGroup[], nodes: readonly RuntimeNode[], theme: GraphTheme = DEFAULT_GRAPH_THEME, cache?: HullCache) {
  if (groups.length === 0) return;
  const members = cache ? cache.membersOf(nodes, groups) : groupMembers(nodes, groups);
  for (const group of groups) {
    const list = members.get(group.id) ?? [];
    drawGroupHull(ctx, group, list, theme, cache && list.length > 0 ? cache.shapeOf(group.id, list) : undefined);
  }
}

/** Per-node alpha multiplier so a dimmed group's member cards render at 45% alpha too. */
export function groupAlpha(node: RuntimeNode, groups: readonly ActivityGroup[] | ReadonlySet<string>): number {
  const id = node.spec.group;
  if (id === undefined) return 1;
  // A set holds the ids of the dimmed groups (an O(1) lookup per node per frame).
  if (groups instanceof Set) return groups.has(id) ? 0.45 : 1;
  const group = (groups as readonly ActivityGroup[]).find(g => g.id === id);
  return group?.dimmed ? 0.45 : 1;
}
