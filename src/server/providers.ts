// Git hosting providers the user can sign in with. The server only
// knows their endpoints; everything user-specific stays in the browser.

import type { Config } from './config.ts';

export interface Provider {
  id: 'github' | 'codeberg';
  label: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  authorizeUrl: string;
  tokenUrl: string;
  // REST API base, without trailing slash.
  apiBase: string;
  // Base of repository URLs (https://github.com).
  gitBase: string;
  // HTTP Basic user name to send with the token for Git over HTTP.
  gitUser: string;
  // API paths (after apiBase) the proxy forwards, with their methods.
  apiRoutes: Array<{ method: string; path: RegExp }>;
}

const NAME = '[A-Za-z0-9_.-]{1,100}';
const REF = '[A-Za-z0-9_./-]{1,250}';

export function buildProviders(cfg: Config): Map<string, Provider> {
  const out = new Map<string, Provider>();
  const gh = cfg.oauth.github;
  if (gh) {
    out.set('github', {
      id: 'github',
      label: 'GitHub',
      clientId: gh.clientId,
      clientSecret: gh.clientSecret,
      scope: gh.scope ?? 'repo user:email',
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      apiBase: 'https://api.github.com',
      gitBase: 'https://github.com',
      gitUser: 'x-access-token',
      apiRoutes: [
        { method: 'GET', path: /^user$/ },
        { method: 'GET', path: /^user\/emails$/ },
        { method: 'GET', path: /^user\/repos$/ },
        { method: 'POST', path: /^user\/repos$/ },
        { method: 'GET', path: new RegExp(`^repos/${NAME}/${NAME}$`) },
        { method: 'GET', path: new RegExp(`^repos/${NAME}/${NAME}/git/trees/${REF}$`) },
      ],
    });
  }
  const cb = cfg.oauth.codeberg;
  if (cb) {
    const base = (cb.url ?? 'https://codeberg.org').replace(/\/+$/, '');
    out.set('codeberg', {
      id: 'codeberg',
      label: cb.label ?? 'Codeberg',
      clientId: cb.clientId,
      clientSecret: cb.clientSecret,
      scope: cb.scope ?? 'write:repository write:user',
      authorizeUrl: `${base}/login/oauth/authorize`,
      tokenUrl: `${base}/login/oauth/access_token`,
      apiBase: `${base}/api/v1`,
      gitBase: base,
      gitUser: 'oauth2',
      apiRoutes: [
        { method: 'GET', path: /^user$/ },
        { method: 'GET', path: /^user\/repos$/ },
        { method: 'POST', path: /^user\/repos$/ },
        { method: 'GET', path: new RegExp(`^repos/${NAME}/${NAME}$`) },
        { method: 'GET', path: new RegExp(`^repos/${NAME}/${NAME}/git/trees/${REF}$`) },
      ],
    });
  }
  return out;
}

// What the browser needs to know about a provider (no secret).
export function publicInfo(p: Provider): Record<string, string> {
  return { id: p.id, label: p.label, clientId: p.clientId, scope: p.scope, authorizeUrl: p.authorizeUrl, gitBase: p.gitBase, gitUser: p.gitUser };
}
