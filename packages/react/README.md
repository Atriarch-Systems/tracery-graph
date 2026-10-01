# @atriarch-systems/tracery-react

`ActivityExplorer`: a composite React explorer (connection status, flow
picker, guided activity graph, inspector, group legend) plus the hooks that
feed it. Built on `@atriarch-systems/tracery-core` (reducers, projection) and
`@atriarch-systems/tracery-visualizer` (the canvas). See
[`../../docs/SPEC.md`](../../docs/SPEC.md) §4 for the full contract; this
README is a usage guide.

```
npm install @atriarch-systems/tracery-react
```

## Embedding: point it at a hub

```tsx
import { ActivityExplorer, useHubSource } from '@atriarch-systems/tracery-react';

function MyPage() {
  const source = useHubSource({
    baseUrl: 'https://tracery.example.com',
    apiKey: 'read-key-for-my-workspace',
    workspace: 'default',
  });

  return (
    <div style={{ height: '100vh' }}>
      <ActivityExplorer source={source} />
    </div>
  );
}
```

`useHubSource` opens `WS /v1/live` (via `@atriarch-systems/tracery-client`'s
`HubClient`, which already resumes from the last cursor it saw with
exponential backoff) and reduces every frame into `Flow`s with
`@atriarch-systems/tracery-core`. If the socket keeps failing -- two consecutive
close/error events -- it falls back to polling `GET
/v1/flows/:id/events?after=` (or, scoped to a trace with no single flow,
`GET /v1/traces/:id/events`, a full refetch each tick since that endpoint has
no `after` parameter). Pass `flow` or `trace` to scope the whole source to
one flow or trace instead of the workspace.

## Embedding: point it at your own in-process journal

```tsx
import { useMemo } from 'react';
import { Journal } from '@atriarch-systems/tracery-core';
import { ActivityExplorer, useJournalSource } from '@atriarch-systems/tracery-react';

function MyPage() {
  const journal = useMemo(() => new Journal({ maxEvents: 20_000 }), []);
  // ... elsewhere: journal.append(events) as your app produces them ...
  const source = useJournalSource(journal);

  return (
    <div style={{ height: '100vh' }}>
      <ActivityExplorer source={source} />
    </div>
  );
}
```

`useJournalSource` re-derives `Flow`s from the journal on a light poll
(default 250ms) since `Journal` has no change notification of its own. It
always computes its first render synchronously, so a journal that is already
populated (for example, `@atriarch-systems/tracery-core/fixtures`'
`sampleTraceEvents`) renders correctly on the very first pass -- including
under `react-dom/server`.

## `ActivityExplorer` props

```ts
interface ActivityExplorerProps {
  source: ActivitySource;                 // from useHubSource or useJournalSource
  initialScope?: Scope;                   // { mode: 'flow' | 'ancestors', flow } | { mode: 'trace', trace }
  catalog?: (node: NodeRecord, flow: Flow) => NodePresentation;
  renderInspector?: (selection: InspectorSelection | null) => ReactNode;
  theme?: ActivityTheme;                  // chrome CSS variables + an optional canvas `graph` palette
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
  // Added in 0.1.2, all optional:
  nodeDetail?: (node: NodeRecord, flow: Flow) => string | undefined;  // the line under a card's title
  nodeFooter?: (node: NodeRecord, flow: Flow) => string | undefined;  // a card's footer line
  showNodeList?: boolean;                 // default true
  nodeListCollapsible?: boolean;          // default false: adds a "Nodes (N)" toggle
  nodeListInitiallyCollapsed?: boolean;   // with nodeListCollapsible, start collapsed
  reducedMotion?: boolean;                // forwarded to the graph; default: the user's OS setting
}
```

New in 0.1.2:

- `nodeDetail` / `nodeFooter` replace a card's detail (default: its latest op
  name) and footer (default: "N ops" or "N errors"). Return `undefined` to keep
  the default for that node. Pass memoised functions: a new function every
  render recomputes every card's text every render. The footer is drawn only
  on cards at least 74 px tall, so set `height` in `catalog` (`NodePresentation`).
