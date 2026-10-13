// One synchronization, step for step what Draftling's git_sync.cpp
// (do_sync) does over WiFi, with the device reached over Kermit and the
// Git server over HTTP:
//
//   1. read the device's branch tip and contact the remote
//   2. fetch the remote history the device does not have yet
//   3. initial clone (first sync of an empty device)
//   4. commit the device's document files
//   5. integrate: fast-forward or rebase the local commits onto the
//      remote tip, merging per file with diff3 and committing conflicts
//      with markers
//   6. check the merged files out onto the device
//   7. push
//
// Differences, all on the side of not losing data:
//   - the remote tree is checked for files Draftling cannot handle
//     before anything is written to the device;
//   - the first sync of a device that already has documents rebases
//     them onto the remote history instead of overwriting them;
//   - sub-directories and other non-document entries under the synced
//     path are kept in local commits;
//   - the working files are written before the branch ref moves, so an
//     interrupted sync is repaired by the next one;
//   - when the device switches to another repository, its old history
//     is not pushed there (freshHistory).

import { equalBytes } from './bytes.ts';
import { DeviceRepo, hasKnownExtension, isDoc } from './device.ts';
import { GitHttpClient } from './git/http.ts';
import {
  commitTree, isAncestor, listFiles, listFirstParent, mergeBase, objectsToPush, recentCommits, spliceSubtree, subtreeForCommit,
} from './git/history.ts';
import { mergeTreesFlat } from './git/merge.ts';
import { MODE_FILE, type TreeEntry, isTreeMode } from './git/objects.ts';
import { buildPack, unpack } from './git/pack.ts';
import { ObjectStore } from './git/store.ts';

export interface SyncOptions {
  device: DeviceRepo;
  remote: GitHttpClient;
  branch: string;
  // Remote sub-directory ("notes/") or "" for the repository root.
  path: string;
  authorName: string;
  authorEmail: string;
  // Pull only: integrate and update the device, do not push.
  pullOnly?: boolean;
  // Ignore the device's existing branch history (it belongs to another
  // repository): the documents are rebased onto the new repository as
  // a fresh commit instead of carrying the old history over.
  freshHistory?: boolean;
  now?: () => Date;
  progress?: (message: string) => void;
  // Called once the device is about to be changed (working files and
  // refs), after the objects are on it: the place to point git.cfg at
  // the repository.
  beforeDeviceUpdate?: () => Promise<void>;
}

export interface SyncResult {
  committedLocal: boolean;
  cloned: boolean;
  fastForwarded: boolean;
  rebased: boolean;
  pushed: boolean;
  conflicts: string[];
  filesWritten: string[];
  filesDeleted: string[];
  objectsFetched: number;
  objectsWritten: number;
  head: string | null;
}

export class UnsupportedFilesError extends Error {
  readonly files: string[];

  constructor(files: string[]) {
    super(`the repository contains files Draftling cannot handle: ${files.slice(0, 10).join(', ')}${files.length > 10 ? ', ...' : ''}`);
    this.name = 'UnsupportedFilesError';
    this.files = files;
  }
}

export class SyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncError';
  }
}

export function summarize(r: SyncResult): string {
  const parts: string[] = [];
  if (r.cloned) parts.push('cloned');
  if (r.committedLocal) parts.push('committed');
  if (r.fastForwarded) parts.push('fast-forward');
  if (r.rebased) parts.push('rebased');
  const changed = r.filesWritten.length + r.filesDeleted.length;
  if (changed) parts.push(`${changed} file(s) updated`);
  if (r.pushed) parts.push('pushed');
  const head = r.conflicts.length ? `Sync done, ${r.conflicts.length} conflict(s)` : 'Sync complete';
  return parts.length ? `${head} (${parts.join(', ')})` : `${head} (nothing to do)`;
}

export function validBranch(b: string): boolean {
  return /^[A-Za-z0-9._\/-]{1,60}$/.test(b) && !b.includes('..') && !b.startsWith('/') && !b.endsWith('/')
    && !b.endsWith('.lock') && !b.startsWith('-');
}

