// Server configuration. Loaded from a JSON file (path in
// DRAFTBRIDGE_CONFIG, default ./draftbridge.config.json); secrets may be
// overridden by environment variables so that they do not need to be
// stored in the file.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  // OAuth scopes to request; the defaults are listed in README.md.
  scope?: string;
}

export interface ForgejoConfig extends OAuthClientConfig {
  // Base URL of the Forgejo / Gitea instance.
  url?: string;
  // Name on the login button.
  label?: string;
}

export interface Config {
  // Public URL of the service, without trailing slash. OAuth redirect
  // URIs are <baseUrl>/auth/<provider>/callback.
  baseUrl: string;
  host: string;
  port: number;
  siteName: string;
  oauth: {
    github?: OAuthClientConfig;
    codeberg?: ForgejoConfig;
  };
  proxy: {
    // Largest request body forwarded to a Git host (a push), MB.
    maxBodyMb: number;
    // Time limit of one forwarded request, seconds.
    timeoutSeconds: number;
  };
  // Browser cache lifetime of static files (app.js, app.css, ...), seconds.
  staticCacheSeconds: number;
}

const DEFAULTS: Config = {
  baseUrl: 'http://localhost:8090',
  host: '127.0.0.1',
  port: 8090,
  siteName: 'Draftbridge',
  oauth: {},
  proxy: { maxBodyMb: 100, timeoutSeconds: 300 },
  staticCacheSeconds: 60,
};

export function loadConfig(path?: string): Config {
  const file = resolve(path ?? process.env.DRAFTBRIDGE_CONFIG ?? 'draftbridge.config.json');
  let fromFile: Partial<Config> = {};
  if (existsSync(file)) fromFile = JSON.parse(readFileSync(file, 'utf8')) as Partial<Config>;
  return finalizeConfig(fromFile, process.env);
}

export function finalizeConfig(partial: Partial<Config>, env: Record<string, string | undefined> = {}): Config {
  const cfg: Config = {
    ...DEFAULTS,
    ...partial,
    oauth: { ...partial.oauth },
    proxy: { ...DEFAULTS.proxy, ...partial.proxy },
  };
  if (env.DRAFTBRIDGE_PORT) cfg.port = Number(env.DRAFTBRIDGE_PORT);
  if (env.DRAFTBRIDGE_BASE_URL) cfg.baseUrl = env.DRAFTBRIDGE_BASE_URL;
  if (env.DRAFTBRIDGE_GITHUB_CLIENT_SECRET && cfg.oauth.github) {
    cfg.oauth.github = { ...cfg.oauth.github, clientSecret: env.DRAFTBRIDGE_GITHUB_CLIENT_SECRET };
  }
  if (env.DRAFTBRIDGE_CODEBERG_CLIENT_SECRET && cfg.oauth.codeberg) {
    cfg.oauth.codeberg = { ...cfg.oauth.codeberg, clientSecret: env.DRAFTBRIDGE_CODEBERG_CLIENT_SECRET };
  }

  cfg.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+(\/.*)?$/.test(cfg.baseUrl)) throw new Error('baseUrl must be an http(s) URL');
  if (!Number.isInteger(cfg.port) || cfg.port <= 0 || cfg.port > 65535) throw new Error('port must be a TCP port number');
  for (const key of ['maxBodyMb', 'timeoutSeconds'] as const) {
    if (!(Number.isFinite(cfg.proxy[key]) && cfg.proxy[key] > 0)) throw new Error(`proxy.${key} must be a positive number`);
  }
  if (!Number.isFinite(cfg.staticCacheSeconds) || cfg.staticCacheSeconds < 0) {
    throw new Error('staticCacheSeconds must be a non-negative number');
  }
  cfg.staticCacheSeconds = Math.floor(cfg.staticCacheSeconds);
  for (const [id, p] of Object.entries(cfg.oauth)) {
    if (!p) continue;
    if (!p.clientId || !p.clientSecret) throw new Error(`oauth.${id} needs clientId and clientSecret`);
  }
  if (cfg.oauth.codeberg?.url !== undefined && !/^https:\/\/[^/]+$/.test(cfg.oauth.codeberg.url.replace(/\/+$/, ''))) {
    throw new Error('oauth.codeberg.url must be an https URL without a path');
  }
  return cfg;
}
