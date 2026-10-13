// Draftling's /sdcard/git.cfg: "key=value" lines.
//
//   repo_url=https://github.com/user/repo
//   branch=main
//   token=...            (HTTP password; Draftbridge never writes one)
//   username=...
//   path=notes/          (remote sub-directory)
//   author_name=Jane Doe
//   author_email=jane@example.com

export interface GitConfig {
  repoUrl: string;
  branch: string;
  path: string;
  authorName: string;
  authorEmail: string;
  hasToken: boolean;
}

export function parseGitConfig(text: string | null): GitConfig {
  const cfg: GitConfig = { repoUrl: '', branch: 'main', path: '', authorName: '', authorEmail: '', hasToken: false };
  for (const line of (text ?? '').split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (key === 'repo_url') cfg.repoUrl = val;
    else if (key === 'branch') cfg.branch = val || 'main';
    else if (key === 'path') cfg.path = normalizePath(val);
    else if (key === 'author_name') cfg.authorName = val;
    else if (key === 'author_email') cfg.authorEmail = val;
    else if (key === 'token') cfg.hasToken = val.length > 0;
  }
  return cfg;
}

// No leading '/', exactly one trailing '/' (or empty for the root), as
// the firmware normalizes it.
export function normalizePath(p: string): string {
  const parts = p.split('/').map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.some((s) => s === '.' || s === '..')) throw new Error('the repository path must not contain "." or ".."');
  return parts.length ? parts.join('/') + '/' : '';
}

// Compares repository URLs ignoring a ".git" suffix, a trailing slash
// and case.
export function sameRepo(a: string, b: string): boolean {
  const norm = (u: string) => u.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '');
  return norm(a) !== '' && norm(a) === norm(b);
}

const REPO_KEYS = ['repo_url', 'token', 'username', 'branch', 'path'];

// git.cfg pointing at `repoUrl`. Lines that do not describe the remote
// (author, comments) are kept; token and username only stay when the
// repository did not change, since they belong to the old one.
export function updateGitConfig(text: string | null, repoUrl: string, branch: string, path: string): string {
  const old = parseGitConfig(text);
  const same = sameRepo(old.repoUrl, repoUrl);
  const keep: string[] = [];
  const credentials: string[] = [];
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const key = line.includes('=') ? line.slice(0, line.indexOf('=')).trim() : '';
    if (key === 'token' || key === 'username') {
      if (same) credentials.push(line);
      continue;
    }
    if (REPO_KEYS.includes(key)) continue;
    keep.push(line);
  }
  const out = [...keep, `repo_url=${repoUrl}`, ...credentials, `branch=${branch}`];
  if (path) out.push(`path=${path}`);
  return out.join('\n') + '\n';
}
