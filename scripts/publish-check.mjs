#!/usr/bin/env node
/**
 * Publish readiness check (docs/PUBLISHING.md "What publish:check proves").
 *
 * Proves that the five npm packages this repo publishes actually work once
 * they leave the workspace: builds everything, `npm pack`s
 * @atriarch-systems/tracery-{core,visualizer,client,react,hub}, installs all five
 * tarballs at once into a brand-new temp project (so internal
 * "@atriarch-systems/..." dependencies resolve to each other's tarball instead of
 * the npm registry -- see docs/PUBLISHING.md for why every internal
 * dependency needs a real semver range rather than "*"), then from that temp
 * project only (no workspace imports, no relative paths back into this
 * repo):
 *
 *   (a) imports @atriarch-systems/tracery-core and @atriarch-systems/tracery-client
 *       directly, and server-renders @atriarch-systems/tracery-react's
 *       ActivityExplorer (which pulls in @atriarch-systems/tracery-visualizer) over
 *       tracery-core's own fixtures via react-dom/server;
 *   (b) starts the hub with `npx tracery-hub` (no env beyond a random port),
 *       and confirms GET /v1/info reports `auth: "none"` and GET /ui/
 *       serves the real hosted UI (not a "UI not built" placeholder);
 *   (c) runs a from-tarballs equivalent of scripts/demo.mjs against that
 *       hub: a parent flow spawning two child flows, resolved into one
 *       trace, observed live over WS /v1/live.
 *
 * Usage: `node scripts/publish-check.mjs`, or `npm run publish:check`.
 * Exits non-zero if any step fails. Always cleans up the temp project, the
 * packed tarballs, and the hub process it started, even on failure.
 */
import { spawnSync, spawn, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const PACKAGES = [
  'packages/core',
  'packages/visualizer',
  'packages/client',
  'packages/react',
  'apps/hub',
];

// ---------------------------------------------------------------------------
// PASS/FAIL bookkeeping (same shape as scripts/demo.mjs)
// ---------------------------------------------------------------------------

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ` -- ${detail}` : ''}`);
  return Boolean(ok);
}

function section(title) {
  console.log('');
  console.log(`--- ${title} ---`);
}

// ---------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------

/** Runs a command to completion, inheriting stdio. Throws on non-zero exit. */
function runOrThrow(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (res.status !== 0) {
    throw new Error(`"${cmd} ${args.join(' ')}" exited ${res.status}${res.error ? `: ${res.error.message}` : ''}`);
  }
  return res;
}

/** Runs a command to completion, capturing stdout/stderr instead of inheriting. */
function runCapture(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', ...opts });
}

/** A free TCP port on 127.0.0.1, picked by asking the OS for one and releasing it. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      return res;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`timed out waiting for ${url}${lastErr ? `: ${lastErr.message}` : ''}`);
}

/** Kills whatever process is listening on `port` on 127.0.0.1. Best-effort. */
function killByPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano -p tcp`, { encoding: 'utf8' });
      const pids = new Set();
      for (const line of out.split('\n')) {
        if (line.includes(`:${port} `) && line.toUpperCase().includes('LISTENING')) {
          const cols = line.trim().split(/\s+/);
          const pid = cols[cols.length - 1];
          if (pid && /^\d+$/.test(pid)) pids.add(pid);
        }
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
        } catch {
          // already gone
        }
      }
    } else {
      try {
        const out = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf8' });
        for (const pid of out.split('\n').map((s) => s.trim()).filter(Boolean)) {
          try {
            process.kill(Number(pid), 'SIGKILL');
          } catch {
            // already gone
          }
        }
      } catch {
        // lsof not found or nothing listening -- try fuser as a fallback
        try {
          execSync(`fuser -k ${port}/tcp`, { stdio: 'ignore' });
        } catch {
          // give up quietly; this is best-effort cleanup
        }
      }
    }
  } catch {
    // best-effort; a leaked hub process on a random port is not fatal to CI
  }
}

// ---------------------------------------------------------------------------
// scratch layout
// ---------------------------------------------------------------------------

