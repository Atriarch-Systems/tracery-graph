# @atriarch-systems/tracery-visualizer

A React 18/19 component for live activity graphs. One generic node card, configured by the consumer. There are no agent names, node-kind registries, network connections, or invocation reducers in the library.

This is an independent npm package inside Agent Kit. It is not part of the Python wheel and does not add JavaScript dependencies to Python consumers.

```tsx
import { ActivityGraph, type ActivityNode, type ActivityEdge,
  type NodePresentation } from '@atriarch-systems/tracery-visualizer';

// This catalog belongs to the application, not Agent Kit.
const catalog = {
  input: { badge: 'SOURCE', icon: '↔' },
  worker: { badge: 'WORKER', icon: '✳', width: 152, height: 74, accent: '#adf17b' },
} satisfies Record<string, NodePresentation>;

const nodes: ActivityNode<{ operationId: string }>[] = [
  { id: 'source', label: 'Inbox', presentation: catalog.input,
    position: { x: -200, y: 0, anchored: true } },
  { id: 'worker', label: 'Research', detail: 'Reading sources',
    presentation: catalog.worker, status: 'running',
    activity: { highlighted: true }, data: { operationId: 'call-123' } },
];
const edges: ActivityEdge[] = [
  { id: 'source-worker', source: 'source', target: 'worker',
    label: 'invoke', count: 3, activity: { highlighted: true } },
];

<div style={{ height: 600 }}>
  <ActivityGraph nodes={nodes} edges={edges}
    onNodeSelect={node => console.log(node?.data)} />
</div>
```

## Ownership

The consumer owns its node catalog, stable IDs, domain events, aggregation/counts, request selection, retained history, error meanings and inspector content. It supplies readonly node and edge arrays. The visualizer owns canvas drawing, force layout, anchoring, selection feedback, animation and camera controls. Force-engine positions and mutated edge endpoints stay inside private wrappers; consumer objects are never mutated.

`ActivityNode<Data>`, `ActivityEdge<Data>`, `ActivityGroup`, `NodePresentation`, `Activity`, `ActivityGraphProps` and `ActivityGraphHandle` are exported. `./types` is a renderer-free import. `VISUALIZER_CONTRACT_VERSION` is 3; it versions the presentation contract, not any WebSocket protocol. The data parameter lets each application retain strongly typed inspector data.

All times are epoch milliseconds. `highlighted` lights an item; `completedAt` fades that highlight to gray; `removedAt` fades it out. The application removes expired items from its arrays. `updatedAt` animates a call traveling along an edge. Distinct edge IDs preserve incoming/outgoing and different relationship counts. Edge curvature, labels and accent are caller configuration. Different node types are presets of the same card, not renderer subclasses.

Executing nodes pulse with a breathing border and halo. `active` defaults to `status === 'running'`; set it explicitly to preserve an error state while another operation on the same node is still executing. Completed or unhighlighted nodes never pulse. Reduced motion keeps a static active border and indicator.

Give the host a nonzero height. Supply `apiRef` for `fitView()`, `view` for initial framing, and `layoutKey` to reset remembered positions between isolated workspaces. Controlled selection uses `selectedNodeId` and `onNodeSelect`. `onNodeMove` reports drag positions without mutating application state; `onGroupMove` reports a whole-group drag the same way — see "Draggable groups" below. `onNodeActivate` reports a double-click or an Enter keypress on the selected node — see "Groups and traces" below. Arrow keys select nodes, Enter activates the selected node, Escape clears, and F fits the view. Reduced motion follows system settings or an explicit prop. Drawing pauses after settling/fading and while hidden/offscreen.

The renderer is loaded only in a browser, so importing the package during SSR is safe. Fonts use system-ui and no global stylesheet is installed. Consumers can freely wrap the component with their own toolbar, inspector and overlays.

## Development and consumption

```sh
npm install
npm run build
npm test
npm pack
```

Install the resulting tarball into a consumer with `npm install ./vendor/atriarch-tracery-visualizer-0.3.0.tgz`. The package includes compiled ESM and TypeScript declarations. Local consumers can use this artifact without sibling-repository source imports; registry publishing is a separate action. Virali's prototype is the first consumer; Saga can provide its own catalog and adapter using the same exported contract.

