/**
 * Builds the Fastify app (SPEC.md §6 "Hub"). `createServer` is the seam an
 * extensions module (SPEC.md §7 "Extensions and Tracery Cloud") extends
 * through: it never edits this file, only passes `extensions` in.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import websocketPlugin from '@fastify/websocket';
import corsPlugin from '@fastify/cors';
import { allowsBrowserRequest } from './origin.js';
import fs from 'node:fs';
import path from 'node:path';
import { ACTIVITY_LIMITS } from '@atriarch-systems/tracery-core/contract';
import { authenticate, localModeAuth, AuthError, type AuthContext } from './auth.js';
import { hubPackageRoot, hubVersion, type ApiKeyConfig, type Config, type Role } from './config.js';
import { MemoryStore } from './store/memory.js';
import { SqliteStore } from './store/sqlite.js';
import { PostgresStore } from './store/postgres.js';
import type { EventStore } from './store/types.js';
import type { ShareStore } from './store/share-types.js';
import { MetricsRegistry } from './metrics.js';
import { startRetention, type RetentionHandle } from './retention.js';
import { registerLive } from './live.js';
import { registerEventsRoutes } from './routes/events.js';
import { registerFlowsRoutes } from './routes/flows.js';
import { registerTracesRoutes } from './routes/traces.js';
import { registerWorkspacesRoutes } from './routes/workspaces.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerInfoRoutes } from './routes/info.js';
import { registerSharesRoutes } from './routes/shares.js';
import { registerSharePageRoutes } from './routes/share-page.js';
import { registerExportRoutes } from './routes/export.js';
import { registerUiRoutes } from './routes/ui.js';
import type { HubContext, HubExtensions } from './server-context.js';

export type { HubContext, HubExtensions } from './server-context.js';

export interface CreatedServer {
  readonly app: FastifyInstance;
  readonly store: EventStore & ShareStore;
  readonly metrics: MetricsRegistry;
  readonly keys: readonly ApiKeyConfig[];
  readonly retention: RetentionHandle;
  close(): Promise<void>;
}

async function openStore(config: Config): Promise<EventStore & ShareStore> {
  if (config.store === 'postgres') {
    if (!config.postgresUrl) throw new Error('TRACERY_STORE=postgres requires TRACERY_POSTGRES_URL');
    return PostgresStore.connect(config.postgresUrl);
  }
  return config.store === 'sqlite' ? new SqliteStore(config.sqlitePath) : new MemoryStore();
}

/** hub-3: strips credential query params before a request URL is logged (Fastify's default `req` serializer logs `req.url` verbatim, including `?token=<api key>`). */
export function redactedRequestUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl, 'http://internal');
    for (const param of ['token', 'api_key']) {
      if (parsed.searchParams.has(param)) parsed.searchParams.set(param, '[redacted]');
    }
    return parsed.pathname + parsed.search;
  } catch {
    return rawUrl;
  }
}

const SAFE_REQUEST_ID = /^[\x21-\x7e]+$/;
const MAX_REQUEST_ID_LENGTH = 128;

/** hub-17: a client-supplied `x-request-id` containing a control character makes `reply.header()` throw `ERR_INVALID_CHAR`, turning even `/healthz` into a 500 with no `x-request-id` in the response at all -- exactly when SPEC.md's "every request gets x-request-id" matters most. */
export function safeRequestId(incoming: string | undefined): string {
  if (incoming !== undefined && incoming.length <= MAX_REQUEST_ID_LENGTH && SAFE_REQUEST_ID.test(incoming)) return incoming;
  return randomUUID();
}

/** hub-4: maps a Fastify framework error (malformed JSON, oversized body, ...) to this hub's `{ error: { code, message } }` shape instead of a blanket 500. */
export function clientErrorCode(error: FastifyError): string {
  switch (error.code) {
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return 'body_too_large';
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
      return 'invalid_json';
    default:
      return 'bad_request';
  }
}

/** Fixed `info` block of the published OpenAPI document (see `scripts/generate-openapi.mjs`). */
export function openApiInfo(): { readonly title: string; readonly version: string; readonly description: string } {
  return { title: 'Tracery Graph Hub', version: hubVersion(), description: 'SPEC.md §6 HTTP API.' };
}

/** Where the pre-generated OpenAPI document ships in the package (`apps/hub/openapi.json`). */
export function openApiDocumentPath(): string {
  return path.join(hubPackageRoot(), 'openapi.json');
}

export interface CreateServerOptions {
  /**
   * Runs after CORS and before any route is registered. Build tooling only:
   * `scripts/generate-openapi.mjs` registers `@fastify/swagger` here (a
   * devDependency, never loaded by the running hub) so it can observe every
   * route's schema as it is added.
   */
  readonly beforeRoutes?: (app: FastifyInstance) => void | Promise<void>;
}

