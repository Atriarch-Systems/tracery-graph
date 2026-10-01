/**
 * `GET /` and `GET /ui/*` (SPEC.md §6 HTTP API table + "Hosted UI"): serves
 * `apps/hub/web/dist` (workstream E's build) at `/ui` with SPA fallback to
 * `index.html`, or a plain placeholder page when the UI has not been built.
 * Every other unmatched route still gets the hub's normal `{ error }` JSON
 * 404 shape.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import staticPlugin from '@fastify/static';
import type { HubContext } from '../server-context.js';

function placeholderHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Tracery Graph Hub</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem;">
<h1>Tracery Graph Hub</h1>
<p>The hosted UI is not built. Build <code>apps/hub/web</code> and set
<code>TRACERY_UI_DIR</code> (or leave it at the default <code>web/dist</code>)
to serve it here.</p>
<p>In the meantime: <a href="/healthz">/healthz</a>.</p>
</body></html>`;
}

export async function registerUiRoutes(app: FastifyInstance, ctx: HubContext): Promise<void> {
  const indexPath = path.join(ctx.config.uiDir, 'index.html');
  const uiBuilt = fs.existsSync(indexPath);

  app.get('/', async (_request, reply) => reply.redirect('/ui/'));

  if (uiBuilt) {
    await app.register(staticPlugin, {
      root: ctx.config.uiDir,
      prefix: '/ui/',
      decorateReply: false,
      wildcard: false,
    });
  }

  const placeholder = placeholderHtml();

  app.setNotFoundHandler((request, reply) => {
    const url = request.raw.url ?? '';
    if (url === '/ui' || url.startsWith('/ui/') || url.startsWith('/ui?')) {
      if (uiBuilt) {
        reply.type('text/html').send(fs.readFileSync(indexPath, 'utf8'));
      } else {
        reply.type('text/html').send(placeholder);
      }
      return;
    }
    reply.code(404).send({ error: { code: 'not_found', message: `no such route: ${url}` } });
  });
}
