import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { git, startGitServer, startDevice, remoteFor, dumpDevice, type GitServer, type Device } from './helpers.ts';
import { sync, summarize, UnsupportedFilesError, type SyncOptions } from '../src/core/sync.ts';
import { parseGitConfig, updateGitConfig } from '../src/core/gitcfg.ts';

const FIXED = () => new Date('2026-10-13T12:00:00Z');

function opts(srv: GitServer, dev: Device, extra: Partial<SyncOptions> = {}): SyncOptions {
  return {
    device: dev.repo(), remote: remoteFor(srv), branch: 'main', path: '', authorName: 'Jane Doe',
    authorEmail: 'jane@example.com', now: FIXED, ...extra,
  };
}

// The device's repository must be valid for the real git (Draftling's
// own client and any computer the card is put into read it).
function checkDeviceRepo(dev: Device): string {
  const dir = dumpDevice(dev.fs);
  try {
    git(dir, 'fsck', '--strict', '--no-dangling');
    return git(dir, 'log', '--format=%s', 'main');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withSetup(fn: (srv: GitServer, dev: Device) => Promise<void>): Promise<void> {
  const srv = await startGitServer();
  const dev = startDevice();
  try {
    await fn(srv, dev);
  } finally {
    dev.stop();
    await srv.close();
  }
}

test('first sync pushes the device documents to an empty repository', () => withSetup(async (srv, dev) => {
  dev.fs.put('notes.md', '# Notes\n\nline one\n');
  dev.fs.put('script.fountain', 'INT. ROOM - DAY\n');
  dev.fs.put('.notes.md.meta', 'cursor=3');
  dev.fs.put('wifi.cfg', 'ssid=x');
  const r = await sync(opts(srv, dev));
  assert.equal(r.pushed, true);
  assert.equal(r.committedLocal, true);
  assert.equal(srv.show('notes.md'), '# Notes\n\nline one');
  assert.deepEqual(git(srv.bare, 'ls-tree', '--name-only', 'main').split('\n'), ['notes.md', 'script.fountain']);
  assert.equal(git(srv.bare, 'log', '-1', '--format=%an <%ae> %s', 'main'), 'Jane Doe <jane@example.com> Draftling sync: 2 file(s) at 2026-10-13T12:00:00Z');
  assert.equal(dev.fs.text('.git/refs/heads/main'), r.head + '\n');
  assert.equal(dev.fs.text('.git/refs/remotes/origin/main'), r.head + '\n');
  assert.equal(dev.fs.text('.git/HEAD'), 'ref: refs/heads/main\n');
  checkDeviceRepo(dev);

  // nothing changed: nothing to do
  const again = await sync(opts(srv, dev));
  assert.equal(summarize(again), 'Sync complete (nothing to do)');
}));

test('first sync of an empty device clones the repository', () => withSetup(async (srv, dev) => {
  srv.commit({ 'a.md': 'A\n', 'b.txt': 'B\n', 'notes/c.md': 'C\n' });
  const head = srv.commit({ 'a.md': 'A2\n' }, 'second');
  const r = await sync(opts(srv, dev));
  assert.equal(r.cloned, true);
  assert.equal(r.pushed, false);
  assert.equal(r.head, head);
  assert.equal(dev.fs.text('a.md'), 'A2\n');
  assert.equal(dev.fs.text('b.txt'), 'B\n');
  assert.equal(dev.fs.files.has('notes/c.md'), false, 'sub-directories are not checked out');
  assert.equal(r.objectsFetched > 0, true);
  assert.deepEqual(checkDeviceRepo(dev).split('\n'), ['second', 'remote change']);
}));

test('local and remote changes are rebased and merged per line', () => withSetup(async (srv, dev) => {
  srv.commit({ 'a.md': 'one\ntwo\nthree\nfour\nfive\n', 'b.txt': 'B\n' });
  await sync(opts(srv, dev));
  // remote edits line 1 and adds a file; the device edits line 5
  srv.commit({ 'a.md': 'ONE\ntwo\nthree\nfour\nfive\n', 'c.fountain': 'FADE IN:\n' });
  dev.fs.put('a.md', 'one\ntwo\nthree\nfour\nFIVE\n');
  dev.fs.put('d.md', 'new on device\n');
  const r = await sync(opts(srv, dev));
  assert.equal(r.rebased, true);
  assert.equal(r.pushed, true);
  assert.deepEqual(r.conflicts, []);
  assert.equal(dev.fs.text('a.md'), 'ONE\ntwo\nthree\nfour\nFIVE\n');
  assert.equal(dev.fs.text('c.fountain'), 'FADE IN:\n');
  assert.equal(srv.show('a.md'), 'ONE\ntwo\nthree\nfour\nFIVE');
  assert.equal(srv.show('d.md'), 'new on device');
  assert.equal(srv.show('b.txt'), 'B');
  // linear history: the device commit sits on top of the remote one
  assert.equal(git(srv.bare, 'rev-list', '--merges', '--count', 'main'), '0');
  checkDeviceRepo(dev);
}));

test('conflicting edits are committed with markers', () => withSetup(async (srv, dev) => {
  srv.commit({ 'a.md': 'title\nsame line\nend\n' });
  await sync(opts(srv, dev));
  srv.commit({ 'a.md': 'title\nremote line\nend\n' });
  dev.fs.put('a.md', 'title\ndevice line\nend\n');
  const r = await sync(opts(srv, dev));
  assert.deepEqual(r.conflicts, ['a.md']);
  const merged = 'title\n<<<<<<< ours (remote)\nremote line\n=======\ndevice line\n>>>>>>> theirs (local)\nend\n';
  assert.equal(dev.fs.text('a.md'), merged);
  assert.equal(srv.show('a.md') + '\n', merged);
  assert.match(git(srv.bare, 'log', '-1', '--format=%B', 'main'), /\[draftling\] 1 conflict\(s\) committed with markers/);
}));

test('remote-only changes fast-forward the device, deletions included', () => withSetup(async (srv, dev) => {
  srv.commit({ 'a.md': 'A\n', 'b.md': 'B\n' });
  await sync(opts(srv, dev));
  const head = srv.commit({ 'a.md': 'A changed\n', 'b.md': null });
  const r = await sync(opts(srv, dev));
  assert.equal(r.fastForwarded, true);
  assert.equal(r.pushed, false);
  assert.equal(r.head, head);
  assert.equal(dev.fs.text('a.md'), 'A changed\n');
  assert.equal(dev.fs.files.has('b.md'), false);
  assert.deepEqual(r.filesDeleted, ['b.md']);
  assert.equal(dev.fs.text('.git/refs/remotes/origin/main'), head + '\n');
}));

test('a repository with unknown file types is refused before the device is touched', () => withSetup(async (srv, dev) => {
  srv.commit({ 'a.md': 'A\n', 'LICENSE': 'text\n', 'img/logo.png': 'x' });
  dev.fs.put('mine.md', 'mine\n');
  const before = new Map(dev.fs.files);
  await assert.rejects(sync(opts(srv, dev)), (err: unknown) => {
    assert.ok(err instanceof UnsupportedFilesError);
    assert.deepEqual(err.files, ['LICENSE', 'img/logo.png']);
    return true;
  });
  assert.deepEqual(dev.fs.files, before);
}));

test('documents on a new device are kept when the repository has files', () => withSetup(async (srv, dev) => {
  srv.commit({ 'a.md': 'remote A\n', 'shared.md': 'remote version\n' });
  dev.fs.put('mine.md', 'mine\n');
  dev.fs.put('shared.md', 'device version\n');
  const r = await sync(opts(srv, dev));
  assert.equal(r.pushed, true);
  assert.equal(dev.fs.text('a.md'), 'remote A\n');
  assert.equal(dev.fs.text('mine.md'), 'mine\n');
  assert.match(dev.fs.text('shared.md')!, /remote version[\s\S]*device version/);
  assert.equal(srv.show('mine.md'), 'mine');
}));

test('the path setting maps the device onto a sub-directory', () => withSetup(async (srv, dev) => {
  srv.commit({ 'top.md': 'top\n', 'book/ch1.md': 'one\n' });
  dev.fs.put('ch2.md', 'two\n');
  const r = await sync(opts(srv, dev, { path: 'book/' }));
  assert.equal(r.pushed, true);
  assert.equal(dev.fs.text('ch1.md'), 'one\n');
  assert.equal(dev.fs.files.has('top.md'), false);
  assert.equal(srv.show('book/ch2.md'), 'two');
  assert.equal(srv.show('top.md'), 'top');
}));

test('switching to another repository does not carry the old history over', () => withSetup(async (srv, dev) => {
  dev.fs.put('a.md', 'A\n');
  await sync(opts(srv, dev));
  const other = await startGitServer();
  try {
    const r = await sync(opts(other, dev, { freshHistory: true }));
    assert.equal(r.pushed, true);
    assert.equal(git(other.bare, 'rev-list', '--count', 'main'), '1');
    assert.equal(other.show('a.md'), 'A');
  } finally {
    await other.close();
  }
}));

test('git.cfg is pointed at the selected repository', () => {
  const old = '# my device\nrepo_url=https://github.com/a/old\ntoken=ghp_x\nusername=me\nbranch=dev\npath=notes/\nauthor_name=Jane\n';
  const same = updateGitConfig(old, 'https://github.com/a/old.git', 'dev', 'notes/');
  assert.match(same, /token=ghp_x/);
  const other = updateGitConfig(old, 'https://github.com/a/new.git', 'main', '');
  assert.equal(other, '# my device\nauthor_name=Jane\nrepo_url=https://github.com/a/new.git\nbranch=main\n');
  const cfg = parseGitConfig(old);
  assert.equal(cfg.path, 'notes/');
  assert.equal(cfg.branch, 'dev');
  assert.equal(cfg.authorName, 'Jane');
});
