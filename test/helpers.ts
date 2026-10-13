// Test fixtures: a Git smart HTTP server backed by the git binary, and a
// simulated Draftling (Kermit server over an in-memory SD card).

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryPipe } from '../src/core/kermit/channel.ts';
import { KermitClient } from '../src/core/kermit/client.ts';
import { KermitServer, MemoryFs } from '../src/core/kermit/server.ts';
import { DeviceRepo } from '../src/core/device.ts';
import { GitHttpClient } from '../src/core/git/http.ts';

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'Remote', GIT_AUTHOR_EMAIL: 'r@example.com', GIT_COMMITTER_NAME: 'Remote', GIT_COMMITTER_EMAIL: 'r@example.com' },
  }).trim();
}

export interface GitServer {
  dir: string;
  bare: string;
  url: string;
  requests: string[];
  // Commits files in a clone and pushes them (null deletes a file).
  commit(files: Record<string, string | null>, message?: string): string;
  show(path: string): string;
  close(): Promise<void>;
}

export async function startGitServer(): Promise<GitServer> {
  const dir = mkdtempSync(join(tmpdir(), 'dbr-'));
  const bare = join(dir, 'repo.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', bare);
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    requests.push(`${req.method} ${u.pathname}${u.search}`);
    if (req.headers.authorization !== 'Basic ' + Buffer.from('x-access-token:secret').toString('base64')) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic' }).end();
      return;
    }
    const m = /^\/(?:[^/]+\/)?repo\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(u.pathname);
    if (!m) {
      res.writeHead(404).end();
      return;
    }
    if (m[1] === 'info/refs') {
      const service = u.searchParams.get('service') ?? '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        res.writeHead(403).end();
        return;
      }
      const out = execFileSync('git', [service.slice(4), '--stateless-rpc', '--advertise-refs', bare]);
      const head = `# service=${service}\n`;
      res.writeHead(200, { 'Content-Type': `application/x-${service}-advertisement` });
      res.end(Buffer.concat([Buffer.from((head.length + 4).toString(16).padStart(4, '0') + head + '0000'), out]));
      return;
    }
    const child = spawn('git', [m[1].slice(4), '--stateless-rpc', bare]);
    res.writeHead(200, { 'Content-Type': `application/x-${m[1]}-result` });
    req.pipe(child.stdin);
    child.stdout.pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const work = join(dir, 'work');
  let cloned = false;
  return {
    dir,
    bare,
    url: `http://127.0.0.1:${port}/repo.git`,
    requests,
    commit(files, message = 'remote change') {
      if (!cloned) {
        git(dir, 'clone', '-q', bare, work);
        cloned = true;
      } else {
        git(work, 'pull', '-q', '--rebase=false');
      }
      for (const [p, content] of Object.entries(files)) {
        if (content === null) git(work, 'rm', '-q', p);
        else {
          mkdirSync(join(work, p, '..'), { recursive: true });
          writeFileSync(join(work, p), content);
          git(work, 'add', p);
        }
      }
      git(work, 'commit', '-q', '-m', message);
      git(work, 'push', '-q', 'origin', 'HEAD:main');
      return git(work, 'rev-parse', 'HEAD');
    },
    show(path) {
      return git(bare, 'show', `main:${path}`);
    },
    close: () => new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
      rmSync(dir, { recursive: true, force: true });
    }),
  };
}

export interface Device {
  fs: MemoryFs;
  client: KermitClient;
  server: KermitServer;
  repo: () => DeviceRepo;
  stop: () => void;
}

export function startDevice(fs = new MemoryFs()): Device {
  const [a, b] = memoryPipe();
  const server = new KermitServer(b, fs, { timeoutMs: 500 });
  void server.serve();
  const client = new KermitClient(a, { timeoutMs: 500 });
  return { fs, client, server, repo: () => new DeviceRepo(client), stop: () => server.stop() };
}

export function remoteFor(srv: GitServer): GitHttpClient {
  return new GitHttpClient(srv.url, { Authorization: 'Basic ' + Buffer.from('x-access-token:secret').toString('base64') });
}

// Writes the device's .git to disk so that the real git can check it.
export function dumpDevice(fs: MemoryFs): string {
  const dir = mkdtempSync(join(tmpdir(), 'dbr-dev-'));
  for (const d of fs.dirs) if (d) mkdirSync(join(dir, d), { recursive: true });
  for (const [p, data] of fs.files) writeFileSync(join(dir, p), data);
  return dir;
}
