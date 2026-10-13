import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryPipe } from '../src/core/kermit/channel.ts';
import { KermitClient, parseDirListing } from '../src/core/kermit/client.ts';
import { KermitServer, MemoryFs, safePath } from '../src/core/kermit/server.ts';
import {
  DEFAULT_SESSION, PacketParser, buildPacket, decodeData, decodeParams, encodeData, encodeParams, localParams, negotiate,
} from '../src/core/kermit/packet.ts';

function randomBytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x >>> 16;
  }
  return out;
}

function setup(tamper?: Parameters<typeof memoryPipe>[0], opts = { timeoutMs: 300, retries: 20 }) {
  const [a, b] = memoryPipe(tamper);
  const fs = new MemoryFs();
  const server = new KermitServer(b, fs, opts);
  void server.serve();
  const client = new KermitClient(a, opts);
  return { fs, server, client };
}

test('data encoding round trip with all byte values', () => {
  const all = new Uint8Array(512);
  for (let i = 0; i < 512; i++) all[i] = i & 255;
  const sessions = [
    DEFAULT_SESSION,
    { ...DEFAULT_SESSION, rept: 0x7e },
    { ...DEFAULT_SESSION, rept: 0x7e, qbin: 0x26 },
  ];
  for (const s of sessions) {
    const enc = encodeData(all, s);
    for (const b of enc) assert.ok(b !== 0x01, 'no raw SOH in encoded data');
    assert.deepEqual(decodeData(enc, s), all);
    const runs = new Uint8Array(300).fill(0x23);
    assert.deepEqual(decodeData(encodeData(runs, s), s), runs);
  }
});

test('send-init parameters negotiate', () => {
  const p = localParams(4000);
  const back = decodeParams(encodeParams(p));
  assert.equal(back.maxlx, 4000);
  assert.equal(back.chkt, 3);
  const s = negotiate(localParams(), back);
  assert.equal(s.longPackets, true);
  assert.equal(s.sendMax, 4000);
  assert.equal(s.chkt, 3);
  assert.equal(s.rept, 0x7e);
  // A minimal peer: only MAXL..QCTL
  const minimal = decodeParams(encodeParams(p).subarray(0, 6));
  const s2 = negotiate(localParams(), minimal);
  assert.equal(s2.chkt, 1);
  assert.equal(s2.longPackets, false);
  assert.equal(s2.rept, 0);
});

test('packet framing, long packets and noise', () => {
  const parser = new PacketParser();
  const data = encodeData(randomBytes(3000), DEFAULT_SESSION);
  parser.push(new TextEncoder().encode('boot log line\r\n'));
  parser.push(buildPacket(5, 'D', data, 3));
  parser.push(buildPacket(6, 'Y', new Uint8Array(0), 1));
  const p = parser.next([3]);
  assert.ok(p && p !== 'bad');
  assert.equal(p.seq, 5);
  assert.deepEqual(p.data, data);
  const y = parser.next([1]);
  assert.ok(y && y !== 'bad' && y.type === 'Y');
  const bad = buildPacket(7, 'D', new Uint8Array([65, 66, 67]), 3);
  bad[5] ^= 1;
  parser.push(bad);
  assert.equal(parser.next([3]), 'bad');
});

test('dir listing parser', () => {
  const listing = 'a.md                                         12  2026-10-12 09:41\r\n'
    + '.git                                      <DIR>  2026-10-12 09:41\r\n'
    + 'a name with spaces that is longer than thirty-six.md       1234  2026-01-02 03:04\r\n';
  assert.deepEqual(parseDirListing(listing), [
    { name: 'a.md', dir: false }, { name: '.git', dir: true },
    { name: 'a name with spaces that is longer than thirty-six.md', dir: false },
  ]);
  assert.deepEqual(parseDirListing('No files\r\n'), []);
  assert.deepEqual(parseDirListing('x.md\nsub/\n'), [{ name: 'x.md', dir: false }, { name: 'sub', dir: true }]);
  assert.equal(safePath('../x'), null);
  assert.equal(safePath('/etc/passwd'), 'etc/passwd');
  assert.equal(safePath('.git/objects/ab/cd'), '.git/objects/ab/cd');
});

test('client and server: send, get, dir, delete, mkdir, finish', async () => {
  const { fs, server, client } = setup();
  const big = randomBytes(50000);
  // the server does not create directories
  await assert.rejects(client.send([{ path: '.git/objects/ab/cdef', data: big }]), /Cannot create file/);
  assert.equal(await client.mkdir('.git'), true);
  assert.equal(await client.mkdir('.git'), false);
  assert.equal(await client.mkdir('.git/objects'), true);
  assert.equal(await client.mkdir('.git/objects/ab'), true);
  await client.send([{ path: 'a.md', data: new TextEncoder().encode('# Hello\n') }, { path: '.git/objects/ab/cdef', data: big }, { path: 'empty.txt', data: new Uint8Array(0) }]);
  assert.deepEqual(fs.files.get('.git/objects/ab/cdef'), big);
  assert.equal(fs.files.get('empty.txt')?.length, 0);
  assert.deepEqual(await client.get('.git/objects/ab/cdef'), big);
  assert.equal((await client.get('empty.txt'))?.length, 0);
  assert.equal(await client.get('missing.md'), null);
  assert.equal(await client.get('nodir/missing.md'), null);
  assert.deepEqual(await client.dir(''), [
    { name: '.git', dir: true }, { name: 'a.md', dir: false }, { name: 'empty.txt', dir: false },
  ]);
  assert.equal(await client.dir('nope'), null);
  // a long listing (padded names: repeat compression after negotiation)
  // goes through a text transfer
  const names = Array.from({ length: 40 }, (_, i) => `file-number-${i}.md`);
  await client.send(names.map((n) => ({ path: n, data: new Uint8Array([1]) })));
  assert.equal((await client.dir(''))!.length, 43);
  // names in upper case only are stored in lower case
  await client.send([{ path: 'README.TXT', data: new Uint8Array([2]) }]);
  assert.ok(fs.files.has('readme.txt'));
  await client.remove('a.md');
  await client.remove('a.md');
  assert.equal(fs.files.has('a.md'), false);
  await client.resetDirectory();
  await client.finish();
  assert.equal(server.finished, 1);
  // the server keeps serving after FINISH
  assert.deepEqual(await client.get('empty.txt'), new Uint8Array(0));
  server.stop();
});

test('transfers survive corrupted and lost packets', async () => {
  let n = 0;
  const { fs, server, client } = setup((data) => {
    n++;
    if (n % 7 === 0) return null;
    if (n % 5 === 0) data[Math.floor(data.length / 2)] ^= 0x10;
    return data;
  }, { timeoutMs: 100, retries: 30 });
  fs.dirs.add('d');
  const big = randomBytes(30000, 7);
  for (let i = 0; i < 4; i++) {
    await client.send([{ path: 'd/x.bin', data: big }, { path: `y${i}.md`, data: new Uint8Array([10, 11]) }]);
    assert.deepEqual(fs.files.get('d/x.bin'), big);
    assert.deepEqual(await client.get('d/x.bin'), big);
    assert.equal((await client.dir('d'))!.length, 1);
    await client.remove(`y${i}.md`);
  }
  assert.equal((await client.dir(''))!.length, 1);
  server.stop();
});