- `showNodeList={false}` drops the accessible node list under the graph;
  `nodeListCollapsible` adds a header that collapses it (`data-testid="node-list-toggle"`).
  A collapsed list renders no rows, which also saves work on large graphs.
- A **Fit** button (`data-testid="fit-view"`) in the graph toolbar frames the whole
  graph. Fit padding now covers half a card, so edge cards are no longer cut off.
- Theme variables, each also a `theme` field: `--tracery-border` (`border`, every
  panel and divider line, including the inspector and the node list's new top edge),
  `--tracery-canvas-bg` (`canvasBg`, the graph canvas; default transparent) and
  `--tracery-panel-bg` (`panelBg`, the node list; default transparent). Left unset
  they inherit from your CSS or fall back to the built-in look.
- Dragging a node and live updates are much cheaper (see the visualizer README).

- **Connection status** is a dot + label (`connecting` / `live` /
  `reconnecting` / `polling` / `offline`), `data-testid="connection-status"`.
- **Flow picker** lists flows newest-first with active (`status: 'running'`)
  flows pinned to the top (`orderFlows`/`latestFlows`, exported from
  `./flow-order.js`). "Follow latest" (a checkbox, on by default) keeps the
  explorer's active flow pinned to whichever flow that ordering puts first;
  picking a flow from the list, a deep-linked `initialScope`, or activating a
  node in a different flow's group all turn it off.
- **Scope switch**: This flow / With ancestors / Whole trace
  (`data-testid="scope-flow"` / `scope-ancestors` / `scope-trace`), also
  bound to keys `1`/`2`/`3` while the explorer has focus.
- **Graph**: `ActivityGraph` in `layoutMode="guided"` via `placeBranches`, so
  spawned subgraphs grow beside their spawner and re-render with stable
  positions. Dragged node and group positions survive live updates, "Follow
  latest" switches, and temporarily leaving the scope for the lifetime of the
  explorer. Ancestors and trace scopes share positions for the same actor/node;
  "This flow" keeps manual positions separate per flow. Reloading the page or
  remounting the explorer clears these positions. In trace scope, a **group legend** lists each flow
  (`data-testid="group-legend-item"`, one per `FlowGroup`); clicking a legend
  item jumps the active flow there.
- Because the graph itself is canvas-drawn, each group also gets a small
  accessible node list (`data-testid="node-item"`) alongside it: the same
  click-to-select / double-click-to-drill-in affordance as the canvas cards,
  reachable by keyboard and by automated tests without canvas hit-testing.
- **Activating a node** that belongs to a different flow's group -- by
  double-clicking its canvas card (`onNodeActivate`, also fires on `Enter`
  while a node is selected), double-clicking its entry in the accessible
  node list, or double-clicking a group legend item -- drills the explorer
  into that flow (`{ mode: 'flow', flow }`).
- **Inspector**: the selected node's ops newest-first, each with status,
  timing, `durationMs`, tags, a collapsible pretty-printed JSON view of the
  op's merged context, and its `annotate` timeline entries. Override the
  whole panel with `renderInspector`.
- **Styling** is inline objects reading `var(--tracery-bg|fg|accent|muted|error, <dark default>)`;
  no Tailwind, no stylesheet. Pass `theme` to set those variables on the
  explorer's root element, or set them yourself further up the DOM tree.
  `theme.graph` (a `Partial<GraphTheme>` from `@atriarch-systems/tracery-visualizer`)
  is forwarded to the inner `ActivityGraph` for canvas node/edge/group colors
  -- kept as its own nested field rather than flattened in, since chrome CSS
  variables and canvas colors are different rendering surfaces.

## Theme presets

`THEME_PRESETS` ships four complete, coherent themes -- chrome vars and a
matching `graph` palette together, not one recolored field -- keyed by name
and listed in display order via `PRESET_NAMES`: `dark` (the built-in default,
pixel-identical to passing no `theme`), `light`, `high-contrast` and `ocean`.

```tsx
import { ActivityExplorer, THEME_PRESETS, resolveThemeInput, useHubSource } from '@atriarch-systems/tracery-react';

function MyPage() {
  const source = useHubSource({ baseUrl: 'https://tracery.example.com', apiKey: 'read-key' });
  return <ActivityExplorer source={source} theme={THEME_PRESETS.ocean} />;
}
```

`resolveThemeInput(input)` turns a preset name, an already-built
`ActivityTheme` object, or `undefined` into an `ActivityTheme | undefined` --
an unknown name resolves to `undefined` rather than throwing, so it's safe to
feed straight from a stored setting: `resolveThemeInput(storedPresetName)`.
`undefined` and `THEME_PRESETS.dark` render identically, but are kept
distinct on purpose: `undefined` means "no preference, use the component's
own defaults", while `'dark'` is an explicit, stable choice worth persisting.

## Hooks

```ts
useJournalSource(journal: Journal, options?: { pollIntervalMs?: number }): ActivitySource
useHubSource(options: { baseUrl; apiKey; workspace?; flow?; trace?; maxEvents?; pollIntervalMs?; fetch?; WebSocket? }): ActivitySource
useProjection(source: ActivitySource, scope: Scope, options?: { catalog?; now?; history? }): Projection
```

`ActivitySource` is the shape both source hooks return and what
`ActivityExplorer`/`useProjection` consume:

```ts
interface ActivitySource {
  flows: ReadonlyMap<string, Flow>;
  status: 'connecting' | 'live' | 'reconnecting' | 'polling' | 'offline';
  cursor?: number;
  partial: boolean;   // journal eviction, or a truncated hub snapshot
  error?: string;
}
```

## The feed state machine

`useHubSource`'s WebSocket-vs-polling decision is a pure reducer,
`./feed.js`, kept free of any socket/timer/DOM code specifically so it is
testable without a browser (`tests/feed.test.mjs`):

```ts
import { feedReducer, initialFeedState, reconnectAfter, shouldPoll } from '@atriarch-systems/tracery-react';

let state = initialFeedState();
state = feedReducer(state, { type: 'frame', frame: someSnapshotFrame });   // -> live
state = feedReducer(state, { type: 'disconnect' });                       // -> reconnecting (1st failure)
state = feedReducer(state, { type: 'disconnect' });                       // -> polling (2nd failure)
shouldPoll(state);       // true
reconnectAfter(state);   // cursor to resume from
```

`useHubSource` itself owns the actual `WebSocket` (via
`@atriarch-systems/tracery-client`'s `HubClient.live`, wrapped to count
close/error events) and the poll `setInterval`; the reducer only ever sees
`frame` / `disconnect` / `poll-ok` / `poll-error` / `reset` actions.

## Scope helpers

`./scope.js` derives the `Scope` `project()` wants from the explorer's
(mode, active flow) state, and decides what activating a node should do --
both pure and exported for reuse:

```ts
import { computeScope, activatedFlow, scopeModeForKey } from '@atriarch-systems/tracery-react';

computeScope('trace', 'flow:research-1', flows);   // -> { mode: 'trace', trace: <resolved trace id> }
scopeModeForKey('3');                               // -> 'trace'
activatedFlow(node, 'flow:parent');                 // -> 'flow:research-1' when node.data.flow differs, else null
```

## Development

```
npm run build   # tsc -p tsconfig.json
npm test        # node --test tests/*.test.mjs (runs against dist/, build first)
```

Tests cover: `react-dom/server` rendering `ActivityExplorer` (via
`useJournalSource` with `@atriarch-systems/tracery-core/fixtures`' sample trace)
without throwing, including its flow labels; the feed reducer's full state
machine (snapshot, events, heartbeat, disconnect, reconnect cursor, stale
snapshot -> `truncated`, fallback to polling after two failures, recovery);
`computeScope` in all three modes and `activatedFlow`'s child-group-activate
rule; flow-picker ordering (`orderFlows`/`latestFlows`/`latestFlowId`); and
the theme presets (`THEME_PRESETS.dark` matching `DEFAULT_GRAPH_THEME`/the
chrome defaults field-for-field and rendering identically to no theme,
`resolveThemeInput`'s four input shapes, and an SSR render with a non-dark
preset setting `--tracery-accent`).

See [`../../apps/hub/web`](../../apps/hub/web) for the hosted UI that embeds
this package against a running hub, including a Playwright suite that
exercises the same flow-list / trace-scope / inspector / drill-in behavior
end to end.
