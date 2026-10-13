import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/app.ts';
import { finalizeConfig } from '../src/server/config.ts';
import { GitHttpClient, basicAuth } from '../src/core/git/http.ts';
import { sync } from '../src/core/sync.ts';
import { startGitServer, startDevice } from './helpers.ts';

const BASE = 'https://bridge.example.com';

function config() {
  return finalizeConfig({
    baseUrl: BASE,
    oauth: {
      github: { clientId: 'gh-id', clientSecret: 'gh-secret' },
      codeberg: { clientId: 'cb-id', clientSecret: 'cb-secret', url: 'https://git.test' },
    },
  });
}

test('configuration is validated', () => {
  assert.throws(() => finalizeConfig({ oauth: { github: { clientId: 'x', clientSecret: '' } } }), /clientSecret/);
  assert.throws(() => finalizeConfig({ baseUrl: 'ftp://x' }), /baseUrl/);
  assert.throws(() => finalizeConfig({ oauth: { codeberg: { clientId: 'a', clientSecret: 'b', url: 'http://plain' } } }), /https/);
  const c = finalizeConfig({ baseUrl: 'https://a.example/', oauth: { github: { clientId: 'a', clientSecret: 'file' } } },
    { DRAFTBRIDGE_GITHUB_CLIENT_SECRET: 'env', DRAFTBRIDGE_PORT: '9000' });
  assert.equal(c.baseUrl, 'https://a.example');
  assert.equal(c.oauth.github?.clientSecret, 'env');
  assert.equal(c.port, 9000);
});

test('the page embeds the public provider settings only', async () => {
  const app = createApp(config());
  const res = await app.request('/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Security-Policy') ?? '', /script-src 'self'/);
  const html = await res.text();
  assert.match(html, /"clientId":"gh-id"/);
  assert.doesNotMatch(html, /secret/);
  assert.equal((await app.request('/auth/github/callback?code=x&state=y')).status, 200);
  assert.equal((await app.request('/auth/nope/callback')).status, 404);
  assert.equal((await app.request('/static/app.css')).status, 200);
  assert.equal((await app.request('/static/../config.ts')).status, 404);
});

test('token exchange forwards the code with the client secret', async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body) });
    return Response.json({ access_token: 'tok', token_type: 'bearer', scope: 'repo', refresh_token: 'r', expires_in: 3600 });
  }) as typeof fetch;
  const app = createApp(config(), fake);
  const res = await app.request('/auth/github/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ code: 'c0de', verifier: 'v' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { access_token: 'tok', token_type: 'bearer', scope: 'repo', refresh_token: 'r', expires_in: 3600 });
  assert.equal(calls[0].url, 'https://github.com/login/oauth/access_token');
  const sent = new URLSearchParams(calls[0].body);
  assert.equal(sent.get('client_secret'), 'gh-secret');
  assert.equal(sent.get('code_verifier'), 'v');
  assert.equal(sent.get('redirect_uri'), `${BASE}/auth/github/callback`);
  // other web sites cannot use it
  const cross = await app.request('/auth/github/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ code: 'c', verifier: 'v' }),
  });
  assert.equal(cross.status, 403);
  const refresh = await app.request('/auth/codeberg/refresh', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body: JSON.stringify({ refresh_token: 'r' }),
  });
  assert.equal(refresh.status, 200);
  assert.equal(calls[1].url, 'https://git.test/login/oauth/access_token');
  assert.equal(new URLSearchParams(calls[1].body).get('grant_type'), 'refresh_token');
});

test('the API proxy forwards only the calls the application makes', async () => {
  const calls: Array<{ url: string; auth: string }> = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: (init.headers as Record<string, string>).Authorization });
    return new Response('[]', { headers: { 'Content-Type': 'application/json', Link: '<next>; rel="next"', 'Set-Cookie': 'a=b' } });
  }) as typeof fetch;
  const app = createApp(config(), fake);
  const auth = { Authorization: 'Bearer tok' };
  const ok = await app.request('/proxy/github/api/user/repos?per_page=100', { headers: auth });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Link'), '<next>; rel="next"');
  assert.equal(ok.headers.get('Set-Cookie'), null);
  assert.deepEqual(calls[0], { url: 'https://api.github.com/user/repos?per_page=100', auth: 'Bearer tok' });
  assert.equal((await app.request('/proxy/codeberg/api/repos/a/b/git/trees/main', { headers: auth })).status, 200);
  assert.equal(calls[1].url, 'https://git.test/api/v1/repos/a/b/git/trees/main');
  assert.equal((await app.request('/proxy/github/api/user/repos')).status, 401);
  assert.equal((await app.request('/proxy/github/api/repos/a/b', { method: 'DELETE', headers: auth })).status, 404);
  assert.equal((await app.request('/proxy/github/api/user/keys', { headers: auth })).status, 403);
  assert.equal((await app.request('/proxy/github/api/repos/a/b/contents/x', { headers: auth })).status, 403);
  assert.equal((await app.request('/proxy/github/api/user', { headers: { ...auth, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await app.request('/proxy/github/git/a/b.git/objects/info/packs', { headers: auth })).status, 403);
  assert.equal((await app.request('/proxy/github/git/a/b.git/info/refs?service=git-upload-archive', { headers: auth })).status, 403);
  assert.equal(calls.length, 2);
});

test('a sync runs through the Git proxy', async () => {
  const srv = await startGitServer();
  const dev = startDevice();
  try {
    const local = new URL(srv.url);
    // The proxy talks to https://git.test; send that to the test server.
    const toLocal = ((url: string, init: RequestInit) => {
      const u = new URL(url);
      return fetch(`http://${local.host}${u.pathname}${u.search}`, init);
    }) as typeof fetch;
    const app = createApp(config(), toLocal);
    const remote = new GitHttpClient(`${BASE}/proxy/codeberg/git/someone/repo.git`, {
      Authorization: basicAuth('x-access-token', 'secret'),
    }, (url, init) => app.request(url, init as RequestInit));
    dev.fs.put('a.md', 'through the proxy\n');
    const r = await sync({ device: dev.repo(), remote, branch: 'main', path: '', authorName: 'A', authorEmail: 'a@example.com' });
    assert.equal(r.pushed, true);
    assert.equal(srv.show('a.md'), 'through the proxy');
    assert.deepEqual(srv.requests.map((x) => x.replace(/\?.*/, '')), [
      'GET /someone/repo.git/info/refs', 'POST /someone/repo.git/git-receive-pack',
    ]);
  } finally {
    dev.stop();
    await srv.close();
  }
});