export async function createServer(config: Config, extensions?: HubExtensions, options: CreateServerOptions = {}): Promise<CreatedServer> {
  const store = await openStore(config);
  const metrics = new MetricsRegistry();

  // hub-15: `config.apiKeys === undefined` means "nothing configured" (local
  // mode on a loopback host, or the hub already failed to boot -- see
  // `config.ts`'s `resolveAuthMode`); `[]` means an operator explicitly set
  // TRACERY_API_KEYS='[]', which -- now that there is no dev-key fallback to
  // silently collapse onto -- would otherwise boot into a `'keys'` authMode
  // that can never authenticate anyone, including its own operator. Caught
  // here with a clear message rather than left as a locked-out deployment.
  if (config.apiKeys !== undefined && config.apiKeys.length === 0) {
    throw new Error(
      'TRACERY_API_KEYS is explicitly empty ([]), which means no request could ever authenticate -- remove the variable entirely (a loopback TRACERY_HOST gets local mode automatically) or provide at least one key',
    );
  }
  const keys: readonly ApiKeyConfig[] = config.apiKeys ?? [];

  const app = Fastify({
    logger: {
      level: config.logLevel,
      // hub-3: the hosted UI and every WS client connect via `?token=<api key>`
      // (SPEC.md §6 "Live feed"); the default `req` serializer logs `req.url`
      // verbatim, so without this every live connection writes a valid,
      // long-lived API key straight into the hub's logs.
      redact: ['req.headers.authorization', 'req.headers["x-api-key"]'],
      serializers: {
        req(request: { method: string; url: string; ip?: string; socket?: { remotePort?: number } }) {
          return {
            method: request.method,
            url: redactedRequestUrl(request.url),
            remoteAddress: request.ip,
            remotePort: request.socket?.remotePort,
          };
        },
      },
    },
    // hub-4: a spec-legal max batch (ACTIVITY_LIMITS: up to 1000 events x 64KB
    // context each) is well over Fastify's 1 MiB default bodyLimit.
    bodyLimit: config.bodyLimitBytes ?? ACTIVITY_LIMITS.maxEventsPerBatch * ACTIVITY_LIMITS.maxEventBytes,
  });

  app.addHook('onRequest', async (request, reply) => {
    const incoming = request.headers['x-request-id'];
    const requestId = safeRequestId(Array.isArray(incoming) ? incoming[0] : incoming);
    reply.header('x-request-id', requestId);
    // Funding: a friendly tip-jar link, community edition only (apps/hub/README.md "HTTP API").
    if (!(extensions?.isLicensed?.() ?? false)) {
      reply.header('x-ko-fi', 'https://ko-fi.com/demonslyr');
    }
  });

  app.setErrorHandler((error: Error, request, reply) => {
    if (error instanceof AuthError) {
      reply.code(error.status).send({ error: { code: error.code, message: error.message } });
      return;
    }

    const fastifyError = error as FastifyError;
    const status =
      typeof fastifyError.statusCode === 'number' && fastifyError.statusCode >= 400 && fastifyError.statusCode < 600
        ? fastifyError.statusCode
        : 500;

    if (status >= 500) {
      request.log.error(error);
      reply.code(500).send({ error: { code: 'internal_error', message: error.message || 'internal server error' } });
      return;
    }

    request.log.warn({ err: error }, 'tracery: client error');
    reply.code(status).send({ error: { code: clientErrorCode(fastifyError), message: error.message } });
  });

  // Install upgrade bookkeeping first so rejected upgrades also release their sockets.

  await app.register(websocketPlugin);
  // Reject before CORS and before WebSocket upgrades: withholding CORS response
  // headers alone would still allow simple cross-origin writes in local mode.
  app.addHook('onRequest', async (request, reply) => {
    if (!allowsBrowserRequest(request, config)) {
      return reply.code(403).send({ error: { code: 'origin_forbidden', message: 'browser origin or local hostname is not allowed' } });
    }
  });
  await app.register(corsPlugin, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-api-key'],
  });
  await options.beforeRoutes?.(app);

  // Task ("local mode"): `authMode === 'none'` bypasses key lookup entirely --
  // every request is a full-access principal on workspace "default" (see
  // `auth.ts`'s `localModeAuth`). `authMode === 'keys'` is the unchanged
  // SPEC.md §6 behavior.
  const requireAuth = async (
    request: FastifyRequest,
    role: Role,
    requestedWorkspace?: string,
    options?: { readonly operatorWorkspaceOptional?: boolean },
  ): Promise<AuthContext> => {
    const auth =
      config.authMode === 'none'
        ? localModeAuth(requestedWorkspace)
        : authenticate(keys, request.headers as Record<string, string | string[] | undefined>, undefined, role, requestedWorkspace, options);
    await extensions?.onRequestAuthed?.({ request, auth });
    return auth;
  };

  const isLicensed = (): boolean => extensions?.isLicensed?.() ?? false;

  const ctx: HubContext = { config, store, metrics, keys, requireAuth, isLicensed };

  registerHealthRoutes(app, ctx);
  registerInfoRoutes(app, ctx);
  registerEventsRoutes(app, ctx);
  registerFlowsRoutes(app, ctx);
  registerTracesRoutes(app, ctx);
  registerWorkspacesRoutes(app, ctx);
  registerSharesRoutes(app, ctx);
  registerSharePageRoutes(app, ctx);
  registerExportRoutes(app, ctx);
  registerLive(app, { store, keys, metrics, extensions, authMode: config.authMode });

  // The document is generated at build time from these same route schemas and
  // shipped as a file; nothing here builds it at runtime. Off unless asked for.
  if (config.openapi) {
    const documentPath = openApiDocumentPath();
    if (!fs.existsSync(documentPath)) {
      throw new Error('TRACERY_OPENAPI=1 but the pre-generated OpenAPI document is missing at ' + documentPath);
    }
    const document = fs.readFileSync(documentPath, 'utf8');
    app.get('/v1/openapi.json', async (_request, reply) => reply.type('application/json; charset=utf-8').send(document));
  }

  // Registered last so an extensions module's routes (e.g. Tracery Cloud's
  // /v1/license) and the UI's SPA catch-all 404 handler see every built-in
  // route already defined.
  await extensions?.registerRoutes?.(app, ctx);
  await registerUiRoutes(app, ctx);

  await app.ready();

  const retention = startRetention(store, metrics, {
    retentionHours: config.retentionHours,
    maxEventsPerWorkspace: config.maxEventsPerWorkspace,
    logger: app.log,
  });

  return {
    app,
    store,
    metrics,
    keys,
    retention,
    close: async () => {
      retention.stop();
      await app.close();
      await store.close();
    },
  };
}
