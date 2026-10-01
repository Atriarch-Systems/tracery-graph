/**
 * Drag performance and hit-test freshness for the canvas explorer (U11).
 *
 * Runs the real built hosted UI (`vite preview`) with the fixture trace over a mocked
 * hub WebSocket, drags a node five times in a row and asserts that
 *  - each drag grabs the node at the place the previous drag dropped it (the hit canvas is
 *    refreshed immediately, not on a throttle), and
 *  - no single long task blocks the main thread for more than 200 ms.
 * Nodes are canvas-drawn, so they are located by scanning the canvas for the card fill colour.
 */
import { test, expect, type Page } from '@playwright/test';
import { preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleTraceEvents } from '@atriarch-systems/tracery-core/fixtures';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '..');
const PORT = 4332;
const BASE_URL = `http://localhost:${PORT}`;
const MOCK_SESSION = { baseUrl: 'http://mock-hub.local', apiKey: 'test-key', workspace: 'default' };

const storedEvents = sampleTraceEvents.map((event, index) => ({ ...event, workspace: 'default', cursor: index + 1, receivedAt: event.ts }));
const snapshotFrame = { type: 'snapshot', cursor: storedEvents.length, events: storedEvents, truncated: false };

let server: PreviewServer;
test.beforeAll(async () => {
  server = await preview({ root: webRoot, base: '/ui/', preview: { port: PORT, strictPort: true } });
});
test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    const httpServer = server.httpServer;
    if (!httpServer) return resolve();
    httpServer.close((err) => (err ? reject(err) : resolve()));
  });
});

async function prime(page: Page, initial: unknown = snapshotFrame): Promise<void> {
  await page.addInitScript(
    ({ session, frame }) => {
      window.sessionStorage.setItem('atriarch-tracery-hub-session', JSON.stringify(session));
      class MockWebSocket extends EventTarget {
        static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
        readyState = 0;
        url: string;
        constructor(url: string) {
          super();
          this.url = url;
          (window as unknown as { __sendTraceryFrame: (f: unknown) => void }).__sendTraceryFrame = (next) => { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(next) })); };
          setTimeout(() => {
            this.readyState = 1;
            this.dispatchEvent(new Event('open'));
            this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }));
          }, 0);
        }
        send(): void {}
        close(): void { this.readyState = 3; this.dispatchEvent(new Event('close')); }
      }
      (window as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
      // Long-task recorder (main-thread blocks).
      const tasks: number[] = [];
      (window as unknown as { __longTasks: number[] }).__longTasks = tasks;
      try {
        new PerformanceObserver((list) => { for (const e of list.getEntries()) tasks.push(e.duration); }).observe({ type: 'longtask', buffered: true });
      } catch { /* longtask unsupported */ }
    },
    { session: MOCK_SESSION, frame: initial },
  );
  await page.goto(`${BASE_URL}/ui/`);
}

type Box = { cx: number; cy: number; w: number; h: number };

/** Finds node cards on the canvas: connected blobs of the card fill colour. Page (client) coordinates. */
async function findCards(page: Page): Promise<Box[]> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas) return [];
    const rect = canvas.getBoundingClientRect();
    const probe = document.createElement('canvas');
    probe.width = canvas.width; probe.height = canvas.height;
    const pctx = probe.getContext('2d')!;
    pctx.drawImage(canvas, 0, 0);
    const { data, width, height } = pctx.getImageData(0, 0, probe.width, probe.height);
    const CELL = 8;
    const cols = Math.ceil(width / CELL), rows = Math.ceil(height / CELL);
    const hit = new Uint8Array(cols * rows);
    // Card fill (idle #161d1a / active #17251d); the canvas background is transparent.
    for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4;
      if (data[i + 3] > 200 && data[i] >= 20 && data[i] <= 32 && data[i + 1] >= 27 && data[i + 1] <= 50 && data[i + 2] >= 24 && data[i + 2] <= 36 && data[i + 1] - data[i] >= 5) hit[Math.floor(y / CELL) * cols + Math.floor(x / CELL)] = 1;
    }
    const seen = new Uint8Array(cols * rows);
    const out: { cx: number; cy: number; w: number; h: number }[] = [];
    const scale = rect.width / width;
    for (let c = 0; c < cols * rows; c++) {
      if (!hit[c] || seen[c]) continue;
      const stack = [c]; seen[c] = 1;
      let minC = cols, maxC = 0, minR = rows, maxR = 0, n = 0;
      while (stack.length) {
        const k = stack.pop()!; n++;
        const kc = k % cols, kr = Math.floor(k / cols);
        minC = Math.min(minC, kc); maxC = Math.max(maxC, kc); minR = Math.min(minR, kr); maxR = Math.max(maxR, kr);
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nc = kc + dc, nr = kr + dr;
          if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
          const nk = nr * cols + nc;
          if (hit[nk] && !seen[nk]) { seen[nk] = 1; stack.push(nk); }
        }
      }
      if (n < 6) continue;
      out.push({
        cx: rect.left + ((minC + maxC + 1) / 2) * CELL * scale, cy: rect.top + ((minR + maxR + 1) / 2) * CELL * scale,
        w: (maxC - minC + 1) * CELL * scale, h: (maxR - minR + 1) * CELL * scale,
      });
    }
    return out;
  });
}

