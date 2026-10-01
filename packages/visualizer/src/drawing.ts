import { box, isNodeActive, edgeWidth, intensity, opacity, type RuntimeNode, type RuntimeEdge } from './model.js';
import { DEFAULT_GRAPH_THEME, type GraphTheme } from './theme.js';
const isHex = (color?: string): color is string => /^#[0-9a-f]{6}$/i.test(color ?? '');
const accent = (color: string | undefined, fallback: string) => isHex(color) ? color : fallback;
const errorColor = (status: string | undefined, color: string | undefined, theme: GraphTheme) =>
  status === 'error' ? theme.errorBright : accent(color, theme.nodeAccentFallback);
const short = (s: string, n: number) => s.length > n ? `${s.slice(0, n - 1)}…` : s;
const blend = (gray: string, green: string, amount: number) => {
  const channels = [1, 3, 5].map(i => Math.round(parseInt(gray.slice(i, i + 2), 16) * (1 - amount) + parseInt(green.slice(i, i + 2), 16) * amount));
  return `rgb(${channels.join(',')})`;
};
/** `shadows: false` skips the glow (canvas `shadowBlur` is CPU-expensive); `ActivityGraph` turns it off on large graphs. */
export const drawNode = (node: RuntimeNode, ctx: CanvasRenderingContext2D, selected: string | null, reducedMotion: boolean, groupAlpha = 1, theme: GraphTheme = DEFAULT_GRAPH_THEME, shadows = true) => {
    const now = Date.now(), amount = intensity(node.spec.activity, now), current = amount > 0;
    const active = isNodeActive(node.spec, now);
    const breath = active && !reducedMotion ? (1 + Math.sin(now * Math.PI * 2 / 1800)) / 2 : 0;
    const hot = errorColor(node.spec.status, node.spec.presentation?.accent, theme);
    const error = node.spec.status === 'error';
    const color = error ? blend(theme.errorDim, theme.errorBright, amount) : blend(theme.nodeAccentIdle, accent(node.spec.presentation?.accent, theme.nodeAccentFallback), amount);
    const { w, h } = box(node), x = node.x - w / 2, y = node.y - h / 2;
    ctx.save(); ctx.globalAlpha = opacity(node.spec.activity, now) * groupAlpha;
    if (current && !reducedMotion && shadows) {
      ctx.shadowColor = active ? hot + 'aa' : hot + '35';
      ctx.shadowBlur = active ? 10 + 18 * breath : 8;
    }
    ctx.fillStyle = blend(theme.nodeFillIdle, theme.nodeFillActive, amount);
    ctx.strokeStyle = selected === node.id ? theme.nodeBorderSelected : active ? blend(theme.nodeBorderPulsing, hot, .45 + .55 * breath) : blend(theme.nodeBorderIdle, theme.nodeBorderActive, amount);
    ctx.lineWidth = active ? 1.6 + 1.4 * breath : selected === node.id ? 1.7 : 1;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, node.spec.presentation?.radius ?? 10); ctx.fill(); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = color; ctx.fillRect(x, y + 15, 2.5, h - 30);
    ctx.font = '10px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = blend(theme.labelSubIdle, theme.labelSubBright, amount);
    ctx.fillText(`${node.spec.presentation?.icon ?? ""}  ${node.spec.presentation?.badge ?? ""}`, x + 12, y + 14);
    ctx.font = '600 13px system-ui'; ctx.fillStyle = blend(theme.labelTitleIdle, theme.labelTitleBright, amount);
    ctx.fillText(short(node.spec.label, Math.floor((w - 24) / 7)), x + 12, y + 32);
    ctx.font = '10px system-ui'; ctx.fillStyle = color;
    const summary = active ? 'Working…' : node.spec.detail || 'Ready';
    ctx.fillText(short(summary, 23), x + 12, y + 49);
    if (node.spec.footer && h >= 74) { ctx.fillStyle = color; ctx.fillText(short(node.spec.footer, Math.floor((w - 24) / 6)), x + 12, y + 63); }
    if (node.spec.position?.anchored) { ctx.font = '9px system-ui'; ctx.fillText('●', x + w - 15, y + 14); }
    if (active) {
      ctx.beginPath(); ctx.arc(x + w - 13, y + 31, 3 + breath, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  };

export const drawLink = (link: RuntimeEdge, ctx: CanvasRenderingContext2D, selected: string | null, reducedMotion: boolean, theme: GraphTheme = DEFAULT_GRAPH_THEME, shadows = true) => {
    if (typeof link.source === 'string' || typeof link.target === 'string') return;
    const a = link.source, b = link.target, now = Date.now();
    const kind = link.spec.kind ?? 'call';
    const amount = intensity(link.spec.activity, now), current = amount > 0;
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1;
    const nx = -dy / length, ny = dx / length;
    // Curvature is consumer configuration; opposite directions bend to opposite sides.
    const bend = link.spec.curvature ?? 22;
    const cx = a.id === b.id ? a.x + box(a).w / 2 + Math.max(80, Math.abs(bend)) : (a.x + b.x) / 2 + nx * bend;
    const cy = a.id === b.id ? a.y : (a.y + b.y) / 2 + ny * bend;
    const boundary = (n: RuntimeNode, tx: number, ty: number) => {
      const { w, h } = box(n), vx = tx - n.x, vy = ty - n.y;
      const t = Math.min((w / 2 + 5) / Math.max(Math.abs(vx), .001), (h / 2 + 5) / Math.max(Math.abs(vy), .001));
      return { x: n.x + vx * t, y: n.y + vy * t };
    };
    const start = a.id === b.id ? { x: a.x + box(a).w / 2, y: a.y - 15 } : boundary(a, cx, cy);
    const end = a.id === b.id ? { x: b.x + box(b).w / 2, y: b.y + 15 } : boundary(b, cx, cy);
    const point = (t: number) => ({ x: (1-t)**2*start.x + 2*(1-t)*t*cx + t*t*end.x, y: (1-t)**2*start.y + 2*(1-t)*t*cy + t*t*end.y });
    ctx.save(); ctx.globalAlpha = opacity(link.spec.activity, now);
    const lineColor = kind === 'spawn' ? accent(link.spec.accent, theme.edgeAccentFallback) : blend(theme.edgeLineIdle, accent(link.spec.accent, theme.edgeAccentFallback), amount);
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = kind === 'spawn' ? edgeWidth(link.spec.count ?? 1) + 2.5 : edgeWidth(link.spec.count ?? 1);
    ctx.lineCap = 'round';
    ctx.setLineDash(kind === 'data' ? [6, 4] : []);
    ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.quadraticCurveTo(cx, cy, end.x, end.y); ctx.stroke();
    ctx.setLineDash([]);
    if (kind === 'spawn') {
      // Hollow circle marks the spawning (source) end.
      ctx.save(); ctx.fillStyle = 'transparent'; ctx.strokeStyle = lineColor; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(start.x, start.y, 4, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }
    const angle = Math.atan2(end.y - cy, end.x - cx), arrow = 6 + Math.min(3, (link.spec.count ?? 1));
    ctx.fillStyle = blend(theme.arrowIdle, theme.arrowBright, amount);
    ctx.beginPath(); ctx.moveTo(end.x, end.y);
    ctx.lineTo(end.x - arrow * Math.cos(angle - .45), end.y - arrow * Math.sin(angle - .45));
    ctx.lineTo(end.x - arrow * Math.cos(angle + .45), end.y - arrow * Math.sin(angle + .45)); ctx.closePath(); ctx.fill();
    const t = (now - (link.spec.activity?.updatedAt ?? 0)) / 850;
    if (current && t >= 0 && t <= 1 && !reducedMotion) {
      const p = point(t); ctx.fillStyle = theme.travelingDot; if (shadows) { ctx.shadowColor = theme.travelingDotGlow; ctx.shadowBlur = 10; }
      ctx.beginPath(); ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
    }
    if ((link.spec.count ?? 1) > 1 || link.spec.showLabel || selected === a.id || selected === b.id) {
      const p = point(.5), label = `${(link.spec.label ?? "")} ×${(link.spec.count ?? 1)}`;
      ctx.font = '10px system-ui'; const width = ctx.measureText(label).width + 12;
      ctx.fillStyle = theme.edgeLabelBg; ctx.beginPath(); ctx.roundRect(p.x - width / 2, p.y - 9, width, 18, 5); ctx.fill();
      ctx.fillStyle = blend(theme.edgeLabelTextIdle, theme.edgeLabelTextBright, amount); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(label, p.x, p.y);
    }
    ctx.restore();
  };
