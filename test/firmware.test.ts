// Draftbridge against Draftling's own Kermit server code, built for the
// host by scripts/build-firmware-host.sh. Skipped unless
// DRAFTLING_KERMIT_HOST names the built program.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChunkQueue, type ByteChannel } from '../src/core/kermit/channel.ts';
import { KermitClient } from '../src/core/kermit/client.ts';
import { DeviceRepo } from '../src/core/device.ts';
import { sync, summarize } from '../src/core/sync.ts';
import { git, remoteFor, startGitServer } from './helpers.ts';

const HOST = process.env.DRAFTLING_KERMIT_HOST;
const skip = !HOST || !existsSync(HOST) ? 'set DRAFTLING_KERMIT_HOST (see scripts/build-firmware-host.sh)' : false;

async function withFirmware(fn: (root: string, client: KermitClient) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'dbr-fw-'));
  const child = spawn(HOST!, [root], { stdio: ['pipe', 'pipe', 'ignore'] });
  const q = new ChunkQueue();
  child.stdout.on('data', (d: Buffer) => q.push(new Uint8Array(d)));
  const ch: ByteChannel = { write: async (d) => { child.stdin.write(d); }, read: (t) => q.read(t) };
  try {
    await fn(root, new KermitClient(ch, { timeoutMs: 3000, retries: 3 }));
  } finally {
    child.kill();
    rmSync(root, { recursive: true, force: true });
  }
}

test('Kermit operations against the firmware server', { skip }, () => withFirmware(async (root, client) => {
  await client.resetDirectory();
  assert.deepEqual(await client.dir(''), []);
  writeFileSync(join(root, 'notes.md'), 'padding     '.repeat(400));
  mkdirSync(join(root, 'sub'));
  const listed = (await client.dir(''))!.sort((a, b) => (a.name < b.name ? -1 : 1));
  assert.deepEqual(listed, [{ name: 'notes.md', dir: false }, { name: 'sub', dir: true }]);
  const all = new Uint8Array(70000).map((_, i) => (i * 7 + (i >> 8)) & 255);
  assert.equal(await client.mkdir('.git'), true);
  assert.equal(await client.mkdir('.git'), false);
  await client.mkdir('.git/objects');
  await client.mkdir('.git/objects/ab');
  await client.send([{ path: '.git/objects/ab/cdef', data: all }, { path: 'b.md', data: new Uint8Array(0) }]);
  assert.deepEqual(new Uint8Array(readFileSync(join(root, '.git/objects/ab/cdef'))), all);
  assert.deepEqual(await client.get('.git/objects/ab/cdef'), all);
  assert.equal((await client.get('b.md'))?.length, 0);
  assert.equal(await client.get('nope.md'), null);
  assert.equal(await client.get('nodir/nope.md'), null);
  assert.equal(await client.dir('nodir/x'), null);
  await client.remove('b.md');
  await client.remove('b.md');
  assert.equal(existsSync(join(root, 'b.md')), false);
  await assert.rejects(client.send([{ path: 'nodir/x.md', data: new Uint8Array([1]) }]), /Cannot create file/);
  await client.finish();
  assert.equal((await client.get('notes.md'))?.length, 4800);
}));

test('synchronization against the firmware server', { skip }, async () => {
  const srv = await startGitServer();
  try {
    await withFirmware(async (root, client) => {
      const opts = () => ({ device: new DeviceRepo(client), remote: remoteFor(srv), branch: 'main', path: '', authorName: 'Jane', authorEmail: 'j@example.com' });
      srv.commit({ 'a.md': 'one\ntwo\nthree\n', 'b.txt': 'B\n' });
      for (let i = 0; i < 10; i++) srv.commit({ [`ch${i}.md`]: `chapter ${i}\n`.repeat(50) }, `chapter ${i}`);
      let r = await sync(opts());
      assert.equal(r.cloned, true);
      git(root, 'fsck', '--strict', '--no-dangling');
      srv.commit({ 'a.md': 'ONE\ntwo\nthree\n' });
      writeFileSync(join(root, 'a.md'), 'one\ntwo\nTHREE\n');
      writeFileSync(join(root, 'new.fountain'), 'FADE IN:\n');
      r = await sync(opts());
      assert.equal(summarize(r), 'Sync complete (committed, rebased, 1 file(s) updated, pushed)');
      assert.equal(readFileSync(join(root, 'a.md'), 'utf8'), 'ONE\ntwo\nTHREE\n');
      assert.equal(srv.show('new.fountain'), 'FADE IN:');
      git(root, 'fsck', '--strict', '--no-dangling');
      const head = readFileSync(join(root, '.git/refs/heads/main'), 'utf8').trim();
      assert.equal(head, git(srv.bare, 'rev-parse', 'main'));
      assert.equal(readFileSync(join(root, '.git/refs/remotes/origin/main'), 'utf8').trim(), head);
      assert.equal(summarize(await sync(opts())), 'Sync complete (nothing to do)');
    });
  } finally {
    await srv.close();
  }
});