const scratchRoot = mkdtempSync(path.join(tmpdir(), 'tracery-publish-check-'));
const tarballDir = path.join(scratchRoot, 'tarballs');
const tempProjectDir = path.join(scratchRoot, 'consumer');
console.log(`[publish-check] scratch dir: ${scratchRoot}`);

let hubProc;
let hubPort;
const releasePackages = [];

async function main() {
  // -------------------------------------------------------------------------
  // 0. build everything
  // -------------------------------------------------------------------------
  section('0. build');
  runOrThrow('npm', ['run', 'build'], { cwd: REPO_ROOT });
  check('npm run build (all workspaces)', true);

  // -------------------------------------------------------------------------
  // 1. npm pack the five publishable packages
  // -------------------------------------------------------------------------
  section('1. npm pack');
  const fs = await import('node:fs');
  fs.mkdirSync(tarballDir, { recursive: true });
  const tarballPaths = [];
  for (const pkgDir of PACKAGES) {
    const abs = path.join(REPO_ROOT, pkgDir);
    const res = runCapture('npm', ['pack', '--json', '--pack-destination', tarballDir], { cwd: abs });
    let ok = res.status === 0;
    let filename;
    if (ok) {
      try {
        // Defense in depth: `npm pack --json`'s stdout should be nothing but
        // the JSON array, but a misbehaving lifecycle script (npm funding
        // notices, a stray console.log) could still prepend/append text --
        // slice to the outermost brackets rather than trusting stdout is
        // pure JSON.
        const start = res.stdout.indexOf('[');
        const end = res.stdout.lastIndexOf(']');
        const parsed = JSON.parse(start !== -1 && end !== -1 ? res.stdout.slice(start, end + 1) : res.stdout);
        filename = parsed[0]?.filename;
        ok = Boolean(filename) && existsSync(path.join(tarballDir, filename));
        if (ok) {
          const pack = parsed[0];
          const files = pack.files.map(file => file.path);
          for (const required of ['LICENSE', 'NOTICE', 'package.json']) {
            if (!files.includes(required)) throw new Error(`${pkgDir} is missing ${required}`);
          }
          if (pkgDir === 'apps/hub' && (!files.includes('web/dist/THIRD-PARTY-NOTICES.txt') || !files.includes('web/dist/index.html'))) {
            throw new Error('Hub tarball is missing the hosted UI or third-party notices');
          }
          if (pkgDir === 'apps/hub' && !files.includes('openapi.json')) throw new Error('Hub tarball is missing the pre-generated openapi.json');
          releasePackages.push({ name: pack.name, version: pack.version, filename, integrity: pack.integrity, files });
        }
      } catch (err) {
        ok = false;
      }
    }
    check(`npm pack ${pkgDir}`, ok, res.stderr?.trim() || res.stdout?.trim());
    if (ok) tarballPaths.push(path.join(tarballDir, filename));
  }
  if (tarballPaths.length !== PACKAGES.length) {
    throw new Error('not all packages packed successfully; aborting');
  }

  // -------------------------------------------------------------------------
  // 2. fresh temp project, install all five tarballs at once (+ ws, needed
  //    for HubClient's WS live subscription -- not a tracery package)
  // -------------------------------------------------------------------------
  section('2. install into a fresh temp project');
  fs.mkdirSync(tempProjectDir, { recursive: true });
  writeFileSync(
    path.join(tempProjectDir, 'package.json'),
    JSON.stringify({ name: 'tracery-publish-check-consumer', version: '0.0.0', private: true }, null, 2),
  );
  const installRes = runCapture(
    'npm',
    ['install', '--no-audit', '--no-fund', '--loglevel=error', ...tarballPaths, 'ws@^8'],
    { cwd: tempProjectDir },
  );
  check('npm install (all five tarballs + ws) into temp project', installRes.status === 0, installRes.stderr?.trim());
  if (installRes.status !== 0) throw new Error('install into temp project failed; aborting');

  // -------------------------------------------------------------------------
  // 3a. import each package in Node from the temp project only
  // -------------------------------------------------------------------------
  section('3a. import checks (installed packages only)');

  const coreCheckSrc = `
    import { ACTIVITY_CONTRACT_VERSION, Journal, buildFlows, project } from '@atriarch-systems/tracery-core';
    if (typeof ACTIVITY_CONTRACT_VERSION !== 'number') throw new Error('ACTIVITY_CONTRACT_VERSION missing');
    const j = new Journal();
    if (typeof j.append !== 'function') throw new Error('Journal.append missing');
    console.log('core-ok');
  `;
  const coreRes = runCapture(process.execPath, ['--input-type=module', '-e', coreCheckSrc], { cwd: tempProjectDir, shell: false });
  check('import @atriarch-systems/tracery-core', coreRes.status === 0 && coreRes.stdout.includes('core-ok'), coreRes.stderr?.trim());

  const clientCheckSrc = `
    import { ActivityTracer, httpTransport, HubClient } from '@atriarch-systems/tracery-client';
    if (typeof ActivityTracer !== 'function') throw new Error('ActivityTracer missing');
    if (typeof httpTransport !== 'function') throw new Error('httpTransport missing');
    if (typeof HubClient !== 'function') throw new Error('HubClient missing');
    console.log('client-ok');
  `;
  const clientRes = runCapture(process.execPath, ['--input-type=module', '-e', clientCheckSrc], { cwd: tempProjectDir, shell: false });
  check('import @atriarch-systems/tracery-client', clientRes.status === 0 && clientRes.stdout.includes('client-ok'), clientRes.stderr?.trim());

  // react + visualizer: SSR-render ActivityExplorer over core's fixtures,
  // the same pattern as packages/react/tests/explorer-ssr.test.mjs, but
  // against the installed tarballs instead of workspace dist/.
  const ssrCheckSrc = `
    import { createElement } from 'react';
    import { renderToString } from 'react-dom/server';
    import { Journal } from '@atriarch-systems/tracery-core';
    import { sampleTraceEvents } from '@atriarch-systems/tracery-core/fixtures';
    import { ActivityExplorer, useJournalSource } from '@atriarch-systems/tracery-react';

    const journal = new Journal();
    journal.append(sampleTraceEvents);

    function Harness() {
      const source = useJournalSource(journal);
      return createElement(ActivityExplorer, { source, ariaLabel: 'publish-check fixture trace' });
    }

    const markup = renderToString(createElement(Harness));
    if (typeof markup !== 'string' || markup.length === 0) throw new Error('empty SSR markup');
    if (!markup.includes('Plan the investigation')) throw new Error('fixture flow label missing from SSR markup');
    console.log('ssr-ok');
  `;
  const ssrRes = runCapture(process.execPath, ['--input-type=module', '-e', ssrCheckSrc], { cwd: tempProjectDir, shell: false });
  check(
    'SSR-render @atriarch-systems/tracery-react ActivityExplorer (pulls in @atriarch-systems/tracery-visualizer) over core fixtures',
    ssrRes.status === 0 && ssrRes.stdout.includes('ssr-ok'),
    ssrRes.stderr?.trim(),
  );

  // -------------------------------------------------------------------------
  // 3b. start the hub with `npx tracery-hub`, no env beyond a random port
  // -------------------------------------------------------------------------
  section('3b. npx tracery-hub');
  hubPort = await findFreePort();
  const hubUrl = `http://127.0.0.1:${hubPort}`;
  console.log(`[publish-check] starting hub on ${hubUrl}`);

  hubProc = spawn('npx', ['tracery-hub'], {
    cwd: tempProjectDir,
    shell: process.platform === 'win32',
    env: { ...minimalEnv(), TRACERY_PORT: String(hubPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let hubOutput = '';
  hubProc.stdout.on('data', (d) => (hubOutput += d.toString()));
  hubProc.stderr.on('data', (d) => (hubOutput += d.toString()));
  hubProc.on('exit', (code, signal) => {
    if (code !== null && code !== 0) {
      console.error(`[publish-check] hub process exited early with code ${code} (signal ${signal})`);
      console.error(hubOutput);
    }
  });

  let infoBody;
  let infoOk = false;
  try {
    const infoRes = await waitForHttp(`${hubUrl}/v1/info`, 15_000);
    infoBody = await infoRes.json();
    infoOk = infoRes.ok && infoBody?.auth === 'none';
  } catch (err) {
    infoOk = false;
    infoBody = { error: err.message };
  }
  check('npx tracery-hub starts; GET /v1/info reports auth: "none"', infoOk, JSON.stringify(infoBody));

  // The OpenAPI document ships pre-generated and is opt-in (TRACERY_OPENAPI=1);
  // @fastify/swagger is a build-time devDependency and must not be a runtime dependency.
  let openApiOff = false;
  try {
    openApiOff = (await fetch(`${hubUrl}/v1/openapi.json`)).status === 404;
  } catch { /* leave false */ }
  check('GET /v1/openapi.json is not served by default', openApiOff);
  const installedHub = JSON.parse(readFileSync(path.join(tempProjectDir, 'node_modules', '@atriarch-systems', 'tracery-hub', 'package.json'), 'utf8'));
  check('installed hub has no @fastify/swagger runtime dependency', installedHub.dependencies?.['@fastify/swagger'] === undefined);

  let uiOk = false;
  let uiDetail = '';
  try {
    const uiRes = await fetch(`${hubUrl}/ui/`);
    const uiText = await uiRes.text();
    uiOk = uiRes.ok && uiText.includes('Tracery Graph');
    uiDetail = uiOk ? '' : uiText.slice(0, 200);
  } catch (err) {
    uiDetail = err.message;
  }
  check('GET /ui/ serves the real hosted UI (contains "Tracery Graph")', uiOk, uiDetail);

  // -------------------------------------------------------------------------
  // 3c. demo.mjs-equivalent against the hub, installed packages only
  // -------------------------------------------------------------------------
  section('3c. demo (installed packages only)');
  const demoScriptPath = path.join(tempProjectDir, 'publish-check-demo.mjs');
  const demoTemplatePath = path.join(REPO_ROOT, 'scripts', 'publish-check-demo.template.mjs');
  writeFileSync(demoScriptPath, fs.readFileSync(demoTemplatePath, 'utf8'));
  const demoRes = runCapture(process.execPath, [demoScriptPath], {
    cwd: tempProjectDir,
    shell: false,
    env: { ...minimalEnv(), TRACERY_HUB_URL: hubUrl },
  });
  console.log(demoRes.stdout);
  if (demoRes.stderr?.trim()) console.error(demoRes.stderr);
  check('demo.mjs-equivalent against the hub (installed packages only)', demoRes.status === 0 && demoRes.stdout.includes('ALL CHECKS PASSED'));
}

/** A minimal, deterministic environment for spawning Node/npm/npx cross-platform. */
function minimalEnv() {
  const keep = ['PATH', 'Path', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'HOMEDRIVE', 'HOMEPATH'];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  console.error(`[publish-check] ERROR: ${err.message}`);
  exitCode = 1;
}

section('summary');
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log(`FAILED: ${failed.map((r) => r.name).join('; ')}`);
  exitCode = 1;
} else if (exitCode === 0) {
  console.log('ALL CHECKS PASSED');
  if (process.env.TRACERY_RELEASE_DIR) {
    try {
      const destination = path.resolve(process.env.TRACERY_RELEASE_DIR);
      mkdirSync(destination, { recursive: true });
      for (const pkg of releasePackages) {
        const source = path.join(tarballDir, pkg.filename);
        pkg.sha256 = createHash('sha256').update(readFileSync(source)).digest('hex');
        copyFileSync(source, path.join(destination, pkg.filename));
      }
      writeFileSync(path.join(destination, 'packages.json'), JSON.stringify(releasePackages, null, 2) + '\n');
      console.log(`[publish-check] retained the tested tarballs in ${destination}`);
    } catch (err) {
      console.error(`[publish-check] cannot retain release artifacts: ${err.message}`);
      exitCode = 1;
    }
  }
}

// -----------------------------------------------------------------------------
// cleanup: always, regardless of pass/fail
// -----------------------------------------------------------------------------
section('cleanup');
if (hubProc && !hubProc.killed) {
  try {
    hubProc.kill();
  } catch {
    // ignore
  }
}
if (hubPort) killByPort(hubPort);
await new Promise((r) => setTimeout(r, 300));
try {
  rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log(`[publish-check] removed scratch dir ${scratchRoot}`);
} catch (err) {
  console.warn(`[publish-check] could not fully remove scratch dir ${scratchRoot}: ${err.message}`);
}

process.exit(exitCode);