export async function sync(opts: SyncOptions): Promise<SyncResult> {
  const { device, remote, branch, path } = opts;
  const progress = opts.progress ?? (() => {});
  const now = opts.now ?? (() => new Date());
  if (!validBranch(branch)) throw new SyncError(`invalid branch name: ${branch}`);
  const localRef = `refs/heads/${branch}`;
  const trackingRef = `refs/remotes/origin/${branch}`;
  const store = new ObjectStore(device);
  const result: SyncResult = {
    committedLocal: false, cloned: false, fastForwarded: false, rebased: false, pushed: false,
    conflicts: [], filesWritten: [], filesDeleted: [], objectsFetched: 0, objectsWritten: 0, head: null,
  };

  const ident = () => {
    const ts = Math.max(Math.floor(now().getTime() / 1000), 1735689600);
    const name = (opts.authorName || 'Draftling').replace(/[<>\n]/g, '');
    const email = (opts.authorEmail || 'draftling@localhost').replace(/[<>\n]/g, '');
    return `${name} <${email}> ${ts} +0000`;
  };

  // 1. local branch tip and remote advertisement
  progress('Reading the repository on the device...');
  let localHead = opts.freshHistory ? null : await device.readRef(localRef);
  if (localHead && !(await store.has(localHead))) throw new SyncError(`the device's branch points to a missing commit ${localHead}`);

  progress('Contacting remote...');
  const adv = await remote.advertise('git-upload-pack');
  const remoteSha = adv.refs.find((r) => r.name === localRef)?.oid ?? null;

  // 2. fetch what the device is missing
  if (remoteSha && !(await store.has(remoteSha))) {
    progress(localHead ? 'Fetching remote commits...' : 'Cloning history...');
    const haves = localHead ? await recentCommits(store, localHead, 16) : [];
    const pack = await remote.fetchPack([remoteSha], haves, adv.capabilities);
    if (!pack) throw new SyncError('the server sent no objects');
    result.objectsFetched = (await unpack(pack, store)).length;
    if (!(await store.has(remoteSha))) throw new SyncError('the fetched history is incomplete');
  }

  // Refuse repositories with files Draftling does not know, before
  // touching the device.
  if (remoteSha) {
    const bad = (await listFiles(store, await commitTree(store, remoteSha))).filter((f) => !hasKnownExtension(f));
    if (bad.length) throw new UnsupportedFilesError(bad);
  }

  progress('Reading files on the device...');
  const work = await device.readWorkingTree();

  // 3. initial clone onto a device without documents
  if (!localHead && remoteSha && work.size === 0) {
    localHead = remoteSha;
    result.cloned = true;
  }

  // 4. commit the working tree
  progress('Committing local changes...');
  const curSub = await subtreeForCommit(store, localHead, path);
  const curEntries = await store.readTree(curSub);
  const entries: TreeEntry[] = curEntries.filter((e) => isTreeMode(e.mode) || !isDoc(e.name));
  for (const [name, data] of work) {
    const old = curEntries.find((e) => e.name === name && !isTreeMode(e.mode));
    entries.push({ mode: old?.mode ?? MODE_FILE, name, oid: store.write('blob', data) });
  }
  const oursSub = store.writeTree(entries);
  if (oursSub !== curSub && !result.cloned) {
    const root = await spliceSubtree(store, await commitTree(store, localHead), path, oursSub);
    const nfiles = work.size;
    localHead = store.writeCommit({
      tree: root ?? store.write('tree', new Uint8Array(0)),
      parents: localHead ? [localHead] : [],
      author: ident(),
      committer: ident(),
      message: `Draftling sync: ${nfiles} file(s) at ${now().toISOString().replace(/\.\d+Z$/, 'Z')}\n`,
    });
    result.committedLocal = true;
  }

  // 5. integrate the remote
  if (remoteSha && localHead && remoteSha !== localHead && !(await isAncestor(store, remoteSha, localHead))) {
    const mb = await mergeBase(store, localHead, remoteSha);
    if (mb === localHead) {
      localHead = remoteSha;
      result.fastForwarded = true;
    } else {
      progress('Rebasing local commits...');
      const commits = await listFirstParent(store, mb, localHead);
      let newBase = remoteSha;
      const who = ident();
      for (const oid of commits) {
        const c = await store.readCommit(oid);
        const baseSub = await subtreeForCommit(store, c.parents[0] ?? null, path);
        const oursSub2 = await subtreeForCommit(store, newBase, path);
        const theirsSub = await subtreeForCommit(store, oid, path);
        const merged = await mergeTreesFlat(store, baseSub, oursSub2, theirsSub, 'ours (remote)', 'theirs (local)');
        const mergedSub = store.writeTree(merged.entries);
        const root = await spliceSubtree(store, await commitTree(store, newBase), path, mergedSub);
        let msg = c.message || 'Draftling sync\n';
        if (merged.conflicts.length) msg = `${msg.replace(/\n+$/, '')}\n\n[draftling] ${merged.conflicts.length} conflict(s) committed with markers\n`;
        newBase = store.writeCommit({
          tree: root ?? store.write('tree', new Uint8Array(0)), parents: [newBase], author: who, committer: who, message: msg,
        });
        for (const f of merged.conflicts) if (!result.conflicts.includes(f)) result.conflicts.push(f);
      }
      localHead = newBase;
      result.rebased = true;
    }
  }

  // 6. objects, working files, then refs
  if (store.pendingCount()) progress(`Writing ${store.pendingCount()} object(s) to the device...`);
  result.objectsWritten = await store.flush();

  if (localHead) {
    await opts.beforeDeviceUpdate?.();
    progress('Updating working files...');
    const sub = await subtreeForCommit(store, localHead, path);
    const tree = (await store.readTree(sub)).filter((e) => !isTreeMode(e.mode) && isDoc(e.name));
    const writes: Array<{ path: string; data: Uint8Array }> = [];
    for (const e of tree) {
      const data = (await store.read(e.oid, 'blob')).data;
      const cur = work.get(e.name);
      if (!cur || !equalBytes(cur, data)) writes.push({ path: e.name, data });
    }
    await device.put(writes);
    result.filesWritten = writes.map((w) => w.path);
    for (const name of work.keys()) {
      if (!tree.some((e) => e.name === name)) {
        await device.files.remove(name);
        result.filesDeleted.push(name);
      }
    }
    await device.setHead(localRef);
    await device.writeRef(localRef, localHead);
    if (result.cloned || (remoteSha && remoteSha === localHead)) await device.writeRef(trackingRef, localHead);
  }

  // 7. push
  if (!opts.pullOnly && localHead && localHead !== remoteSha) {
    if (remoteSha && !(await isAncestor(store, remoteSha, localHead))) {
      throw new SyncError('push blocked: remote advanced during sync -- retry');
    }
    progress('Pushing to remote...');
    const oids = await objectsToPush(store, localHead, remoteSha);
    const pack = await buildPack(store, oids);
    await remote.push(localRef, remoteSha, localHead, pack);
    await device.writeRef(trackingRef, localHead);
    result.pushed = true;
  }

  result.head = localHead;
  return result;
}
