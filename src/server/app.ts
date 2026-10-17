// The Draftbridge web server. It is stateless: it serves the web
// application, completes OAuth logins (the token exchange needs the
// client secret) and forwards requests to the Git host on behalf of the
// browser (Git hosts do not allow cross-origin requests). Tokens pass
// through it but are never stored; the browser keeps them in its
// session storage.

import { Hono, type Context } from 'hono';
import type { Config } from './config.ts';
import { buildProviders, type Provider } from './providers.ts';
import { appPage, privacyPage } from './page.ts';
import { registerStaticRoutes } from './static.ts';

const FORWARDED_RESPONSE_HEADERS = ['content-type', 'link', 'x-total-count', 'x-hasmore', 'www-authenticate'];
const GIT_PATH = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export function createApp(cfg: Config, fetchFn: typeof fetch = fetch): Hono {
  const app = new Hono();
  const providers = buildProviders(cfg);
  const origin = new URL(cfg.baseUrl).origin;

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    if ((c.res.headers.get('Content-Type') ?? '').startsWith('text/html')) {
      c.header('X-Frame-Options', 'DENY');
      c.header('Cache-Control', 'no-store');
      c.header('Content-Security-Policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; "
        + "base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    }
  });

  // Only this site's own pages may use the token exchange and the
  // proxy; other web sites cannot make a browser call them.
  const sameOrigin = (c: Context): boolean => {
    const site = c.req.header('Sec-Fetch-Site');
    if (site && site !== 'same-origin') return false;
    const o = c.req.header('Origin');
    return !o || o === origin;
  };

  const provider = (c: Context): Provider | null => providers.get(c.req.param('provider') ?? '') ?? null;

  registerStaticRoutes(app, cfg);

  app.get('/', (c) => c.html(appPage(cfg, providers)));
  app.get('/auth/:provider/callback', (c) => (provider(c) ? c.html(appPage(cfg, providers)) : c.notFound()));
  app.get('/privacy', (c) => c.html(privacyPage(cfg)));
  app.get('/healthz', (c) => c.text('ok'));

  // OAuth: the browser obtained a code (with PKCE); exchange it here,
  // where the client secret is.
  const tokenRequest = async (c: Context, grant: Record<string, string>) => {
    const p = provider(c);
    if (!p) return c.json({ error: 'unknown_provider' }, 404);
    if (!sameOrigin(c)) return c.json({ error: 'forbidden' }, 403);
    const res = await fetchFn(p.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: p.clientId, client_secret: p.clientSecret, ...grant }).toString(),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (!res) return c.json({ error: 'provider_unreachable' }, 502);
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || json.error || typeof json.access_token !== 'string') {
      return c.json({ error: String(json.error ?? `http_${res.status}`), description: String(json.error_description ?? '') }, 400);
    }
    const out: Record<string, unknown> = { access_token: json.access_token, token_type: json.token_type ?? 'bearer', scope: json.scope ?? '' };
    if (typeof json.refresh_token === 'string') out.refresh_token = json.refresh_token;
    if (typeof json.expires_in === 'number') out.expires_in = json.expires_in;
    return c.json(out, 200, { 'Cache-Control': 'no-store' });
  };

  app.post('/auth/:provider/token', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof body.code !== 'string' || typeof body.verifier !== 'string' || body.code.length > 512 || body.verifier.length > 256) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    return tokenRequest(c, {
      grant_type: 'authorization_code',
      code: body.code,
      code_verifier: body.verifier,
      redirect_uri: `${cfg.baseUrl}/auth/${c.req.param('provider')}/callback`,
    });
  });

  app.post('/auth/:provider/refresh', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof body.refresh_token !== 'string' || body.refresh_token.length > 2048) return c.json({ error: 'invalid_request' }, 400);
    return tokenRequest(c, { grant_type: 'refresh_token', refresh_token: body.refresh_token });
  });

  const maxBody = cfg.proxy.maxBodyMb * 1024 * 1024;

  const forward = async (c: Context, target: string, headers: Record<string, string>): Promise<Response> => {
    let body: ArrayBuffer | undefined;
    if (c.req.method === 'POST') {
      const len = Number(c.req.header('Content-Length') ?? '0');
      if (len > maxBody) return c.text('Payload too large', 413);
      body = await c.req.arrayBuffer();
      if (body.byteLength > maxBody) return c.text('Payload too large', 413);
    }
    const res = await fetchFn(target, {
      method: c.req.method,
      headers: { 'User-Agent': 'Draftbridge', ...headers, Authorization: c.req.header('Authorization') ?? '' },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(cfg.proxy.timeoutSeconds * 1000),
    }).catch((err: unknown) => {
      console.warn(`proxy: ${target}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    if (!res) return c.text('The Git host did not answer', 502);
    const out = new Headers({ 'Cache-Control': 'no-store' });
    for (const h of FORWARDED_RESPONSE_HEADERS) {
      const v = res.headers.get(h);
      if (v) out.set(h, v);
    }
    // A redirect (e.g. a renamed repository) is not followed by the
    // browser through the proxy; report it as an error.
    const status = res.status >= 300 && res.status < 400 ? 502 : res.status;
    return new Response(res.body, { status, headers: out });
  };

  const proxyGuard = (c: Context): Response | null => {
    if (!sameOrigin(c)) return c.text('Forbidden', 403);
    if (!c.req.header('Authorization')) return c.text('Authorization required', 401);
    return null;
  };

  // REST API calls the web application makes (repository list, creation,
  // file list).
  app.on(['GET', 'POST'], '/proxy/:provider/api/*', async (c) => {
    const p = provider(c);
    if (!p) return c.notFound();
    const denied = proxyGuard(c);
    if (denied) return denied;
    const prefix = `/proxy/${p.id}/api/`;
    const path = c.req.path.slice(prefix.length);
    if (!p.apiRoutes.some((r) => r.method === c.req.method && r.path.test(path))) return c.text('Not allowed', 403);
    const query = new URL(c.req.url).search;
    const headers: Record<string, string> = { Accept: c.req.header('Accept') ?? 'application/json' };
    if (c.req.method === 'POST') headers['Content-Type'] = 'application/json';
    return forward(c, `${p.apiBase}/${path}${query}`, headers);
  });

  // Git smart HTTP (protocol v0): info/refs, git-upload-pack and
  // git-receive-pack of one repository.
  app.on(['GET', 'POST'], '/proxy/:provider/git/*', async (c) => {
    const p = provider(c);
    if (!p) return c.notFound();
    const denied = proxyGuard(c);
    if (denied) return denied;
    const m = GIT_PATH.exec(c.req.path.slice(`/proxy/${p.id}/git/`.length));
    if (!m) return c.text('Not allowed', 403);
    const [, owner, repo, op] = m;
    const target = `${p.gitBase}/${owner}/${repo}.git/${op}`;
    if (op === 'info/refs') {
      if (c.req.method !== 'GET') return c.text('Method not allowed', 405);
      const service = c.req.query('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return c.text('Not allowed', 403);
      return forward(c, `${target}?service=${service}`, { Accept: '*/*' });
    }
    if (c.req.method !== 'POST') return c.text('Method not allowed', 405);
    return forward(c, target, {
      'Content-Type': `application/x-${op}-request`,
      Accept: `application/x-${op}-result`,
    });
  });

  return app;
}