const nearest = (boxes: Box[], x: number, y: number): Box => boxes.reduce((a, b) => (Math.hypot(a.cx - x, a.cy - y) <= Math.hypot(b.cx - x, b.cy - y) ? a : b));

test.use({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: Number(process.env.DSF ?? 2) });

test('a node can be dragged five times in a row, each grab at its new position, with no long task over 200 ms', async ({ page }) => {
  await prime(page);
  await expect(page.getByTestId('flow-picker-item').first()).toBeVisible();
  const canvas = page.locator('canvas').first();
  await expect(canvas).toBeVisible();
  await expect.poll(async () => (await findCards(page)).length, { timeout: 10_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(1500); // initial fit + cooldown
  const mid = { x: 237 + 818 / 2, y: 85 + 684 / 2 };
  await page.mouse.move(mid.x, mid.y);
  for (let k = 0; k < 2; k++) { await page.mouse.wheel(0, 300); await page.waitForTimeout(80); }
  await page.waitForTimeout(600);


  const canvasBox = (await canvas.boundingBox())!;
  const cards = await findCards(page);
  // Drag the card nearest the middle of the canvas; the others are bystanders that must stay put.
  const target = nearest(cards, canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
  const bystanders = cards.filter((c) => c !== target && Math.hypot(c.cx - target.cx, c.cy - target.cy) > 40);
  expect(bystanders.length).toBeGreaterThan(0);
  let at = { x: target.cx, y: target.cy };
  const steps = [{ dx: 260, dy: 90 }, { dx: -240, dy: 120 }, { dx: 250, dy: -150 }, { dx: -260, dy: -60 }, { dx: 240, dy: 130 }];

  // Drop and regrab straight away at the drop point, as a person does. The grab must land on the
  // node at its new position (a stale hit canvas would pan the whole graph instead).
  for (const step of steps) {
    const to = { x: at.x + step.dx, y: at.y + step.dy };
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + step.dx / 2, at.y + step.dy / 2, { steps: 6 });
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
    at = to;
  }
  await page.waitForTimeout(300);

  const after = await findCards(page);
  const moved = nearest(after, at.x, at.y);
  expect(Math.hypot(moved.cx - at.x, moved.cy - at.y), 'the dragged node ends where the last drag dropped it').toBeLessThan(25);
  for (const b of bystanders) {
    const same = nearest(after.filter((c) => c !== moved), b.cx, b.cy);
    expect(Math.hypot(same.cx - b.cx, same.cy - b.cy), 'bystander cards did not pan or move: every grab picked up the node').toBeLessThan(6);
  }

  const longTasks = await page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks);
  expect(Math.max(0, ...longTasks), `long tasks (ms): ${longTasks.join(', ')}`).toBeLessThan(200);
});

// --- a large, live graph -----------------------------------------------------------------------

const BIG_NODES = Number(process.env.BIG_NODES ?? 320);
const CPU_RATE = Number(process.env.CPU_RATE ?? 4);
const T0 = 1_700_000_000_000;
const actor = { id: 'agent:big', name: 'Big', kind: 'agent' };

/** A deterministic binary tree of ops, one node each; every fifth node is still running. */
function bigEvents(): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  let cursor = 0;
  const push = (event: Record<string, unknown>) => events.push({ v: 1, ...event, workspace: 'default', cursor: ++cursor, receivedAt: event.ts });
  for (let i = 0; i < BIG_NODES; i++) {
    const parent = i === 0 ? {} : { parentOp: `op:${Math.floor((i - 1) / 2)}`, parentNode: `node:${Math.floor((i - 1) / 2)}` };
    push({ id: `evt-${i}-s`, ts: T0 + i * 100, flow: 'flow:big', op: `op:${i}`, node: `node:${i}`, type: 'start', name: 'tool.step', kind: 'tool', label: `Step ${i}`, root: i === 0, actor, ...parent });
    if (i % 5 !== 4) push({ id: `evt-${i}-e`, ts: T0 + i * 100 + 50, flow: 'flow:big', op: `op:${i}`, node: `node:${i}`, type: 'end', name: 'tool.step', status: 'success', durationMs: 50 });
  }
  return events;
}