Tests cover frozen consumer input, stable layout across updates, engine array isolation, anchors, edge-first streams, separate directed relationships, removed nodes, duplicate IDs, lifecycle transitions, group hulls (small-group bounding rect vs. convex hull, dimmed alpha, empty groups), group hull hit-testing (`hitTestGroup` against the same padded-rect/convex-hull geometry `drawGroupHull` draws, including the concave-gap and boundary cases, and a regression test pinning both to the one shared `groupHullShape` function), dashed `data` edges vs. thicker `spawn` edges, `placeBranches` ignoring `data` edges as a parent, the pure double-click/activate window helper, and the `GraphTheme` contract (every semantic color slot, no-theme-vs-`DEFAULT_GRAPH_THEME` equivalence, and a node/group's own `accent` still beating the theme's fallback). Draggable-group interaction (capture-phase interception, live drag, click-vs-drag threshold, the individual-drag/group-drag coexistence) is covered end-to-end by `apps/hub/web`'s Playwright suite, since it needs a live pointer/DOM, not this package's Node-based tests.

## Performance notes (0.3.2)

- The hit (pointer) canvas is refreshed straight after a drop, a settle and a
  pan or zoom, so a card dropped somewhere can be grabbed there at once
  (force-graph otherwise repaints it at most every 800 ms).
- The canvas repaints every frame only while something pulses, fades or moves
  (`autoPauseRedraw`); a still graph costs no frames and its frame loop pauses
  once the layout engine has stopped. The loop is never paused mid-cooldown.
- In `layoutMode="guided"` a drop pins the card and repaints; it does not
  restart the force simulation (`cooldownTicks` is 1, the collision force is off).
- A data-only update (labels, status, activity) keeps the existing graph and
  repaints; only an added or removed node or edge hands the renderer a new
  graph. Existing cards never move.
- Canvas callbacks keep stable identities, group hulls are cached per layout
  version, and the glow (`shadowBlur`) is not drawn when `reducedMotion` is set or the
  graph has more than 150 nodes.
- `fitView` pads by half a card plus a margin (capped at a quarter of the canvas).

## Canvas theming

Every canvas color -- node fills/borders/text, edge lines/arrows/labels, the
traveling-call dot, and group hull fallback colors -- comes from a
`GraphTheme`, passed as `Partial<GraphTheme>` on `ActivityGraphProps.theme`.
Unset fields fall back to `DEFAULT_GRAPH_THEME` (the exact look you get by
omitting `theme` entirely), so a partial override only touches what it names:

```tsx
import { ActivityGraph, DEFAULT_GRAPH_THEME, type GraphTheme } from '@atriarch-systems/tracery-visualizer';

const oceanGraph: Partial<GraphTheme> = {
  ...DEFAULT_GRAPH_THEME,
  nodeAccentFallback: '#3fc6ff',
  nodeFillActive: '#123246',
  edgeAccentFallback: '#3fc6ff',
  travelingDot: '#c8f2ff',
};

<ActivityGraph nodes={nodes} edges={edges} theme={oceanGraph} />;
```

A node's own `presentation.accent` and a group's own `accent` always win over
the theme's fallback accent fields (`nodeAccentFallback`/`groupAccentFallback`)
-- the theme only supplies a color for the case where the consumer's data
supplied none. `resolveGraphTheme(partial?)` (used internally, and available
to consumers building layered themes) fills in every unset field explicitly.

## Guided placement

`placeBranches(nodes, edges, previousPositions)` returns new node positions and a
position map to pass to the next update. It places new cards beside their first
observed parent and preserves the slots of existing cards. Consumer-owned
`layout` hints can specify `parentId`, a vertical `lane` (90 units per lane),
and a `leaf`/`group` for compact ordered siblings. Root anchors form a left column.
The helper does not interpret agent kinds or treat repeated/return edges as
new parents. Missing parents and cycles still produce finite positions.

Use the result with `layoutMode="guided"`. Established cards retain their
positions, including manually arranged cards; links do not exert force. The
normal force layout remains the default. Reset the position map and change
`layoutKey` when switching layout modes. The consumer decides whether to pan
or fit a growing graph. The normal force layout remains available for applications that prefer free movement.

`placeBranches` picks a node's placement parent from `node.layout?.parentId`, else the first
edge whose `target` is that node. Edges with `kind: 'data'` are skipped when looking for a
parent (a data dependency is not a call chain); `'spawn'` edges (and the default `'call'`) are
valid parents.

