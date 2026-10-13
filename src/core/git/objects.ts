// Git objects: blobs, trees and commits, and their ids. Object ids are
// 40-digit lowercase hex strings; "no object" is null.

import { ByteWriter, concat, fromHex, fromUtf8, latin1, toHex, utf8 } from '../bytes.ts';
import { sha1 } from './sha1.ts';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export const ZERO_OID = '0'.repeat(40);

export const MODE_FILE = 0o100644;
export const MODE_EXEC = 0o100755;
export const MODE_TREE = 0o040000;

export interface GitObject {
  type: ObjectType;
  data: Uint8Array;
}

export function isOid(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

// "<type> <size>\0" followed by the payload: what Git hashes and stores.
export function objectHeader(type: ObjectType, size: number): Uint8Array {
  return utf8(`${type} ${size}\0`);
}

export function hashObject(type: ObjectType, data: Uint8Array): string {
  return toHex(sha1(concat([objectHeader(type, data.length), data])));
}

export function encodeLoose(type: ObjectType, data: Uint8Array): Uint8Array {
  return concat([objectHeader(type, data.length), data]);
}

export function decodeLoose(raw: Uint8Array): GitObject {
  const nul = raw.indexOf(0);
  if (nul < 0) throw new Error('malformed loose object');
  const [type, size] = latin1(raw.subarray(0, nul)).split(' ');
  if (!isObjectType(type)) throw new Error(`unknown object type ${type}`);
  const data = raw.subarray(nul + 1);
  if (Number(size) !== data.length) throw new Error('loose object size mismatch');
  return { type, data };
}

export function isObjectType(s: string): s is ObjectType {
  return s === 'commit' || s === 'tree' || s === 'blob' || s === 'tag';
}

// ---- trees -----------------------------------------------------------

export interface TreeEntry {
  mode: number;
  name: string;
  oid: string;
}

export function isTreeMode(mode: number): boolean {
  return (mode & 0o170000) === MODE_TREE;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    const mode = parseInt(latin1(data.subarray(i, sp)), 8);
    const name = fromUtf8(data.subarray(sp + 1, nul));
    out.push({ mode, name, oid: toHex(data.subarray(nul + 1, nul + 21)) });
    i = nul + 21;
  }
  return out;
}

// Git sorts tree entries by name bytes, comparing directories as if
// their name ended with '/'.
function sortKey(e: TreeEntry): Uint8Array {
  return utf8(isTreeMode(e.mode) ? e.name + '/' : e.name);
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

export function serializeTree(entries: TreeEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => compareBytes(sortKey(a), sortKey(b)));
  const w = new ByteWriter();
  for (const e of sorted) {
    w.text(`${e.mode.toString(8)} ${e.name}`);
    w.byte(0);
    w.bytes(fromHex(e.oid));
  }
  return w.result();
}

// ---- commits ---------------------------------------------------------

export interface Commit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Uint8Array): Commit {
  const text = fromUtf8(data);
  const sep = text.indexOf('\n\n');
  const head = sep < 0 ? text : text.slice(0, sep);
  const c: Commit = { tree: '', parents: [], author: '', committer: '', message: sep < 0 ? '' : text.slice(sep + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) c.tree = line.slice(5, 45);
    else if (line.startsWith('parent ')) c.parents.push(line.slice(7, 47));
    else if (line.startsWith('author ')) c.author = line.slice(7);
    else if (line.startsWith('committer ')) c.committer = line.slice(10);
  }
  if (!isOid(c.tree)) throw new Error('commit without tree');
  return c;
}

export function serializeCommit(c: Commit): Uint8Array {
  let s = `tree ${c.tree}\n`;
  for (const p of c.parents) s += `parent ${p}\n`;
  s += `author ${c.author}\ncommitter ${c.committer}\n\n${c.message}`;
  if (!s.endsWith('\n')) s += '\n';
  return utf8(s);
}

// The tree id of an empty tree (used when hashing, never stored).
export const EMPTY_TREE_OID = hashObject('tree', new Uint8Array(0));
