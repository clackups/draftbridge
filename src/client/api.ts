// Git host REST APIs (GitHub, Forgejo / Gitea as on Codeberg), reached
// through the Draftbridge server's proxy.

import { accessToken } from './auth.ts';

export interface User {
  login: string;
  name: string;
  email: string;
}

export interface Repo {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  // URL for Git over HTTPS, as Draftling's git.cfg wants it.
  cloneUrl: string;
  htmlUrl: string;
  empty: boolean;
  updatedAt: string;
}

export interface TreeCheck {
  // Paths of all files (or null when the list could not be read in full).
  files: string[] | null;
  empty: boolean;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function call(provider: string, method: string, path: string, body?: unknown): Promise<{ data: unknown; headers: Headers }> {
  const token = await accessToken();
  const res = await fetch(`/proxy/${provider}/api/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null) as { message?: string; errors?: Array<{ message?: string }> } | null;
  if (!res.ok) {
    const detail = data?.errors?.[0]?.message ?? data?.message ?? `HTTP ${res.status}`;
    throw new ApiError(res.status === 401 ? 'Your login has expired. Please log in again.' : detail, res.status);
  }
  return { data, headers: res.headers };
}

interface GithubRepo {
  name: string; full_name: string; private: boolean; default_branch: string; clone_url: string; html_url: string;
  size: number; pushed_at: string | null; updated_at: string; owner: { login: string }; permissions?: { push?: boolean };
}

interface ForgejoRepo {
  name: string; full_name: string; private: boolean; default_branch: string; clone_url: string; html_url: string;
  empty: boolean; updated_at: string; owner: { login: string }; permissions?: { push?: boolean }; archived?: boolean;
}

export interface HostApi {
  user(): Promise<User>;
  repos(): Promise<Repo[]>;
  createRepo(name: string, isPrivate: boolean): Promise<Repo>;
  tree(repo: Repo, branch: string): Promise<TreeCheck>;
}

function githubApi(): HostApi {
  const map = (r: GithubRepo): Repo => ({
    owner: r.owner.login, name: r.name, fullName: r.full_name, private: r.private, defaultBranch: r.default_branch || 'main',
    cloneUrl: r.clone_url, htmlUrl: r.html_url, empty: r.size === 0 && !r.pushed_at, updatedAt: r.pushed_at ?? r.updated_at,
  });
  return {
    async user() {
      const { data } = await call('github', 'GET', 'user');
      const u = data as { login: string; name: string | null; email: string | null; id: number };
      let email = u.email ?? '';
      if (!email) {
        try {
          const { data: emails } = await call('github', 'GET', 'user/emails');
          email = (emails as Array<{ email: string; primary: boolean; verified: boolean }>).find((e) => e.primary && e.verified)?.email ?? '';
        } catch {
          // the scope may not allow it
        }
      }
      return { login: u.login, name: u.name || u.login, email: email || `${u.id}+${u.login}@users.noreply.github.com` };
    },
    async repos() {
      const out: Repo[] = [];
      for (let page = 1; page <= 10; page++) {
        const { data } = await call('github', 'GET', `user/repos?per_page=100&sort=pushed&page=${page}&affiliation=owner,collaborator,organization_member`);
        const list = data as GithubRepo[];
        out.push(...list.filter((r) => r.permissions?.push !== false).map(map));
        if (list.length < 100) break;
      }
      return out;
    },
    async createRepo(name, isPrivate) {
      const { data } = await call('github', 'POST', 'user/repos', {
        name, private: isPrivate, auto_init: false, description: 'Documents synchronized with Draftling',
      });
      return map(data as GithubRepo);
    },
    async tree(repo, branch) {
      try {
        const { data } = await call('github', 'GET', `repos/${repo.owner}/${repo.name}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
        const t = data as { truncated: boolean; tree: Array<{ path: string; type: string }> };
        return { files: t.truncated ? null : t.tree.filter((e) => e.type === 'blob').map((e) => e.path), empty: false };
      } catch (err) {
        // 409: empty repository; 404: no such branch yet
        if (err instanceof ApiError && (err.status === 404 || err.status === 409)) return { files: [], empty: true };
        throw err;
      }
    },
  };
}

function forgejoApi(id: string): HostApi {
  const map = (r: ForgejoRepo): Repo => ({
    owner: r.owner.login, name: r.name, fullName: r.full_name, private: r.private, defaultBranch: r.default_branch || 'main',
    cloneUrl: r.clone_url, htmlUrl: r.html_url, empty: r.empty, updatedAt: r.updated_at,
  });
  return {
    async user() {
      const { data } = await call(id, 'GET', 'user');
      const u = data as { login: string; full_name: string; email: string };
      return { login: u.login, name: u.full_name || u.login, email: u.email };
    },
    async repos() {
      const out: Repo[] = [];
      for (let page = 1; page <= 20; page++) {
        const { data } = await call(id, 'GET', `user/repos?limit=50&page=${page}`);
        const list = data as ForgejoRepo[];
        out.push(...list.filter((r) => r.permissions?.push !== false && !r.archived).map(map));
        if (list.length < 50) break;
      }
      return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },
    async createRepo(name, isPrivate) {
      const { data } = await call(id, 'POST', 'user/repos', {
        name, private: isPrivate, auto_init: false, default_branch: 'main', description: 'Documents synchronized with Draftling',
      });
      return map(data as ForgejoRepo);
    },
    async tree(repo, branch) {
      if (repo.empty) return { files: [], empty: true };
      const files: string[] = [];
      try {
        for (let page = 1; page <= 50; page++) {
          const { data } = await call(id, 'GET', `repos/${repo.owner}/${repo.name}/git/trees/${encodeURIComponent(branch)}?recursive=true&per_page=1000&page=${page}`);
          const t = data as { tree: Array<{ path: string; type: string }>; truncated: boolean; total_count?: number };
          files.push(...t.tree.filter((e) => e.type === 'blob').map((e) => e.path));
          if (!t.truncated) return { files, empty: false };
        }
        return { files: null, empty: false };
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return { files: [], empty: true };
        throw err;
      }
    },
  };
}

export function hostApi(provider: string): HostApi {
  return provider === 'github' ? githubApi() : forgejoApi(provider);
}
