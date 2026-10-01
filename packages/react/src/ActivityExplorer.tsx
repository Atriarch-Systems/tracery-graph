/**
 * The composite explorer (SPEC.md §4): connection status, flow picker
 * (active-first, "follow latest" default), scope switch (This flow / With
 * ancestors / Whole trace, keys 1/2/3), `ActivityGraph` in guided layout, an
 * inspector panel, and a group legend in trace mode. Double-clicking (or
 * `Enter`-activating) a node that belongs to a different flow's group drills
 * into that flow.
 *
 * The graph is canvas-drawn (`@atriarch-systems/tracery-visualizer`), so alongside
 * it this component also renders a small accessible node list per group --
 * the same selection/activation affordance as clicking/double-clicking a
 * card, reachable by keyboard and by automated testing without canvas hit
 * testing (`data-testid="node-item"`).
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityGraph, placeBranches } from '@atriarch-systems/tracery-visualizer';
import type { ActivityGraphHandle, ActivityGroup, Placement } from '@atriarch-systems/tracery-visualizer';
import type { ActivityNode, NodeData, NodePresentation, NodeRecord, Flow, Scope } from '@atriarch-systems/tracery-core';
import type { ReactNode, CSSProperties, Ref } from 'react';
import type { ActivitySource } from './source.js';
import { useProjection } from './useProjection.js';
import { computeScope, scopeModeForKey, activatedFlow, isScopeShortcutTarget, SCOPE_LABELS, type ScopeMode } from './scope.js';
import { latestFlows, latestFlowId } from './flow-order.js';
import { Inspector, type InspectorSelection } from './Inspector.js';
import { withNodeText } from './node-display.js';
import { rootStyle, styles, type ActivityTheme } from './style.js';

/** A share's fixed target (docs/SHARING.md): pass `useShareSource`'s `{ type, id }` straight through. */
export interface LockedTarget {
  readonly type: 'flow' | 'trace';
  readonly id: string;
}

export interface ActivityExplorerProps {
  readonly source: ActivitySource;
  readonly initialScope?: Scope;
  readonly catalog?: (node: NodeRecord, flow: Flow) => NodePresentation;
  readonly renderInspector?: (selection: InspectorSelection | null) => ReactNode;
  readonly theme?: ActivityTheme;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly ariaLabel?: string;
  /**
   * Share-page mode (docs/SHARING.md): hides anything that implies write
   * access or a picker over data the viewer was never given (there is no
   * write action in this component today, but a host page uses this to
   * decide whether to show its own "Share"/"Delete" affordances too) and
   * renders a small "Shared from Tracery Graph · Open in Tracery Graph" footer line.
   */
  readonly readOnly?: boolean;
  /**
   * A share's fixed target (docs/SHARING.md): hides the flow picker
   * sidebar entirely (there is nothing else to pick -- `source.flows` only
   * ever holds this target's data) and limits the scope switch to what
   * that target's data can actually answer -- just `flow` for a
   * flow-target share (no ancestors/trace data was ever sent), or `flow`
   * and `trace` for a trace-target share (every member flow's data is
   * present, so drilling into one is still meaningful; `ancestors` is
   * omitted since a share never carries a parent chain beyond the trace's
   * own known members).
   */
  readonly lockedTarget?: LockedTarget;
  /**
   * Forwarded straight to the inner `ActivityGraph`'s `apiRef`, so a host
   * page can call `.toImage()` (docs/SHARING.md "Image export") or
   * `.fitView()` from outside this component -- e.g. a "Download image"
   * button in a share dialog or the explorer's own header menu.
   */
  readonly graphRef?: Ref<ActivityGraphHandle>;
  /**
   * Reports an individual node's new position after a drag. Manual positions are remembered for this
   * explorer's lifetime, including group drags and nodes that temporarily leave the scope.
   */
  readonly onNodeMove?: (node: ActivityNode<NodeData>, position: { x: number; y: number }) => void;
  /**
   * Forwarded straight to the inner `ActivityGraph`: reports every member's final position once
   * at the end of a whole-group drag (dragging inside a group's hull, away from any node), in
   * addition to that same drag's per-node `onNodeMove` calls.
   */
  readonly onGroupMove?: (group: ActivityGroup, positions: readonly { id: string; x: number; y: number }[]) => void;
  /**
   * Overrides the line under a node's title (default: the name of its latest op). Receives the node's
   * canonical record and the flow it belongs to; return `undefined` to keep the default. Pass a
   * stable (memoised) function: a new one on every render re-labels every node on every render.
   */
  readonly nodeDetail?: (node: NodeRecord, flow: Flow) => string | undefined;
  /**
   * Overrides a node's footer line (default: "N ops" or "N errors"). The footer is drawn only on
   * cards at least 74 px tall, so give the card that height in `catalog`. Return `undefined` to keep
   * the default. Pass a stable (memoised) function.
   */
  readonly nodeFooter?: (node: NodeRecord, flow: Flow) => string | undefined;
  /** Whether to render the accessible node list under the graph. Default `true`. */
  readonly showNodeList?: boolean;
  /** Adds a header to the node list that collapses and expands it. Default `false`. */
  readonly nodeListCollapsible?: boolean;
  /** With `nodeListCollapsible`, start with the list collapsed. Default `false`. */
  readonly nodeListInitiallyCollapsed?: boolean;
  /**
   * Forwarded to the graph: stops pulses, glows and travelling dots and finishes layout in a single
   * step. Default: follow the user's `prefers-reduced-motion` setting.
   */
  readonly reducedMotion?: boolean;
}