test('dragging nodes of a large live graph stays responsive while events stream in', async ({ page }) => {
  test.setTimeout(120_000);
  const events = bigEvents();
  await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });
  await prime(page, { type: 'snapshot', cursor: events.length, events, truncated: false });
  await expect(page.getByTestId('flow-picker-item').first()).toBeVisible();
  const canvas = page.locator('canvas').first();
  await expect.poll(async () => (await findCards(page)).length, { timeout: 15_000 }).toBeGreaterThan(5);
  await page.waitForTimeout(2000);

  // A live delta every 250 ms: an update on a random running node, and now and then a new leaf.
  await page.evaluate(({ count, t0 }) => {
    const w = window as unknown as { __sendTraceryFrame: (f: unknown) => void; __frameGaps: number[] };
    let cursor = 100_000, next = count, i = 0;
    w.__frameGaps = [];
    let last = performance.now();
    const tick = () => { const now = performance.now(); w.__frameGaps.push(now - last); last = now; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    setInterval(() => {
      i++;
      const events: Record<string, unknown>[] = [];
      const running = 4 + 5 * (i % Math.floor((count - 4) / 5));
      events.push({ v: 1, id: `live-${i}-u`, ts: t0 + 1_000_000 + i * 250, flow: 'flow:big', op: `op:${running}`, node: `node:${running}`, type: 'update', name: 'tool.step', context: { i }, workspace: 'default', cursor: ++cursor, receivedAt: t0 });
      if (i % 8 === 0) {
        const n = next++;
        events.push({ v: 1, id: `live-${i}-n`, ts: t0 + 1_000_000 + i * 250, flow: 'flow:big', op: `op:${n}`, node: `node:${n}`, type: 'start', name: 'tool.step', kind: 'tool', label: `Step ${n}`, parentOp: `op:${n % count}`, parentNode: `node:${n % count}`, actor: { id: 'agent:big', name: 'Big', kind: 'agent' }, workspace: 'default', cursor: ++cursor, receivedAt: t0 });
      }
      w.__sendTraceryFrame({ type: 'events', cursor, events });
    }, 250);
  }, { count: BIG_NODES, t0: T0 });

  // Measure the interaction only, not the page load.
  await page.evaluate(() => { const w = window as unknown as { __longTasks: number[]; __frameGaps: number[] }; w.__longTasks.length = 0; w.__frameGaps.length = 0; });
  const canvasBox = (await canvas.boundingBox())!;
  const cards = await findCards(page);
  const target = nearest(cards, canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
  let at = { x: target.cx, y: target.cy };
  const steps = [{ dx: 60, dy: 30 }, { dx: -50, dy: 40 }, { dx: 40, dy: -50 }, { dx: -60, dy: -20 }, { dx: 30, dy: 40 }];
  for (const step of steps) {
    const to = { x: at.x + step.dx, y: at.y + step.dy };
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + step.dx / 2, at.y + step.dy / 2, { steps: 8 });
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    at = to;
  }
  await page.waitForTimeout(500);

  const longTasks = await page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks);
  const blocked = Math.round(longTasks.reduce((a, b) => a + b, 0));
  const worst = Math.round(Math.max(0, ...longTasks));
  console.log(`drag on ${BIG_NODES} nodes at ${CPU_RATE}x CPU: ${longTasks.length} long tasks, ${blocked} ms blocked, worst ${worst} ms`);
  await page.screenshot({ path: '../../../out/r1-u11/big.png' });
  expect(worst, `no single long task over 200 ms (tasks: ${longTasks.map(Math.round).join(', ')})`).toBeLessThan(200);
  // Drawing hundreds of glowing cards and repainting the hit canvas on every render kept the main thread
  // busy for seconds here (8 s or more before the fix, 1 to 4 s after); the budget sits well between.
  expect(blocked, 'main-thread time spent in long tasks during the drags').toBeLessThan(6000);
});

// --- bounds -------------------------------------------------------------------------------------

test('the node list has a visible top edge and the Fit button frames every card inside the canvas', async ({ page }) => {
  await prime(page);
  await expect(page.getByTestId('flow-picker-item').first()).toBeVisible();
  await page.getByTestId('scope-trace').click();
  const canvas = page.locator('canvas').first();
  await expect.poll(async () => (await findCards(page)).length, { timeout: 10_000 }).toBeGreaterThan(0);

  const nodeList = page.getByTestId('node-list');
  await expect(nodeList).toBeVisible();
  const edge = await nodeList.evaluate((el) => { const s = getComputedStyle(el); return { width: s.borderTopWidth, style: s.borderTopStyle }; });
  expect(edge.style).toBe('solid');
  expect(parseFloat(edge.width)).toBeGreaterThanOrEqual(1);

  // Zoom in and pan away so cards are cut off, then ask for a fit.
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let k = 0; k < 6; k++) { await page.mouse.wheel(0, -400); await page.waitForTimeout(60); }
  await page.getByTestId('fit-view').click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: '../../../out/r1-u11/fit.png' });

  const cards = await findCards(page);
  expect(cards.length).toBeGreaterThan(2);
  for (const card of cards) {
    expect(card.cx - card.w / 2, 'card left edge inside the canvas').toBeGreaterThan(box.x);
    expect(card.cx + card.w / 2, 'card right edge inside the canvas').toBeLessThan(box.x + box.width);
    expect(card.cy - card.h / 2, 'card top edge inside the canvas').toBeGreaterThan(box.y);
    expect(card.cy + card.h / 2, 'card bottom edge inside the canvas').toBeLessThan(box.y + box.height);
  }
});
