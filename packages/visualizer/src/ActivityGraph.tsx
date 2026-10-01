"use client";
import { useCallback, useEffect, useMemo, useRef, useState, useImperativeHandle, type ComponentType } from 'react';
import type { ForceGraphMethods, ForceGraphProps } from 'react-force-graph-2d';
import { forceCollide } from 'd3-force';
import type { ActivityGraphProps, ActivityNode, ActivityGroup } from './types.js';
import { emptyGraph, reconcile, sameStructure, box, isNodeActive, type RuntimeGraph, type RuntimeNode, type RuntimeEdge } from './model.js';
import { drawNode, drawLink } from './drawing.js';
import { drawGroups, groupAlpha, HullCache, hitTestShape } from './groups.js';
import { resolveGraphTheme } from './theme.js';
import { detectDoubleClick, emptyDoubleClickState, type DoubleClickState } from './activate.js';
import { renderCapture, captureToBlob, type CaptureOptions } from './capture.js';

function waitOneFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });
}

/** Graph-space movement past which a pointer-down-then-move inside a group's hull commits to a
 * group drag rather than a click. `screen2GraphCoords` already divides by the current zoom
 * scale, so a flat graph-unit threshold behaves like a few screen pixels at any zoom level. */
const GROUP_DRAG_THRESHOLD = 4;
/** Beyond this many nodes the glow (canvas `shadowBlur`, a CPU-bound effect) is not drawn. */
const SHADOW_NODE_LIMIT = 150;
/** How long the graph stays fully idle (engine stopped, nothing animating) before its frame loop is paused. */
const IDLE_PAUSE_MS = 600;
/** Pan/zoom must be still this long before the pointer (hit) canvas is repainted for the new view. */
const ZOOM_SETTLE_MS = 120;

type GroupDragState = {
  readonly pointerId: number;
  readonly group: ActivityGroup;
  readonly members: readonly { readonly id: string; readonly x: number; readonly y: number }[];
  readonly startX: number;
  readonly startY: number;
  dragging: boolean;
};

/** Whether `point` (graph coordinates) lands on any node's own hit box -- the same rectangle
 * `nodePointerAreaPaint` paints for the library's hit canvas -- across every node currently on
 * the graph, not just a candidate group's own members: a node from a different group, or an
 * unaffiliated node, sitting visually inside this group's hull must still block a group drag. */
function pointHitsAnyNode(nodes: readonly RuntimeNode[], point: { x: number; y: number }): boolean {
  return nodes.some(n => {
    const { w, h } = box(n);
    return point.x >= n.x - w / 2 && point.x <= n.x + w / 2 && point.y >= n.y - h / 2 && point.y <= n.y + h / 2;
  });
}

