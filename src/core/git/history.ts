// History walks and sub-tree operations, following Draftling's
// git_odb.c so that both produce the same results on the same history.

import { MODE_TREE, type TreeEntry, isTreeMode } from './objects.ts';
import type { ObjectStore } from './store.ts';

// True if `anc` is an ancestor of (or equal to) `desc`. null is the
// ancestor of everything.
export async function isAncestor(store: ObjectStore, anc: string | null, desc: string): Promise<boolean> {
  if (!anc || anc === desc) return true;
  const seen = new Set<string>();
  const queue = [desc];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    if (seen.has(cur)) continue;
    seen.add(cur);
    const c = await store.readCommit(cur);
    for (const p of c.parents) {
      if (p === anc) return true;
      queue.push(p);
    }
  }
  return false;
}

async function ancestry(store: ObjectStore, start: string): Promise<Set<string>> {
  const seen = new Set<string>();
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    if (seen.has(cur)) continue;
    seen.add(cur);
    const c = await store.readCommit(cur);
    queue.push(...c.parents);
  }
  return seen;
}

// First commit reachable from `b` (breadth first) that is also reachable
// from `a`; null when the histories are unrelated.
export async function mergeBase(store: ObjectStore, a: string, b: string): Promise<string | null> {
  if (a === b) return a;
  const fromA = await ancestry(store, a);
  const seen = new Set<string>();
  const queue = [b];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (fromA.has(cur)) return cur;
    const c = await store.readCommit(cur);
    queue.push(...c.parents);
  }
  return null;
}

// Commits in (base, head], oldest first, following first parents.
export async function listFirstParent(store: ObjectStore, base: string | null, head: string): Promise<string[]> {
  const out: string[] = [];
  let cur: string | null = head;
  while (cur && cur !== base) {
    out.push(cur);
    const c = await store.readCommit(cur);
    cur = c.parents[0] ?? null;
  }
  return out.reverse();
}

// The most recent first-parent commits from `head`, newest first.
export async function recentCommits(store: ObjectStore, head: string, max: number): Promise<string[]> {
  const out: string[] = [];
  let cur: string | null = head;
  while (cur && out.length < max) {
    out.push(cur);
    const c = await store.readCommit(cur);
    cur = c.parents[0] ?? null;
  }
  return out;
}

async function walkTree(store: ObjectStore, tree: string, exclude: Set<string> | null, out: Set<string>): Promise<void> {
  if (exclude?.has(tree) || out.has(tree)) return;
  out.add(tree);
  for (const e of await store.readTree(tree)) {
    if (isTreeMode(e.mode)) await walkTree(store, e.oid, exclude, out);
    else if (!exclude?.has(e.oid)) out.add(e.oid);
  }
}

// Every object reachable from `head` but not from `have`, as Draftling
// computes it for a push: the walk stops at `have`, and objects of the
// tree of `have` are excluded (sending a few objects the server already
// has is harmless).
export async function objectsToPush(store: ObjectStore, head: string, have: string | null): Promise<string[]> {
  const haveObjs = new Set<string>();
  if (have) await walkTree(store, (await store.readCommit(have)).tree, null, haveObjs);
  const out = new Set<string>();
  const walked = new Set<string>();
  const queue = [head];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    if (walked.has(cur) || cur === have) continue;
    walked.add(cur);
    out.add(cur);
    const c = await store.readCommit(cur);
    await walkTree(store, c.tree, haveObjs, out);
    queue.push(...c.parents);
  }
  return [...out];
}

function splitPrefix(prefix: string): string[] {
  return prefix.split('/').filter((s) => s.length > 0);
}

// The tree at `prefix` ("a/b/" or "") inside `root`; null if absent.
export async function subtreeOid(store: ObjectStore, root: string | null, prefix: string): Promise<string | null> {
  let cur = root;
  for (const name of splitPrefix(prefix)) {
    if (!cur) return null;
    const e = (await store.readTree(cur)).find((x) => x.name === name);
    if (!e || !isTreeMode(e.mode)) return null;
    cur = e.oid;
  }
  return cur;
}

// A new root tree with `sub` placed at `prefix`, creating intermediate
// trees; an empty (null) sub-tree removes the directory, and directories
// left empty disappear.
export async function spliceSubtree(store: ObjectStore, root: string | null, prefix: string, sub: string | null): Promise<string | null> {
  const names = splitPrefix(prefix);
  const rec = async (node: string | null, depth: number): Promise<string | null> => {
    if (depth === names.length) return sub;
    const entries: TreeEntry[] = await store.readTree(node);
    const idx = entries.findIndex((e) => e.name === names[depth]);
    const child = idx >= 0 && isTreeMode(entries[idx].mode) ? entries[idx].oid : null;
    const newChild = await rec(child, depth + 1);
    if (idx >= 0) entries.splice(idx, 1);
    if (newChild) entries.push({ mode: MODE_TREE, name: names[depth], oid: newChild });
    return store.writeTree(entries);
  };
  return rec(root, 0);
}

export async function commitTree(store: ObjectStore, commit: string | null): Promise<string | null> {
  return commit ? (await store.readCommit(commit)).tree : null;
}

export async function subtreeForCommit(store: ObjectStore, commit: string | null, prefix: string): Promise<string | null> {
  return subtreeOid(store, await commitTree(store, commit), prefix);
}

// All file paths in a tree, recursively ("dir/name").
export async function listFiles(store: ObjectStore, tree: string | null, base = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await store.readTree(tree)) {
    if (isTreeMode(e.mode)) out.push(...await listFiles(store, e.oid, `${base}${e.name}/`));
    else out.push(base + e.name);
  }
  return out;
}