const SCOPE_MODES: readonly ScopeMode[] = ['flow', 'ancestors', 'trace'];
const TRACERY_HOMEPAGE = 'https://github.com/Atriarch-Systems/tracery-graph';

function scopeModesFor(lockedTarget: LockedTarget | undefined): readonly ScopeMode[] {
  if (!lockedTarget) return SCOPE_MODES;
  return lockedTarget.type === 'trace' ? ['flow', 'trace'] : ['flow'];
}

/** One row per node, grouped by flow. Memoised so a selection or a still frame does not re-render hundreds of buttons. */
const NodeList = memo(function NodeList(props: {
  readonly groups: readonly { readonly id: string; readonly label: string; readonly nodeIds: readonly string[] }[];
  readonly nodeById: ReadonlyMap<string, ActivityNode<NodeData>>;
  readonly selectedNodeId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onActivate: (node: ActivityNode<NodeData>) => void;
}) {
  const { groups, nodeById, selectedNodeId, onSelect, onActivate } = props;
  return (
    <>
      {groups.map((group) => (
        <details key={group.id} open>
          <summary style={styles.muted}>{group.label}</summary>
          {group.nodeIds.map((id) => {
            const node = nodeById.get(id);
            if (!node) return null;
            return (
              <button
                key={id}
                type="button"
                data-testid="node-item"
                data-node-id={id}
                data-group-id={group.id}
                style={styles.flowItem(id === selectedNodeId)}
                onClick={() => onSelect(id)}
                onDoubleClick={() => onActivate(node)}
              >
                {node.label} <span style={styles.muted}>({node.status ?? 'idle'})</span>
              </button>
            );
          })}
        </details>
      ))}
    </>
  );
});

