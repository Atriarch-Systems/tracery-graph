/**
 * Inline style object, driven by CSS variables (SPEC.md §4 "Tailwind is not
 * required; styles are inline ... with CSS variables for theming"). No CSS
 * framework, no stylesheet: every rule here is a plain `CSSProperties`
 * object built from `var(--tracery-*, <dark default>)`.
 */
import type { CSSProperties } from 'react';

export interface ActivityThemeVars {
  readonly bg?: string;
  readonly fg?: string;
  readonly accent?: string;
  readonly muted?: string;
  readonly error?: string;
  /** Panel and divider lines (`--tracery-border`): the inspector, sidebar, header and node list edges. */
  readonly border?: string;
  /** Background of the graph canvas (`--tracery-canvas-bg`). Default: transparent (the explorer background). */
  readonly canvasBg?: string;
  /** Background of the node list under the graph (`--tracery-panel-bg`). Default: transparent. */
  readonly panelBg?: string;
}

/**
 * The full `ActivityExplorer` theme: `ActivityThemeVars`' DOM chrome (CSS
 * variables for the header/sidebar/inspector/etc, via `rootStyle`) plus an
 * optional `graph` palette forwarded straight to the inner `ActivityGraph`'s
 * `theme` prop (`@atriarch-systems/tracery-visualizer`'s `GraphTheme`, for canvas
 * node/edge/group colors). The two stay separate types on purpose -- chrome
 * and canvas are different rendering surfaces with different consumers --
 * rather than one flat object mixing CSS variable names with canvas color
 * fields.
 */
export interface ActivityTheme extends ActivityThemeVars {
  readonly graph?: Partial<import('@atriarch-systems/tracery-visualizer').GraphTheme>;
}

const DEFAULTS = {
  bg: '#12141c',
  panel: '#181b26',
  fg: '#e7e9f2',
  accent: '#7c9cff',
  muted: '#8892a6',
  error: '#ff6b6b',
  border: '#262a3a',
} as const;

const v = (name: string, fallback: string): string => `var(--tracery-${name}, ${fallback})`;
/** Every divider line reads `--tracery-border`, so a host themes all panel edges from one variable. */
const border = v('border', DEFAULTS.border);

/** The root element sets the CSS variables (from `theme`, when given) that every other style reads. */
export function rootStyle(theme?: ActivityThemeVars): CSSProperties {
  return {
    ['--tracery-bg' as string]: theme?.bg ?? DEFAULTS.bg,
    ['--tracery-fg' as string]: theme?.fg ?? DEFAULTS.fg,
    ['--tracery-accent' as string]: theme?.accent ?? DEFAULTS.accent,
    ['--tracery-muted' as string]: theme?.muted ?? DEFAULTS.muted,
    ['--tracery-error' as string]: theme?.error ?? DEFAULTS.error,
    // Optional: left unset they inherit from the host's CSS, or fall back to the built-in look.
    ...(theme?.border !== undefined ? { ['--tracery-border' as string]: theme.border } : {}),
    ...(theme?.canvasBg !== undefined ? { ['--tracery-canvas-bg' as string]: theme.canvasBg } : {}),
    ...(theme?.panelBg !== undefined ? { ['--tracery-panel-bg' as string]: theme.panelBg } : {}),
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    minHeight: 0,
    background: v('bg', DEFAULTS.bg),
    color: v('fg', DEFAULTS.fg),
    fontFamily:
      'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    fontSize: 13,
  };
}

