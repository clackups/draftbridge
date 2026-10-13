// Node.js entry point. The application itself (createApp) only uses web
// standard Request/Response objects, so other runtimes need only their
// own server adapter.

import { serve } from '@hono/node-server';
import { loadConfig } from './config.ts';
import { createApp } from './app.ts';
import { buildProviders } from './providers.ts';

function main(): void {
  const config = loadConfig();
  const app = createApp(config);
  const providers = [...buildProviders(config).keys()];
  if (providers.length === 0) console.warn('WARNING: no OAuth provider is configured; nobody can log in.');
  if (!config.baseUrl.startsWith('https:') && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(config.baseUrl)) {
    console.warn('WARNING: browsers allow Web Serial only on https:// pages (or http://localhost).');
  }
  serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    console.log(`Draftbridge listening on http://${info.address}:${info.port} (public URL ${config.baseUrl})`);
    console.log(`Login providers: ${providers.join(', ') || 'none'}`);
  });
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