/** No transports, agent catalogs, invocation reducers, or business data live here. */
export function ActivityGraph<N = unknown, E = unknown>(props: ActivityGraphProps<N, E>) {
  const { nodes, edges, layoutKey, apiRef } = props;
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<ForceGraphMethods<RuntimeNode, RuntimeEdge> | undefined>(undefined);
  const runtime = useRef<RuntimeGraph>(emptyGraph());
  const lastKey = useRef(layoutKey);
  const lastMode = useRef(props.layoutMode);
  const lastClick = useRef<DoubleClickState>(emptyDoubleClickState());
  const groupDrag = useRef<GroupDragState | null>(null);
  const dragListeners = useRef<{ move: (e: PointerEvent) => void; up: (e: PointerEvent) => void } | null>(null);
  const hoverCursor = useRef<'default' | 'grab' | 'grabbing'>('default');
  // The latest props, for the stable canvas callbacks below: they must keep their identity across
  // renders (a new callback makes force-graph repaint its hit canvas synchronously), so they read
  // whatever they need from here instead of closing over this render's values.
  const latest = useRef(props);
  latest.current = props;
  // Bumped whenever a node can have moved or the node set changed; keys the group hull cache.
  const layoutVersion = useRef(0);
  const hulls = useRef(new HullCache());
  const engineRunning = useRef(false);
  const pointerDragging = useRef(false);
  const hitPending = useRef(false);
  const zoomTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [graph, setGraph] = useState<RuntimeGraph>(emptyGraph);
  const [size, setSize] = useState({ width: 1000, height: 700 });
  const [systemReduced, setSystemReduced] = useState(false);
  const [visible, setVisible] = useState(true);
  /** Hit canvas refresh token: a new `nodePointerAreaPaint` makes force-graph repaint it at once. */
  const [hitVersion, setHitVersion] = useState(0);
  /** True while the animated parts of the graph (pulses, fades, travelling dots) need every frame. */
  const [animating, setAnimating] = useState(false);
  /** True while a group drag moves nodes outside the force engine. */
  const [dragging, setDragging] = useState(false);
  const [engineStops, setEngineStops] = useState(0);
  const [localSelected, setLocalSelected] = useState<string | null>(null);
  const [Renderer, setRenderer] = useState<ComponentType<ForceGraphProps<RuntimeNode, RuntimeEdge> & { ref?: typeof api }> | null>(null);
  const [loadError, setLoadError] = useState(false);
  const reduced = props.reducedMotion ?? systemReduced;
  const selected = props.selectedNodeId === undefined ? localSelected : props.selectedNodeId;
  const { x = 0, y = 0, width = 1220, height = 660 } = props.view ?? {};
  const guided = props.layoutMode === 'guided';

  useEffect(() => {
    let disposed = false;
    // The package can be imported by SSR consumers; only the canvas loads in a browser.
    import('react-force-graph-2d').then(module => {
      if (!disposed) setRenderer(() => module.default);
    }).catch(() => { if (!disposed) setLoadError(true); });
    return () => { disposed = true; };
  }, []);

  /** Repaints the pointer (hit) canvas for the current node positions now, not on force-graph's 800 ms
   * throttle: once immediately and once after the next frame, when force-graph has queued its own paint. */
  const refreshHitArea = useCallback(() => {
    setHitVersion(v => v + 1);
    if (hitPending.current || typeof requestAnimationFrame !== 'function') return;
    hitPending.current = true;
    requestAnimationFrame(() => { hitPending.current = false; setHitVersion(v => v + 1); });
  }, []);

  // New data keeps every existing node object (so positions survive) and reuses unchanged links. When
  // only node/edge data changed the renderer keeps its graph and just repaints; only an added or
  // removed node or edge hands it a new graph (and, in force mode, reheats the layout).
  useEffect(() => {
    const modeChanged = lastMode.current !== props.layoutMode;
    lastMode.current = props.layoutMode;
    const previous = lastKey.current === layoutKey ? runtime.current : emptyGraph();
    lastKey.current = layoutKey;
    const next = reconcile(previous, nodes, edges, props.layoutMode);
    runtime.current = next;
    layoutVersion.current++;
    if (!modeChanged && previous.nodes.length > 0 && sameStructure(previous, next)) return;
    setGraph(next);
    refreshHitArea();
  }, [nodes, edges, layoutKey, props.layoutMode, refreshHitArea]);

  useEffect(() => {
    if (!host.current) return;
    const resize = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    resize.observe(host.current);
    let intersecting = true;
    const updateVisibility = () => setVisible(intersecting && !document.hidden);
    const intersection = new IntersectionObserver(([entry]) => { intersecting = entry.isIntersecting; updateVisibility(); });
    intersection.observe(host.current);
    document.addEventListener('visibilitychange', updateVisibility);
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const updateMotion = () => setSystemReduced(media.matches);
    updateMotion(); media.addEventListener('change', updateMotion); updateVisibility();
    return () => { resize.disconnect(); intersection.disconnect(); document.removeEventListener('visibilitychange', updateVisibility); media.removeEventListener('change', updateMotion); };
  }, []);

  useEffect(() => () => clearTimeout(zoomTimer.current), []);

  useEffect(() => {
    if (!Renderer || !api.current) return;
    const force = api.current;
    force.d3Force('center', null);
    force.d3Force('charge')?.strength(guided ? 0 : -90);
    force.d3Force('link')?.distance(180).strength(guided ? 0 :
      (link: RuntimeEdge) => (link.spec.kind === 'data' || link.spec.kind === 'spawn') ? 0 : 0.025);
    // Guided cards are pinned, so collisions can never move one; leaving the force out saves a quadtree per tick.
    force.d3Force('collision', guided ? null : forceCollide<RuntimeNode>(n => Math.hypot(box(n).w, box(n).h) / 2 + 9).strength(.85));
    force.d3Force('home', (alpha: number) => {
      for (const n of runtime.current.nodes) {
        if (n.spec.position?.anchored || n.placed) continue;
        n.vx = (n.vx ?? 0) + (n.homeX - n.x) * alpha * (guided ? .8 : .09);
        n.vy = (n.vy ?? 0) + (n.homeY - n.y) * alpha * (guided ? .8 : .09);
      }
    });
  }, [Renderer, guided]);

  useEffect(() => {
    api.current?.centerAt(x, y);
    api.current?.zoom(Math.min(size.width / Math.max(1, width), size.height / Math.max(1, height)));
  }, [Renderer, size.width, size.height, x, y, width, height, layoutKey]);

  // Which parts of the graph are animated right now: a running node pulses, and entering, updating,
  // completing and removed nodes and edges fade for a moment. Only then does the canvas repaint every
  // frame; otherwise it repaints on change (see `autoPauseRedraw` below).
  useEffect(() => {
    const now = Date.now();
    if (!reduced && nodes.some(n => isNodeActive(n, now))) { setAnimating(true); return; }
    const transitions = [...nodes.map(n => n.activity), ...edges.map(l => l.activity)];
    const until = transitions.reduce((max, a) => Math.max(max, (a?.enteredAt ?? 0) + 450,
      (a?.removedAt ?? 0) + 1000, (a?.completedAt ?? 0) + 1000, (a?.updatedAt ?? 0) + 850), now);
    if (until <= now) { setAnimating(false); return; }
    setAnimating(true);
    const timer = setTimeout(() => setAnimating(false), Math.max(500, until - now + 30));
    return () => clearTimeout(timer);
  }, [nodes, edges, reduced]);

  // Frame loop: running while the tab is visible and anything is moving or animating. When the layout
  // engine has stopped and nothing animates, the loop is paused after a short grace period. Never
  // while the engine is still cooling down: freezing it mid-cooldown makes the next pointerdown replay
  // the remaining ticks in one burst. Every interaction and data change resumes it.
  useEffect(() => {
    const force = api.current;
    if (!force) return;
    if (!visible) { force.pauseAnimation(); return; }
    force.resumeAnimation();
    if (animating || dragging) return;
    const timer = setTimeout(() => { if (!engineRunning.current) force.pauseAnimation(); }, IDLE_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [Renderer, visible, animating, dragging, engineStops, nodes, edges, selected, reduced, hitVersion]);

  /** Wakes the frame loop (it may be paused when idle); the idle effect above pauses it again later. */
  const wake = useCallback(() => { api.current?.resumeAnimation(); }, []);

  const fitView = (durationMs = reduced ? 0 : 400) => {
    const force = api.current;
    if (!force) return;
    wake();
    // zoomToFit pads in screen pixels around node centres only, so a card (sized in graph units) can slide
    // out of view once the zoom passes 1. Frame the card extents instead and solve for the zoom directly.
    const list = runtime.current.nodes;
    if (list.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of list) {
      const { w, h } = box(n);
      const nx = n.x ?? n.homeX, ny = n.y ?? n.homeY;
      minX = Math.min(minX, nx - w / 2); maxX = Math.max(maxX, nx + w / 2);
      minY = Math.min(minY, ny - h / 2); maxY = Math.max(maxY, ny + h / 2);
    }
    const canvasW = host.current?.clientWidth || size.width, canvasH = host.current?.clientHeight || size.height;
    const margin = Math.max(8, Math.min(32, Math.min(canvasW, canvasH) / 8));
    const k = Math.min((canvasW - 2 * margin) / Math.max(1, maxX - minX), (canvasH - 2 * margin) / Math.max(1, maxY - minY));
    force.centerAt((minX + maxX) / 2, (minY + maxY) / 2, durationMs);
    force.zoom(Math.max(0.01, Math.min(4, k)), durationMs);
    refreshHitArea();
  };
  const toImage = async (options?: CaptureOptions): Promise<Blob> => {
    fitView(0);
    await waitOneFrame();
    const source = host.current?.querySelector('canvas');
    if (!source) throw new Error('ActivityGraph.toImage: no canvas to capture (the renderer has not mounted one yet)');
    const captured = renderCapture(source, (width, height) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return canvas;
    }, options);
    return captureToBlob(captured);
  };
  useImperativeHandle(apiRef, () => ({ fitView, toImage }), [reduced, size.width, size.height]);

  const groups = props.groups ?? [];
  // Groups arrive as a fresh array every render; what matters to painting is their content.
  const groupsKey = groups.map(g => `${g.id}\u0000${g.label}\u0000${g.accent ?? ''}\u0000${g.dimmed ? 1 : 0}`).join('\u0001');
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- groupsKey stands for the group list's content
  const dimmedGroups = useMemo(() => new Set(groupsRef.current.filter(g => g.dimmed).map(g => g.id)), [groupsKey]);
  const theme = useMemo(() => resolveGraphTheme(props.theme), [props.theme]);
  const shadows = !reduced && nodes.length <= SHADOW_NODE_LIMIT;
  useEffect(() => { layoutVersion.current++; }, [groupsKey]);

  // Canvas callbacks. Each one is a stable identity that changes exactly when something it draws
  // changes (selection, theme, groups, data...), and force-graph repaints on that change; unrelated
  // renders leave them alone.
  const paintNode = useCallback((n: RuntimeNode, ctx: CanvasRenderingContext2D) =>
    drawNode(n, ctx, selected ?? null, reduced, groupAlpha(n, dimmedGroups), theme, shadows),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- nodes/edges: a data change mutates the runtime nodes in place, and the new identity is what requests the repaint
  [selected, reduced, dimmedGroups, theme, shadows, nodes, edges]);
  const paintLink = useCallback((l: RuntimeEdge, ctx: CanvasRenderingContext2D) => drawLink(l, ctx, selected ?? null, reduced, theme, shadows),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [selected, reduced, theme, shadows, nodes, edges]);
  const paintGroups = useCallback((ctx: CanvasRenderingContext2D) => {
    hulls.current.sync(layoutVersion.current);
    drawGroups(ctx, groupsRef.current, runtime.current.nodes, theme, hulls.current);
  }, [theme]);
  const paintPointerArea = useCallback((n: RuntimeNode, color: string, ctx: CanvasRenderingContext2D) => {
    const { w, h } = box(n); ctx.fillStyle = color; ctx.fillRect(n.x - w / 2, n.y - h / 2, w, h);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hitVersion is the refresh token, not an input
  }, [hitVersion]);
  const hideLabel = useCallback(() => '', []);

  const select = useCallback((node: ActivityNode | null) => {
    setLocalSelected(node?.id ?? null);
    latest.current.onNodeSelect?.(node as ActivityNode<N> | null);
  }, []);

  const handleNodeClick = useCallback((n: RuntimeNode) => {
    select(n.spec);
    const { activated, next } = detectDoubleClick(lastClick.current, n.id, Date.now());
    lastClick.current = next;
    if (activated) latest.current.onNodeActivate?.(n.spec as ActivityNode<N>);
  }, [select]);
  const handleBackgroundClick = useCallback(() => select(null), [select]);

  const handleNodeDrag = useCallback(() => { pointerDragging.current = true; layoutVersion.current++; }, []);
  const handleNodeDragEnd = useCallback((n: RuntimeNode) => {
    const anchored = n.spec.position?.anchored;
    if (anchored) { n.fx = n.homeX; n.fy = n.homeY; }
    // Guided layout: the dropped card is pinned where it landed and only the canvas repaints; nothing is re-placed.
    if (latest.current.layoutMode === 'guided' && !anchored) { n.fx = n.x; n.fy = n.y; n.placed = true; }
    layoutVersion.current++;
    latest.current.onNodeMove?.(n.spec as ActivityNode<N>, { x: anchored ? n.homeX : n.x, y: anchored ? n.homeY : n.y });
    // The card moved: the next grab, a moment later, must find it where it now is.
    pointerDragging.current = false;
    setEngineStops(c => c + 1);
    refreshHitArea();
  }, [refreshHitArea]);
  const handleEngineTick = useCallback(() => { engineRunning.current = true; layoutVersion.current++; }, []);
  const handleEngineStop = useCallback(() => {
    if (latest.current.layoutMode === 'guided') for (const n of runtime.current.nodes) {
      n.fx = n.x; n.fy = n.y; n.placed = true;
    }
    engineRunning.current = false;
    layoutVersion.current++;
    // While a card is dragged the engine stops every other frame; the drop does one refresh instead.
    if (pointerDragging.current) return;
    setEngineStops(c => c + 1);
    refreshHitArea();
  }, [refreshHitArea]);
  const handleZoomEnd = useCallback(() => {
    clearTimeout(zoomTimer.current);
    zoomTimer.current = setTimeout(refreshHitArea, ZOOM_SETTLE_MS);
  }, [refreshHitArea]);

  // Draggable group hulls (guided layout only): clicking and dragging inside a hull's own area,
  // away from any node, moves every member node of that group together, preserving their
  // relative positions. Removes any dangling window listeners if the component unmounts mid-drag.
  useEffect(() => () => {
    if (dragListeners.current) {
      window.removeEventListener('pointermove', dragListeners.current.move);
      window.removeEventListener('pointerup', dragListeners.current.up);
      dragListeners.current = null;
    }
  }, []);

  const screenToGraphPoint = (clientX: number, clientY: number): { x: number; y: number } | undefined => {
    const convert = api.current?.screen2GraphCoords;
    const canvasEl = host.current?.querySelector('canvas');
    if (!canvasEl || typeof convert !== 'function') return undefined;
    const rect = canvasEl.getBoundingClientRect();
    return convert.call(api.current, clientX - rect.left, clientY - rect.top);
  };

  const groupAtPoint = (point: { x: number; y: number }): { group: ActivityGroup; members: RuntimeNode[] } | undefined => {
    if (groups.length === 0) return undefined;
    hulls.current.sync(layoutVersion.current);
    const byGroup = hulls.current.membersOf(runtime.current.nodes, groups);
    // drawGroups renders groups in array order, so a later group's hull paints over an earlier
    // one's where they overlap; hit-testing in reverse matches whichever hull is visually on top.
    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i]!;
      const members = byGroup.get(group.id) ?? [];
      if (members.length > 0 && hitTestShape(hulls.current.shapeOf(group.id, members), point)) return { group, members };
    }
    return undefined;
  };

  const setHostCursor = (cursor: 'default' | 'grab' | 'grabbing') => {
    if (hoverCursor.current === cursor) return;
    hoverCursor.current = cursor;
    if (host.current) host.current.style.cursor = cursor === 'default' ? '' : cursor;
  };

  /** Capture-phase pointerdown on the host div: runs before react-force-graph-2d's own native
   * listeners on the inner canvas/container can start their default pan or node-drag. A point
   * that is on a node, or inside no group's hull, is left completely alone -- propagation
   * continues and the library behaves exactly as it does today. */
  const beginGroupDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (props.layoutMode !== 'guided') return;
    // Feature-detected: an older react-force-graph-2d/force-graph build without
    // screen2GraphCoords simply never attaches this behavior.
    if (typeof api.current?.screen2GraphCoords !== 'function') return;
    if (event.pointerType === 'mouse' && event.button !== 0) return; // left button only; right-click keeps its own menu
    const point = screenToGraphPoint(event.clientX, event.clientY);
    if (!point || pointHitsAnyNode(runtime.current.nodes, point)) return;
    const hit = groupAtPoint(point);
    if (!hit) return;

    // The library's own background-click detection listens on 'pointerdown'/'pointerup' on its
    // inner container -- stopping propagation here (before it ever reaches that element) is
    // enough to suppress it. Its pan (d3-zoom) and node-drag (d3-drag) are both driven by native
    // 'mousedown' listeners attached directly to the canvas, a *separate* event dispatched right
    // after this one for the same physical gesture; the onMouseDownCapture handler below stops
    // that half using the `groupDrag` ref this call is about to set.
    event.stopPropagation();

    const state: GroupDragState = {
      pointerId: event.pointerId,
      group: hit.group,
      members: hit.members.map(m => ({ id: m.id, x: m.x, y: m.y })),
      startX: point.x,
      startY: point.y,
      dragging: false,
    };
    groupDrag.current = state;
    wake(); // the plain onPointerDown handler below never runs for an intercepted gesture
    setHostCursor('grabbing');
    const byId = new Map(runtime.current.nodes.map(n => [n.id, n]));

    const handleMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== state.pointerId) return;
      const p = screenToGraphPoint(moveEvent.clientX, moveEvent.clientY);
      if (!p) return;
      const deltaX = p.x - state.startX, deltaY = p.y - state.startY;
      if (!state.dragging && Math.hypot(deltaX, deltaY) > GROUP_DRAG_THRESHOLD) { state.dragging = true; setDragging(true); }
      if (!state.dragging) return;
      for (const member of state.members) {
        const node = byId.get(member.id);
        if (!node) continue;
        node.x = member.x + deltaX; node.y = member.y + deltaY;
        node.fx = node.x; node.fy = node.y;
      }
      layoutVersion.current++;
    };

    const handleUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== state.pointerId) return;
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      dragListeners.current = null;
      groupDrag.current = null;
      setHostCursor('default');

      if (!state.dragging) {
        // A plain click on hull-covered background: the library's own onBackgroundClick never
        // fired (its pointerdown was intercepted), so replicate its one visible effect here.
        select(null);
        return;
      }
      const positions: { id: string; x: number; y: number }[] = [];
      for (const member of state.members) {
        const node = byId.get(member.id);
        if (!node) continue;
        if (node.spec.position?.anchored) {
          // Matches onNodeDragEnd's existing rule exactly: an anchored node snaps back home and
          // never counts as "moved", group drag or not.
          node.x = node.homeX; node.y = node.homeY; node.fx = node.homeX; node.fy = node.homeY;
        } else {
          node.fx = node.x; node.fy = node.y; node.placed = true;
          positions.push({ id: node.id, x: node.x, y: node.y });
          latest.current.onNodeMove?.(node.spec as ActivityNode<N>, { x: node.x, y: node.y });
        }
      }
      layoutVersion.current++;
      latest.current.onGroupMove?.(state.group, positions);
      setDragging(false);
      refreshHitArea();
    };

    dragListeners.current = { move: handleMove, up: handleUp };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  };

  const selectedNode = selected === null ? undefined : nodes.find(n => n.id === selected);
  return <div ref={host} className={props.className} style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', ...props.style }}
    role="region" tabIndex={0} aria-label={props.ariaLabel ?? 'Activity graph. Arrow keys select nodes; Enter activates the selected node; Escape clears selection; F fits the view.'}
    onPointerDownCapture={beginGroupDrag}
    onMouseDownCapture={event => { if (groupDrag.current) event.stopPropagation(); }}
    onPointerDown={wake}
    onPointerMove={event => {
      if (groupDrag.current) return; // the window-level listeners above are driving the live drag
      if (props.layoutMode !== 'guided' || typeof api.current?.screen2GraphCoords !== 'function' || event.buttons !== 0) { setHostCursor('default'); return; }
      const point = screenToGraphPoint(event.clientX, event.clientY);
      if (!point || pointHitsAnyNode(runtime.current.nodes, point)) { setHostCursor('default'); return; }
      setHostCursor(groupAtPoint(point) ? 'grab' : 'default');
    }}
    onWheel={wake}
    onKeyDown={event => {
      wake();
      if (event.key === 'Escape') { select(null); event.preventDefault(); }
      if (event.key.toLowerCase() === 'f') { fitView(); event.preventDefault(); }
      if (event.key === 'Enter' && selected) {
        const node = nodes.find(n => n.id === selected);
        if (node) props.onNodeActivate?.(node);
        event.preventDefault();
      }
      if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key) && nodes.length) {
        const index = nodes.findIndex(n => n.id === selected), direction = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
        select(nodes[(index + direction + nodes.length) % nodes.length]); event.preventDefault();
      }
    }}>
    {Renderer && <Renderer ref={api} graphData={graph} width={size.width} height={size.height}
      backgroundColor="rgba(0,0,0,0)" nodeCanvasObject={paintNode}
      linkCanvasObject={paintLink}
      onRenderFramePre={paintGroups}
      nodeLabel={hideLabel} linkLabel={hideLabel}
      // Repaint every frame only while something animates or moves; otherwise on change. The hit canvas
      // is repainted on its own schedule (see refreshHitArea), so a still graph costs no frames.
      autoPauseRedraw={!animating && !dragging}
      nodePointerAreaPaint={paintPointerArea}
      onNodeClick={handleNodeClick} onBackgroundClick={handleBackgroundClick}
      onNodeDrag={handleNodeDrag} onNodeDragEnd={handleNodeDragEnd}
      onEngineTick={handleEngineTick} onEngineStop={handleEngineStop} onZoomEnd={handleZoomEnd}
      // Guided cards are all pinned, so one tick finishes the layout: a drop must not restart a hundred-tick simulation.
      d3VelocityDecay={.62} d3AlphaDecay={.035} cooldownTicks={guided || reduced ? 1 : 100} minZoom={.25} maxZoom={2.5} />}
    {loadError && <p role="alert">The graph renderer could not be loaded.</p>}
    <span aria-live="polite" style={{ position:'absolute', width:1, height:1, overflow:'hidden', clipPath:'inset(50%)' }}>
      {selectedNode?.label ?? 'No node selected'}
    </span>
  </div>;
}
