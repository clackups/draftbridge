// OAuth login with PKCE. The browser generates state and verifier and
// keeps them in session storage; the Draftbridge server only swaps the
// authorization code for a token (that needs the client secret). The
// token stays in this tab's session storage.

import { storage } from './storage.ts';

export interface ProviderInfo {
  id: string;
  label: string;
  clientId: string;
  scope: string;
  authorizeUrl: string;
  gitBase: string;
  gitUser: string;
}

export interface ClientConfig {
  baseUrl: string;
  siteName: string;
  providers: ProviderInfo[];
}

export interface Auth {
  provider: string;
  accessToken: string;
  refreshToken?: string;
  // Milliseconds since the epoch.
  expiresAt?: number;
}

const AUTH_KEY = 'draftbridge.auth';
const PENDING_KEY = 'draftbridge.oauth';

function randomString(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function challenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function redirectUri(cfg: ClientConfig, provider: string): string {
  return `${cfg.baseUrl}/auth/${provider}/callback`;
}

export async function startLogin(cfg: ClientConfig, p: ProviderInfo): Promise<void> {
  const state = randomString(24);
  const verifier = randomString(48);
  storage.session.set(PENDING_KEY, JSON.stringify({ provider: p.id, state, verifier }));
  const u = new URL(p.authorizeUrl);
  u.search = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: redirectUri(cfg, p.id),
    scope: p.scope,
    state,
    code_challenge: await challenge(verifier),
    code_challenge_method: 'S256',
  }).toString();
  location.assign(u.toString());
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  description?: string;
}

function toAuth(provider: string, t: TokenResponse): Auth {
  if (!t.access_token) throw new Error(t.description || t.error || 'login failed');
  const a: Auth = { provider, accessToken: t.access_token };
  if (t.refresh_token) a.refreshToken = t.refresh_token;
  if (t.expires_in) a.expiresAt = Date.now() + t.expires_in * 1000;
  return a;
}

async function postJson(url: string, body: unknown): Promise<TokenResponse> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as TokenResponse;
}

// Completes a login on /auth/<provider>/callback. Returns the error
// text when it failed.
export async function finishLogin(provider: string): Promise<string | null> {
  const params = new URLSearchParams(location.search);
  const pendingRaw = storage.session.get(PENDING_KEY);
  storage.session.remove(PENDING_KEY);
  if (params.get('error')) return params.get('error_description') || params.get('error') || 'login cancelled';
  const pending = pendingRaw ? (JSON.parse(pendingRaw) as { provider: string; state: string; verifier: string }) : null;
  const code = params.get('code');
  if (!pending || pending.provider !== provider || pending.state !== params.get('state') || !code) {
    return 'The login could not be completed (it was started in another tab or has expired). Please try again.';
  }
  try {
    const t = await postJson(`/auth/${provider}/token`, { code, verifier: pending.verifier });
    saveAuth(toAuth(provider, t));
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function loadAuth(): Auth | null {
  const raw = storage.session.get(AUTH_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Auth;
  } catch {
    return null;
  }
}

export function saveAuth(a: Auth): void {
  storage.session.set(AUTH_KEY, JSON.stringify(a));
}

export function logout(): void {
  storage.session.remove(AUTH_KEY);
}

// A valid access token, refreshed when it is about to expire.
export async function accessToken(): Promise<string> {
  const a = loadAuth();
  if (!a) throw new Error('not logged in');
  if (a.expiresAt && a.expiresAt - Date.now() < 120_000 && a.refreshToken) {
    const t = await postJson(`/auth/${a.provider}/refresh`, { refresh_token: a.refreshToken });
    if (t.access_token) {
      const next = toAuth(a.provider, t);
      if (!next.refreshToken) next.refreshToken = a.refreshToken;
      saveAuth(next);
      return next.accessToken;
    }
  }
  return a.accessToken;
}