## Groups and traces

`ActivityNode.group` and `ActivityGraphProps.groups` draw a presentation-only cluster: a rounded
hull behind a group's member cards, with the group's `label` at its top-left corner. Groups never
feed into force layout or `placeBranches`; two nodes in the same group are laid out exactly as if
`group` were absent, and the hull is drawn under them from the current node positions each frame.

```tsx
<ActivityGraph nodes={nodes} edges={edges} groups={[
  { id: 'trace-child-7', label: 'Subagent: pricing lookup', accent: '#8bb971' },
  { id: 'trace-child-8', label: 'Subagent: inventory check', dimmed: true },
]} />
```

A one- or two-member group draws a padded, rounded bounding rectangle (a true hull is a
visually thin sliver at that size); three or more members draw a rounded convex hull around
the padded card boxes. `dimmed: true` renders that group's hull and every member node at 45%
alpha — use it to recede ancestor flows behind the flow in focus. A group with no current
members draws nothing.

### Draggable groups

In `layoutMode="guided"` (the only mode where node positions are pinned at all), clicking and
dragging inside a group's hull — anywhere in its padded background, away from every node —
moves every member of that group together, preserving their positions relative to each other.
A click that lands on a node instead is never hijacked: individual nodes keep dragging exactly
as before, independently, whether or not they belong to a group, and a group drag never blocks
a later individual drag or vice versa. In `layoutMode="force"` this does nothing extra; hulls
stay non-interactive and panning is unaffected. While the pointer hovers a hull's background in
guided mode the cursor shows `grab`, and `grabbing` once a drag actually starts, so the
affordance is discoverable without reading this section. A plain click (no movement past a
small threshold) on hull-covered background deselects the current node, matching a click on
truly empty background.

```tsx
<ActivityGraph nodes={nodes} edges={edges} layoutMode="guided" groups={groups}
  onNodeMove={(node, position) => savePosition(node.id, position)}
  onGroupMove={(group, positions) => {
    for (const p of positions) savePosition(p.id, p);
  }} />
```

`onGroupMove(group, positions)` fires once, at the end of a successful group drag, with every
moved member's final `{ id, x, y }`. Every one of those members also gets its own `onNodeMove`
call in the same shape an individual drag already produces (an anchored member snaps back to
its home position instead, exactly like an anchored node's own individual drag, and is excluded
from both callbacks since it never actually moved) — `onGroupMove` is additional, not a
replacement, so existing `onNodeMove`-based persistence needs no changes to pick up a whole
group's move. It is optional; omit it and a group drag behaves like a bundle of individual
drags with nothing extra to observe.

`ActivityEdge.kind` distinguishes three relationships, default `'call'`. `'data'` draws a dashed
line and is excluded from `placeBranches` parent selection and from force-link pull. `'spawn'`
draws thicker in the edge's accent color with a small hollow circle at the source end — the
convention for "this flow spawned that one" — and, like `'data'`, gets force-link strength 0 so
spawned subgraphs don't get yanked back toward their spawner.

`ActivityGraphProps.onNodeActivate` fires with the node when a user double-clicks it (two
`onNodeClick`s on the same node within 350ms; react-force-graph-2d has no native dblclick) or
presses Enter while that node is selected. A trace explorer can use it to jump into a spawned
child flow's group.

## License

This activity visualizer package is licensed under the
[Apache License, Version 2.0](./LICENSE). Copyright 2026 Atriarch Systems.
This grant applies to this package's own code and documentation; other Agent
Kit packages have their own terms.

Apache-2.0 permits use, modification, redistribution, and commercial use,
provided the `LICENSE` and `NOTICE` files are retained in copies or
substantial portions of the software, and it includes an express patent
grant from contributors to users. The software is provided as is, without
warranty, subject to the license's terms. No visible application badge is
required.

The graph engine is [React Force Graph](https://github.com/vasturiano/react-force-graph)
by Vasco Asturiano (MIT). This package also uses
[D3 Force](https://github.com/d3/d3-force) by Mike Bostock (ISC).
Dependencies remain under their respective licenses; preserve applicable upstream
notices when distributing them. These acknowledgments do not replace their licenses.

## Support

☕ Tracery Graph is free and open source. If it saves you time, [buy me a coffee](https://ko-fi.com/demonslyr).