export const styles = {
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '8px 12px',
    borderBottom: `1px solid ${border}`,
    flex: '0 0 auto',
  } satisfies CSSProperties,
  statusDot: (status: string): CSSProperties => ({
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: '50%',
    background:
      status === 'live'
        ? v('accent', DEFAULTS.accent)
        : status === 'polling' || status === 'reconnecting' || status === 'connecting'
          ? '#f2c14e'
          : v('error', DEFAULTS.error),
  }),
  statusText: { color: v('muted', DEFAULTS.muted) } satisfies CSSProperties,
  scopeSwitch: { display: 'flex', gap: 4, marginLeft: 'auto' } satisfies CSSProperties,
  scopeButton: (active: boolean): CSSProperties => ({
    padding: '4px 10px',
    borderRadius: 6,
    border: `1px solid ${active ? v('accent', DEFAULTS.accent) : border}`,
    background: active ? v('accent', DEFAULTS.accent) : 'transparent',
    color: active ? DEFAULTS.bg : v('fg', DEFAULTS.fg),
    cursor: 'pointer',
    fontSize: 12,
  }),
  body: { display: 'flex', flex: '1 1 auto', minHeight: 0 } satisfies CSSProperties,
  sidebar: {
    width: 220,
    flex: '0 0 auto',
    borderRight: `1px solid ${border}`,
    overflowY: 'auto',
    padding: 8,
  } satisfies CSSProperties,
  sidebarHeading: {
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: v('muted', DEFAULTS.muted),
    margin: '8px 4px 4px',
  } satisfies CSSProperties,
  flowItem: (active: boolean): CSSProperties => ({
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '6px 8px',
    borderRadius: 6,
    border: 'none',
    background: active ? 'rgba(124,156,255,0.16)' : 'transparent',
    color: v('fg', DEFAULTS.fg),
    cursor: 'pointer',
    fontSize: 12,
  }),
  // A flex *column* (not the plain block the canvas host used to sit in
  // alone): the canvas and the accessible node list below it are now two
  // separately-sized flex children of a box whose own height is fixed by
  // `.body`'s layout, so the node list can never grow past this area's
  // bottom edge and overlap whatever a host page renders below the explorer
  // (its own footer, e.g. `apps/hub/web/src/Footer.tsx`).
  graphArea: { flex: '1 1 auto', minWidth: 0, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' } satisfies CSSProperties,
  graphCanvas: {
    flex: '1 1 auto',
    minHeight: 0,
    position: 'relative',
    overflow: 'hidden',
    background: v('canvas-bg', 'transparent'),
  } satisfies CSSProperties,
  graphToolbar: { position: 'absolute', top: 8, right: 8, display: 'flex', gap: 4, zIndex: 1 } satisfies CSSProperties,
  toolbarButton: {
    padding: '3px 10px',
    borderRadius: 6,
    border: `1px solid ${border}`,
    background: v('panel-bg', DEFAULTS.panel),
    color: v('fg', DEFAULTS.fg),
    cursor: 'pointer',
    fontSize: 12,
  } satisfies CSSProperties,
  nodeListToggle: {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '6px 0',
    border: 'none',
    background: 'transparent',
    color: v('muted', DEFAULTS.muted),
    cursor: 'pointer',
    fontSize: 12,
  } satisfies CSSProperties,
  // Capped and internally scrollable so a long node list shrinks the canvas
  // rather than spilling out of `graphArea`'s bottom edge.
  nodeList: {
    flex: '0 1 auto',
    minHeight: 0,
    maxHeight: '45%',
    overflowY: 'auto',
    padding: '0 12px 8px',
    // A visible edge, so the canvas above ends somewhere the eye can see.
    borderTop: `1px solid ${border}`,
    background: v('panel-bg', 'transparent'),
  } satisfies CSSProperties,
  inspector: {
    width: 320,
    flex: '0 0 auto',
    borderLeft: `1px solid ${border}`,
    overflowY: 'auto',
    padding: 12,
  } satisfies CSSProperties,
  legend: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    padding: '6px 12px',
    borderBottom: `1px solid ${border}`,
    flex: '0 0 auto',
  } satisfies CSSProperties,
  legendItem: (dimmed: boolean): CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '2px 8px',
    borderRadius: 999,
    border: `1px solid ${border}`,
    opacity: dimmed ? 0.5 : 1,
    fontSize: 11,
    cursor: 'pointer',
    background: 'transparent',
    color: v('fg', DEFAULTS.fg),
  }),
  swatch: (color: string): CSSProperties => ({
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: color,
  }),
  muted: { color: v('muted', DEFAULTS.muted) } satisfies CSSProperties,
  opRow: (status: string): CSSProperties => ({
    borderLeft: `3px solid ${status === 'error' ? v('error', DEFAULTS.error) : status === 'running' ? '#f2c14e' : v('accent', DEFAULTS.accent)}`,
    padding: '6px 8px',
    marginBottom: 8,
    background: 'rgba(255,255,255,0.03)',
    borderRadius: 4,
  }),
  pre: {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontSize: 11,
    margin: '4px 0 0',
    color: v('muted', DEFAULTS.muted),
  } satisfies CSSProperties,
  tag: {
    display: 'inline-block',
    fontSize: 10,
    padding: '1px 6px',
    borderRadius: 999,
    border: `1px solid ${border}`,
    marginRight: 4,
    color: v('muted', DEFAULTS.muted),
  } satisfies CSSProperties,
} as const;
