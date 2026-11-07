/**
 * Canvas color theme for `drawNode`/`drawLink`/`drawGroups`. Every field is
 * optional and independent of `NodePresentation.accent`/`ActivityGroup.accent`:
 * a node or group's own explicit accent always wins over the theme's fallback
 * accent fields below (`nodeAccentFallback`/`groupAccentFallback`) -- the
 * theme only supplies what to draw with when the consumer's data has no
 * accent of its own. `DEFAULT_GRAPH_THEME` is the exact current hardcoded
 * look (see `drawing.ts`/`groups.ts` history); passing no theme at all must
 * render pixel-identical to before this contract existed.
 */
export interface GraphTheme {
  /** Left accent bar + detail text color for an idle node (no current activity). */
  readonly nodeAccentIdle: string;
  /** Fallback accent for a node's left accent bar/detail text and pulsing halo when
   * `NodePresentation.accent` is unset. Never overrides an explicit `accent`. */
  readonly nodeAccentFallback: string;
  /** How much of a node's own accent shows on its accent bar and detail text while it is idle, from 0
   * (`nodeAccentIdle` only, the default) to 1 (the full accent). Set it when the accent carries meaning
   * that outlives activity, such as a finished step's state. Not in `DEFAULT_GRAPH_THEME`: unset is 0. */
  readonly nodeAccentIdleMix?: number;
  /** Node card fill, no current activity. */
  readonly nodeFillIdle: string;
  /** Node card fill, fully highlighted/active. */
  readonly nodeFillActive: string;
  /** Node border, idle. */
  readonly nodeBorderIdle: string;
  /** Node border, fully highlighted (blended toward the hot/accent color). */
  readonly nodeBorderActive: string;
  /** Node border while actively running (pulsing), blended with the hot color. */
  readonly nodeBorderPulsing: string;
  /** Node border for the currently selected node. */
  readonly nodeBorderSelected: string;
  /** Sub-text (icon/badge row), idle. */
  readonly labelSubIdle: string;
  /** Sub-text (icon/badge row), fully highlighted/bright. */
  readonly labelSubBright: string;
  /** Title text, idle. */
  readonly labelTitleIdle: string;
  /** Title text, fully highlighted/bright. */
  readonly labelTitleBright: string;
  /** Detail/footer/summary text and pulsing dot when the node has status "error", dim end. */
  readonly errorDim: string;
  /** Detail/footer/summary text and pulsing dot when the node has status "error", bright end;
   * also the fallback accent color used in place of `nodeAccentFallback` for an errored node. */
  readonly errorBright: string;
  /** Edge line, idle (no current activity). */
  readonly edgeLineIdle: string;
  /** Fallback edge accent (line/arrow color source) when `ActivityEdge.accent` is unset. */
  readonly edgeAccentFallback: string;
  /** Arrowhead, idle. */
  readonly arrowIdle: string;
  /** Arrowhead, fully highlighted/bright. */
  readonly arrowBright: string;
  /** Traveling dot fill color, drawn while a call animates along an edge. */
  readonly travelingDot: string;
  /** Traveling dot glow (canvas shadowColor). */
  readonly travelingDotGlow: string;
  /** Edge label pill background. */
  readonly edgeLabelBg: string;
  /** Edge label text, idle. */
  readonly edgeLabelTextIdle: string;
  /** Edge label text, fully highlighted/bright. */
  readonly edgeLabelTextBright: string;
  /** Fallback hull color (fill/stroke/label alpha math applies on top of this) when
   * `ActivityGroup.accent` is unset. Never overrides an explicit group `accent`. */
  readonly groupAccentFallback: string;
}

/** The resolved, current look -- a literal object, not computed at runtime.
 * Consumers can spread over this to build a partial override. */
export const DEFAULT_GRAPH_THEME: GraphTheme = {
  nodeAccentIdle: '#77827d',
  nodeAccentFallback: '#adf17b',
  nodeFillIdle: '#161d1a',
  nodeFillActive: '#17251d',
  nodeBorderIdle: '#343e38',
  nodeBorderActive: '#62834f',
  nodeBorderPulsing: '#62834f',
  nodeBorderSelected: '#e3f3de',
  labelSubIdle: '#78857c',
  labelSubBright: '#91b282',
  labelTitleIdle: '#a1ada4',
  labelTitleBright: '#e6f3e0',
  errorDim: '#a77570',
  errorBright: '#f28b82',
  edgeLineIdle: '#3d4941',
  edgeAccentFallback: '#8bb971',
  arrowIdle: '#65726a',
  arrowBright: '#b9ef95',
  travelingDot: '#d6ffb4',
  travelingDotGlow: '#adf17b',
  edgeLabelBg: '#111a15',
  edgeLabelTextIdle: '#8b988f',
  edgeLabelTextBright: '#c3e6ac',
  groupAccentFallback: '#8bb971',
};

/** Fills every unset field of `partial` with its `DEFAULT_GRAPH_THEME` default. */
export function resolveGraphTheme(partial?: Partial<GraphTheme>): GraphTheme {
  return partial ? { ...DEFAULT_GRAPH_THEME, ...partial } : DEFAULT_GRAPH_THEME;
}
