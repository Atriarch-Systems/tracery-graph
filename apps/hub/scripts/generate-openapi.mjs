// Generates the hub's OpenAPI document from the real route schemas, at build
// time. `@fastify/swagger` is a devDependency used only here: the published
// package ships the resulting `openapi.json` and the running hub never loads
// the plugin.
//
//   node scripts/generate-openapi.mjs            # rewrite apps/hub/openapi.json
//   node scripts/generate-openapi.mjs --check    # fail if the file is out of date
//
// Requires `npm run build` first (it drives the compiled `dist/server.js`).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const openApiPath = path.join(packageRoot, 'openapi.json');

/** Boots a throwaway in-memory hub with swagger observing every route, and returns the serialized document. */
export async function generateOpenApi() {
  const { createServer, openApiInfo } = await import(pathToFileURL(path.join(packageRoot, 'dist', 'server.js')).href);
  const { default: swagger } = await import('@fastify/swagger');
  const created = await createServer(
    {
      port: 0, host: '127.0.0.1', store: 'memory', sqlitePath: ':memory:', apiKeys: undefined, authMode: 'none',
      authWarning: undefined, retentionHours: 72, maxEventsPerWorkspace: 500_000, metricsToken: undefined,
      logLevel: 'silent', uiDir: path.join(packageRoot, 'no-ui'), publicUrl: undefined, openapi: false,
    },
    undefined,
    { beforeRoutes: app => app.register(swagger, { openapi: { openapi: '3.1.0', info: openApiInfo() } }) },
  );
  try {
    return JSON.stringify(created.app.swagger(), null, 2) + '\n';
  } finally {
    await created.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const generated = await generateOpenApi();
  if (process.argv.includes('--check')) {
    const committed = fs.existsSync(openApiPath) ? fs.readFileSync(openApiPath, 'utf8').replace(/\r\n/g, '\n') : '';
    if (committed !== generated) {
      console.error('apps/hub/openapi.json is out of date with the route schemas; run `npm run openapi -w @atriarch-systems/tracery-hub` and commit it.');
      process.exit(1);
    }
    console.log('openapi.json is up to date');
  } else {
    fs.writeFileSync(openApiPath, generated);
    console.log(`Wrote ${path.relative(process.cwd(), openApiPath)}`);
  }
}
