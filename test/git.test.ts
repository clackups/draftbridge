import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha1 } from '../src/core/git/sha1.ts';
import { toHex, utf8, fromUtf8 } from '../src/core/bytes.ts';
import { diff3Merge, MERGE_MAX_LINES } from '../src/core/git/merge.ts';
import { MemoryBackend, ObjectStore } from '../src/core/git/store.ts';
import { buildPack, unpack } from '../src/core/git/pack.ts';
import { hashObject, parseTree, serializeTree, MODE_FILE, MODE_TREE } from '../src/core/git/objects.ts';
import { hasKnownExtension, isDoc } from '../src/core/device.ts';
import { git } from './helpers.ts';

test('sha1 matches node:crypto', () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100000]) {
    const data = new Uint8Array(n).map((_, i) => (i * 31 + n) & 255);
    assert.equal(toHex(sha1(data)), createHash('sha1').update(data).digest('hex'), `length ${n}`);
  }
  assert.equal(hashObject('blob', utf8('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
});

test('trees are sorted the way git sorts them', () => {
  const oid = 'ce013625030ba8dba906f756967f9e9ca394464a';
  const entries = [
    { mode: MODE_FILE, name: 'a.md', oid }, { mode: MODE_TREE, name: 'a', oid }, { mode: MODE_FILE, name: 'a-b', oid },
  ];
  assert.deepEqual(parseTree(serializeTree(entries)).map((e) => e.name), ['a-b', 'a.md', 'a']);
});

const merge = (b: string, o: string, t: string) => {
  const r = diff3Merge(utf8(b), utf8(o), utf8(t), 'ours (remote)', 'theirs (local)');
  return { text: fromUtf8(r.data), conflict: r.conflict };
};

test('diff3 merge', () => {
  assert.deepEqual(merge('a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nC\n'), { text: 'A\nb\nC\n', conflict: false });
  assert.deepEqual(merge('a\nb\nc\n', 'a\nX\nc\n', 'a\nX\nc\n'), { text: 'a\nX\nc\n', conflict: false });
  assert.deepEqual(merge('a\nb\nc\n', 'a\nX\nc\n', 'a\nY\nc\n'),
    { text: 'a\n<<<<<<< ours (remote)\nX\n=======\nY\n>>>>>>> theirs (local)\nc\n', conflict: true });
  // no final newline on one side
  assert.deepEqual(merge('a\n', 'a\nb', 'c\na\n'), { text: 'c\na\nb', conflict: false });
  // empty base: whole-file conflict unless identical
  assert.equal(merge('', 'x\n', 'y\n').conflict, true);
  const big = Array.from({ length: MERGE_MAX_LINES + 1 }, (_, i) => `${i}\n`).join('');
  const r = merge(big, big + 'o\n', big + 't\n');
  assert.equal(r.conflict, true);
  assert.ok(r.text.startsWith('<<<<<<< ours (remote)\n'));
});

test('document names and extensions', () => {
  assert.equal(isDoc('a.md'), true);
  assert.equal(isDoc('.a.md.meta'), false);
  assert.equal(isDoc('.md'), false);
  assert.equal(isDoc('x.MD'), false);
  assert.equal(isDoc('git.cfg'), false);
  assert.equal(hasKnownExtension('dir/a.fountain'), true);
  assert.equal(hasKnownExtension('LICENSE'), false);
  assert.equal(hasKnownExtension('.gitignore'), false);
  assert.equal(hasKnownExtension('a.png'), false);
});

test('packs from git (with deltas) unpack, and our packs are valid for git', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dbr-pack-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    let text = '';
    for (let i = 0; i < 30; i++) {
      text += `line ${i} of a long document that changes a little every time\n`.repeat(20);
      writeFileSync(join(dir, 'doc.md'), text);
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', `v${i}`);
    }
    git(dir, 'gc', '-q', '--aggressive');
    const objects = git(dir, 'rev-list', '--objects', '--all').split('\n').map((l) => l.split(' ')[0]);
    const pack = execFileSync('git', ['pack-objects', '--stdout', '--delta-base-offset'], { cwd: dir, input: objects.join('\n') + '\n' });
    const theirs = join(dir, 'theirs.pack');
    writeFileSync(theirs, pack);
    execFileSync('git', ['index-pack', theirs], { cwd: dir });
    const stats = execFileSync('git', ['verify-pack', '-v', theirs.replace(/\.pack$/, '.idx')], { cwd: dir }).toString();
    assert.match(stats, /chain length = \d+: \d+ objects?/, 'the pack uses deltas');
    const store = new ObjectStore(new MemoryBackend());
    const got = await unpack(new Uint8Array(pack), store);
    assert.deepEqual(new Set(got), new Set(objects));
    // and back: git indexes the pack we write
    const ours = await buildPack(store, got);
    const out = join(dir, 'ours.pack');
    writeFileSync(out, ours);
    execFileSync('git', ['index-pack', out], { cwd: dir });
    const listed = execFileSync('git', ['verify-pack', '-v', out.replace(/\.pack$/, '.idx')], { cwd: dir }).toString();
    assert.ok(listed.includes(objects[0]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
