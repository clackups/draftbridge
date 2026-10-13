// Flat three-way tree merge with a diff3 line merge and textual conflict
// markers, a port of Draftling's git_merge.c: Draftbridge must merge
// exactly like the device does when it syncs over WiFi.

import { ByteWriter, utf8 } from '../bytes.ts';
import { MODE_FILE, type TreeEntry } from './objects.ts';
import type { ObjectStore } from './store.ts';

// Above this many lines on any side the line merge is skipped and the
// whole file becomes one conflict (same limit as on the device).
export const MERGE_MAX_LINES = 1400;

function splitLines(data: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let i = 0;
  while (i < data.length) {
    let j = data.indexOf(0x0a, i);
    j = j < 0 ? data.length : j + 1;
    out.push(data.subarray(i, j));
    i = j;
  }
  return out;
}

function lineEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function regionEq(a: Uint8Array[], a0: number, a1: number, b: Uint8Array[], b0: number, b1: number): boolean {
  if (a1 - a0 !== b1 - b0) return false;
  for (let i = 0; i < a1 - a0; i++) if (!lineEq(a[a0 + i], b[b0 + i])) return false;
  return true;
}

// match[i] = index in b of the line aligned with a[i], or -1.
function lcsAlign(a: Uint8Array[], b: Uint8Array[]): Int32Array {
  const na = a.length, nb = b.length;
  const match = new Int32Array(na).fill(-1);
  if (na === 0 || nb === 0) return match;
  const cols = nb + 1;
  const dp = new Uint16Array((na + 1) * cols);
  for (let i = na - 1; i >= 0; i--) {
    for (let j = nb - 1; j >= 0; j--) {
      if (lineEq(a[i], b[j])) dp[i * cols + j] = dp[(i + 1) * cols + j + 1] + 1;
      else dp[i * cols + j] = Math.max(dp[(i + 1) * cols + j], dp[i * cols + j + 1]);
    }
  }
  let i = 0, j = 0;
  while (i < na && j < nb) {
    if (lineEq(a[i], b[j])) {
      match[i++] = j++;
    } else if (dp[(i + 1) * cols + j] >= dp[i * cols + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return match;
}

class Out {
  w = new ByteWriter();
  private last = -1;

  put(b: Uint8Array): void {
    if (b.length === 0) return;
    this.w.bytes(b);
    this.last = b[b.length - 1];
  }

  lines(v: Uint8Array[], from: number, to: number): void {
    for (let i = from; i < to; i++) this.put(v[i]);
  }

  ensureNl(): void {
    if (this.w.length > 0 && this.last !== 0x0a) this.put(utf8('\n'));
  }

  text(s: string): void {
    this.put(utf8(s));
  }
}

export function diff3Merge(base: Uint8Array, ours: Uint8Array, theirs: Uint8Array,
  oursLabel: string, theirsLabel: string): { data: Uint8Array; conflict: boolean } {
  const O = splitLines(base), A = splitLines(ours), B = splitLines(theirs);
  const out = new Out();
  let conflict = false;

  if (O.length > MERGE_MAX_LINES || A.length > MERGE_MAX_LINES || B.length > MERGE_MAX_LINES) {
    out.ensureNl();
    out.text(`<<<<<<< ${oursLabel}\n`);
    out.put(ours);
    out.ensureNl();
    out.text('=======\n');
    out.put(theirs);
    out.ensureNl();
    out.text(`>>>>>>> ${theirsLabel}\n`);
    return { data: out.w.result(), conflict: true };
  }

  const ma = lcsAlign(O, A);
  const mb = lcsAlign(O, B);
  let op = -1, ap = -1, bp = -1;
  for (let k = 0; k <= O.length; k++) {
    let oc: number, ac: number, bc: number;
    if (k === O.length) {
      oc = O.length; ac = A.length; bc = B.length;
    } else if (ma[k] >= 0 && mb[k] >= 0 && ma[k] > ap && mb[k] > bp) {
      oc = k; ac = ma[k]; bc = mb[k];
    } else {
      continue;
    }
    const o0 = op + 1, a0 = ap + 1, b0 = bp + 1;
    const aChanged = !regionEq(A, a0, ac, O, o0, oc);
    const bChanged = !regionEq(B, b0, bc, O, o0, oc);
    if (!aChanged && !bChanged) {
      out.lines(O, o0, oc);
    } else if (aChanged && !bChanged) {
      out.lines(A, a0, ac);
    } else if (!aChanged && bChanged) {
      out.lines(B, b0, bc);
    } else if (regionEq(A, a0, ac, B, b0, bc)) {
      out.lines(A, a0, ac);
    } else {
      out.ensureNl();
      out.text(`<<<<<<< ${oursLabel}\n`);
      out.lines(A, a0, ac);
      out.ensureNl();
      out.text('=======\n');
      out.lines(B, b0, bc);
      out.ensureNl();
      out.text(`>>>>>>> ${theirsLabel}\n`);
      conflict = true;
    }
    if (oc < O.length) out.put(O[oc]);
    op = oc; ap = ac; bp = bc;
  }
  return { data: out.w.result(), conflict };
}

export interface MergeResult {
  entries: TreeEntry[];
  conflicts: string[];
}

async function blobData(store: ObjectStore, oid: string | null): Promise<Uint8Array> {
  return oid ? (await store.read(oid, 'blob')).data : new Uint8Array(0);
}

// Merges two flat trees against their common base, per path.
export async function mergeTreesFlat(store: ObjectStore, base: string | null, ours: string | null, theirs: string | null,
  oursLabel: string, theirsLabel: string): Promise<MergeResult> {
  const [b, o, t] = await Promise.all([store.readTree(base), store.readTree(ours), store.readTree(theirs)]);
  const find = (list: TreeEntry[], name: string) => list.find((e) => e.name === name) ?? null;
  const names: string[] = [];
  for (const list of [o, t, b]) for (const e of list) if (!names.includes(e.name)) names.push(e.name);

  const entries: TreeEntry[] = [];
  const conflicts: string[] = [];
  for (const name of names) {
    const be = find(b, name), oe = find(o, name), te = find(t, name);
    const bo = be?.oid ?? null, oo = oe?.oid ?? null, to = te?.oid ?? null;
    let result: TreeEntry | null;
    if (oo === to) {
      result = oe;
    } else if (oo === bo) {
      result = te;
    } else if (to === bo) {
      result = oe;
    } else if (!oo || !to) {
      // delete/modify: keep the surviving content
      result = oe ?? te;
      conflicts.push(name);
    } else {
      const merged = diff3Merge(await blobData(store, bo), await blobData(store, oo), await blobData(store, to), oursLabel, theirsLabel);
      result = { mode: oe?.mode ?? MODE_FILE, name, oid: store.write('blob', merged.data) };
      if (merged.conflict) conflicts.push(name);
    }
    if (result) entries.push(result);
  }
  return { entries, conflicts };
}