export function ActivityExplorer(props: ActivityExplorerProps) {
  const { source, initialScope, catalog, renderInspector, theme, className, style, ariaLabel, readOnly, lockedTarget, graphRef, onNodeMove, onGroupMove, nodeDetail, nodeFooter, reducedMotion } = props;
  const showNodeList = props.showNodeList ?? true;
  const nodeListCollapsible = props.nodeListCollapsible ?? false;
  const [nodeListCollapsed, setNodeListCollapsed] = useState(nodeListCollapsible && (props.nodeListInitiallyCollapsed ?? false));
  const availableScopeModes = useMemo(() => scopeModesFor(lockedTarget), [lockedTarget]);

  const [activeFlow, setActiveFlow] = useState<string | undefined>(() => {
    if (lockedTarget) return lockedTarget.type === 'flow' ? lockedTarget.id : undefined;
    return initialScope ? (initialScope.mode === 'trace' ? undefined : initialScope.flow) : undefined;
  });
  const [mode, setMode] = useState<ScopeMode>(() => {
    if (lockedTarget) return lockedTarget.type === 'trace' ? 'trace' : 'flow';
    return initialScope?.mode ?? 'flow';
  });
  const [followLatest, setFollowLatest] = useState(!lockedTarget && initialScope === undefined);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // Every placement made so far, fed back into the next projection so existing cards never move and
  // only new ones are placed. A ref, not state: a live delta must not cost a second render.
  const placement = useRef(new Map<string, Placement>());
  // Keep only explicit user moves here; automatic placements can be discarded when nodes
  // leave the view. Both caches are in-memory and disappear when the explorer unmounts.
  const manualPlacement = useRef(new Map<string, Placement>());

  const ordered = useMemo(() => latestFlows(source.flows), [source.flows]);

  // A share's target (docs/SHARING.md) routinely arrives AFTER this
  // component's first render -- `useShareSource` only knows it once its own
  // `GET .../meta` fetch resolves -- so the `useState` initializers above,
  // which only ever run once, are not enough on their own: without this
  // effect, a `lockedTarget` that shows up on a later render would leave
  // `activeFlow`/`mode` stuck at their pre-share defaults (`undefined`/
  // `'flow'`) forever, and the explorer would sit on "No flow selected".
  // The trace case still needs the separate anchor-resolution effect below
  // (there is no single id to set `activeFlow` to until member flows load).
  useEffect(() => {
    if (!lockedTarget) return;
    setMode(lockedTarget.type === 'trace' ? 'trace' : 'flow');
    if (lockedTarget.type === 'flow') setActiveFlow(lockedTarget.id);
  }, [lockedTarget?.type, lockedTarget?.id]);

  // "follow latest" default: keep the active flow pinned to the newest/most
  // active flow until the user picks one explicitly (SPEC.md §4 flow picker).
  // Never applies to a share's locked target -- there is nothing to "follow".
  useEffect(() => {
    if (!followLatest || lockedTarget) return;
    const latest = latestFlowId(source.flows);
    if (latest !== undefined && latest !== activeFlow) setActiveFlow(latest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followLatest, source.flows, lockedTarget]);

  useEffect(() => {
    if (initialScope?.mode === 'trace' && !lockedTarget) {
      const anchor = [...source.flows.values()].find((f) => f.trace === initialScope.trace);
      if (anchor) setActiveFlow(anchor.id);
    }
    // Runs once: only to resolve an initial trace scope's anchor flow once flows are known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialScope, source.flows.size > 0, lockedTarget]);

  // A trace-target share's data arrives as every member flow, but nothing
  // names a specific one to anchor on the way `initialScope` does -- prefer
  // the flow whose id equals the trace id (the trace root, when it happens
  // to already be known), else whichever member flow shows up first.
  useEffect(() => {
    if (!lockedTarget || lockedTarget.type !== 'trace' || activeFlow !== undefined) return;
    const anchor = source.flows.get(lockedTarget.id) ?? [...source.flows.values()].find((f) => f.trace === lockedTarget.id);
    if (anchor) setActiveFlow(anchor.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockedTarget, source.flows.size > 0, activeFlow]);

  const scope: Scope | undefined = activeFlow !== undefined ? computeScope(mode, activeFlow, source.flows) : undefined;
  const projection = useProjection(source, scope ?? { mode: 'flow', flow: '' }, { catalog });
  const hasScope = scope !== undefined && (scope.mode === 'trace' ? true : source.flows.has(scope.flow));
  // Flow projections use local node IDs; ancestors/trace use actor-qualified IDs. Keep
  // unrelated flows' local IDs separate, while sharing actor placements across follow-latest
  // switches and repeated runs. JSON tuple keys avoid collisions with consumer-supplied IDs.
  const placementKey = (id: string) => JSON.stringify([scope?.mode === 'flow' ? scope.flow : null, id]);

  const guided = useMemo(
    () => {
      const previous = new Map(placement.current);
      for (const node of projection.nodes) {
        const moved = manualPlacement.current.get(placementKey(node.id));
        if (moved && !node.position?.anchored) previous.set(node.id, moved);
      }
      // Supply moved positions before admitting new nodes so branches grow beside their
      // actual parents and collision checks use the user's arrangement.
      const placed = placeBranches(hasScope ? projection.nodes : [], hasScope ? projection.edges : [], previous);
      placement.current = placed.positions;
      return placed;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- placementKey reads the scope, which hasScope/projection already follow
    [hasScope, projection.nodes, projection.edges],
  );

  // Apply the host's `nodeDetail`/`nodeFooter` overrides to the placed nodes.
  const displayNodes = useMemo(
    () => withNodeText(guided.nodes, source.flows, nodeDetail, nodeFooter),
    [guided.nodes, nodeDetail, nodeFooter, source.flows],
  );

  const nodeById = useMemo(() => new Map(displayNodes.map((n) => [n.id, n] as const)), [displayNodes]);
  const graphGroups = useMemo(
    () => projection.groups.map((g) => ({ id: g.id, label: g.label, dimmed: g.flow !== activeFlow })),
    [projection.groups, activeFlow],
  );

  const rememberNodeMove = (node: ActivityNode<NodeData>, position: { x: number; y: number }) => {
    const placed = guided.positions.get(node.id);
    if (placed && !node.position?.anchored) {
      manualPlacement.current.set(placementKey(node.id), { ...placed, ...position });
    }
    onNodeMove?.(node, position);
  };

  const selectedNode: InspectorSelection | null = useMemo(
    () => (selectedNodeId ? nodeById.get(selectedNodeId) ?? null : null),
    [nodeById, selectedNodeId],
  );

  // Merges this component's own handle onto `graph` with whatever `apiRef`
  // a host page passed in (e.g. App.tsx's "Download image" button), so both
  // can call the same `ActivityGraph` instance's `fitView`/`toImage`.
  const internalGraphRef = useRef<ActivityGraphHandle | null>(null);
  const setGraphHandle = useCallback(
    (instance: ActivityGraphHandle | null) => {
      internalGraphRef.current = instance;
      if (typeof graphRef === 'function') graphRef(instance);
      else if (graphRef) (graphRef as { current: ActivityGraphHandle | null }).current = instance;
    },
    [graphRef],
  );

  // First-load framing (task: the graph used to load small and centred in a
  // large empty canvas): once the first projection with any nodes arrives,
  // fit the view exactly once -- never again on later updates, so panning/
  // zooming the user has already done is never yanked out from under them
  // when a flow streams in more nodes. `ActivityGraph` lazy-loads its canvas
  // renderer (`react-force-graph-2d`), so the very first attempt can land
  // before `fitView` has anything to act on yet; a couple of cheap, short
  // retries cover that race without turning this into a recurring re-fit.
  const firstFitRequested = useRef(false);
  useEffect(() => {
    if (firstFitRequested.current || !hasScope || guided.nodes.length === 0) return;
    firstFitRequested.current = true;
    const timers = [0, 200, 600].map((delay) => setTimeout(() => internalGraphRef.current?.fitView(), delay));
    return () => timers.forEach((timer) => clearTimeout(timer));
  }, [hasScope, guided.nodes.length]);

  const fitGraph = useCallback(() => internalGraphRef.current?.fitView(), []);
  const selectNode = useCallback((id: string) => setSelectedNodeId(id), []);

  const pickFlow = (id: string): void => {
    setFollowLatest(false);
    setActiveFlow(id);
    setSelectedNodeId(null);
  };

  const switchMode = (next: ScopeMode): void => {
    if (!availableScopeModes.includes(next)) return;
    setMode(next);
    setSelectedNodeId(null);
  };

  const activate = useCallback((node: ActivityNode<NodeData>): void => {
    if (!activeFlow) return;
    const target = activatedFlow(node, activeFlow);
    if (target) {
      setFollowLatest(false);
      setActiveFlow(target);
      setMode('flow');
      setSelectedNodeId(null);
    } else {
      setSelectedNodeId(node.id);
    }
  }, [activeFlow]);

  return (
    <div
      className={className}
      style={{ ...rootStyle(theme), ...style }}
      // Focusable so `1`/`2`/`3` are reachable without first clicking into a
      // descendant (nothing here is focusable-by-default until a flow/scope
      // button or the graph itself is focused, so bubbling keydowns from
      // `document.body` on first load never reached this handler otherwise).
      tabIndex={0}
      role="group"
      aria-label={ariaLabel ?? 'Tracery Graph activity explorer'}
      onKeyDown={(event) => {
        if (!isScopeShortcutTarget(event.target as { tagName?: string; isContentEditable?: boolean }, event.ctrlKey || event.metaKey || event.altKey)) return;
        const next = scopeModeForKey(event.key);
        if (next) {
          switchMode(next);
          event.preventDefault();
        }
      }}
    >
      <div style={styles.header}>
        {!readOnly && (
          <>
            <span style={styles.statusDot(source.status)} aria-hidden="true" />
            <span style={styles.statusText} data-testid="connection-status">
              {source.status}
              {source.partial ? ' (partial)' : ''}
            </span>
          </>
        )}
        {readOnly && source.partial && (
          <span style={styles.statusText} data-testid="connection-status">partial history</span>
        )}
        {source.error && (
          <span style={{ color: 'var(--tracery-error, #ff6b6b)' }} role="alert">
            {source.error}
          </span>
        )}
        <div style={styles.scopeSwitch} role="tablist" aria-label="Scope">
          {availableScopeModes.map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              data-testid={`scope-${m}`}
              style={styles.scopeButton(mode === m)}
              onClick={() => switchMode(m)}
            >
              {SCOPE_LABELS[m]}
            </button>
          ))}
        </div>
      </div>

      {mode === 'trace' && projection.groups.length > 0 && (
        <div style={styles.legend} data-testid="group-legend">
          {projection.groups.map((group) => {
            const dimmed = group.flow !== activeFlow;
            return (
              <button
                key={group.id}
                type="button"
                data-testid="group-legend-item"
                data-group-id={group.id}
                data-flow-id={group.flow}
                style={styles.legendItem(dimmed)}
                onClick={() => pickFlow(group.flow)}
              >
                <span style={styles.swatch(group.status === 'error' ? 'var(--tracery-error, #ff6b6b)' : 'var(--tracery-accent, #7c9cff)')} />
                {group.label}
              </button>
            );
          })}
        </div>
      )}

      <div style={styles.body}>
        {!lockedTarget && (
          <div style={styles.sidebar} data-testid="flow-picker">
            <div style={styles.sidebarHeading}>Flows</div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', fontSize: 12 }}>
              <input type="checkbox" checked={followLatest} onChange={(e) => setFollowLatest(e.target.checked)} />
              Follow latest
            </label>
            {ordered.map((flow) => (
              <button
                key={flow.id}
                type="button"
                data-testid="flow-picker-item"
                data-flow-id={flow.id}
                data-flow-status={flow.status}
                data-active={flow.id === activeFlow ? 'true' : 'false'}
                style={styles.flowItem(flow.id === activeFlow)}
                onClick={() => pickFlow(flow.id)}
              >
                {flow.label} <span style={styles.muted}>({flow.status})</span>
              </button>
            ))}
            {ordered.length === 0 && <div style={{ ...styles.muted, padding: 8 }}>No flows yet.</div>}
          </div>
        )}

        <div style={styles.graphArea}>
          <div style={styles.graphCanvas}>
            {hasScope ? (
              <ActivityGraph
                nodes={displayNodes}
                edges={projection.edges}
                groups={graphGroups}
                theme={theme?.graph}
                layoutMode="guided"
                reducedMotion={reducedMotion}
                layoutKey={scope ? (scope.mode === 'trace' ? `trace:${scope.trace}` : `${scope.mode}:${scope.flow}`) : 'none'}
                selectedNodeId={selectedNodeId}
                onNodeSelect={(node) => setSelectedNodeId(node?.id ?? null)}
                onNodeActivate={(node) => activate(node as ActivityNode<NodeData>)}
                onNodeMove={rememberNodeMove}
                onGroupMove={onGroupMove}
                ariaLabel={ariaLabel}
                apiRef={setGraphHandle}
              />
            ) : (
              <div style={{ ...styles.muted, padding: 16 }}>No flow selected.</div>
            )}
            {hasScope && (
              <div style={styles.graphToolbar} data-testid="graph-toolbar">
                <button type="button" data-testid="fit-view" style={styles.toolbarButton} aria-label="Fit the graph to the view" onClick={fitGraph}>
                  Fit
                </button>
              </div>
            )}
          </div>

          {hasScope && showNodeList && (
            <div style={styles.nodeList} data-testid="node-list" data-collapsed={nodeListCollapsed ? 'true' : 'false'}>
              {nodeListCollapsible && (
                <button
                  type="button"
                  data-testid="node-list-toggle"
                  aria-expanded={!nodeListCollapsed}
                  style={styles.nodeListToggle}
                  onClick={() => setNodeListCollapsed((collapsed) => !collapsed)}
                >
                  <span aria-hidden="true">{nodeListCollapsed ? '▸' : '▾'}</span> Nodes ({displayNodes.length})
                </button>
              )}
              {!nodeListCollapsed && (
                <NodeList
                  groups={projection.groups}
                  nodeById={nodeById}
                  selectedNodeId={selectedNodeId}
                  onSelect={selectNode}
                  onActivate={activate}
                />
              )}
            </div>
          )}
        </div>

        <div style={styles.inspector}>
          {renderInspector ? renderInspector(selectedNode) : <Inspector selection={selectedNode} />}
        </div>
      </div>

      {readOnly && (
        <div
          data-testid="share-footer"
          style={{
            flex: '0 0 auto',
            padding: '4px 12px',
            fontSize: 11,
            color: 'var(--tracery-muted, #8892a6)',
            borderTop: '1px solid var(--tracery-border, #262a3a)',
            textAlign: 'center',
          }}
        >
          Shared from Tracery Graph ·{' '}
          <a href={TRACERY_HOMEPAGE} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--tracery-accent, #7c9cff)' }}>
            Open in Tracery Graph
          </a>
        </div>
      )}
    </div>
  );
}
