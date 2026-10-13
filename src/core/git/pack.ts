// Packfile v2 reading (including OFS_DELTA and REF_DELTA entries) and
// writing (undeltified entries, as Draftling writes them).

import { ByteWriter, concat, latin1, toHex } from '../bytes.ts';
import { type GitObject, type ObjectType, hashObject } from './objects.ts';
import { Sha1, sha1 } from './sha1.ts';
import type { ObjectStore } from './store.ts';
import { deflate, inflateAt } from './zlib.ts';

const TYPE_CODES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const CODE_OF: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const OFS_DELTA = 6;
const REF_DELTA = 7;

function readVarint(d: Uint8Array, pos: { p: number }): number {
  let result = 0, shift = 0, b: number;
  do {
    b = d[pos.p++];
    result += (b & 0x7f) * 2 ** shift;
    shift += 7;
  } while (b & 0x80);
  return result;
}

export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  const pos = { p: 0 };
  const srcSize = readVarint(delta, pos);
  const dstSize = readVarint(delta, pos);
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = new Uint8Array(dstSize);
  let o = 0;
  while (pos.p < delta.length) {
    const op = delta[pos.p++];
    if (op & 0x80) {
      let off = 0, size = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) off += delta[pos.p++] * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) size += delta[pos.p++] * 2 ** (8 * i);
      if (size === 0) size = 0x10000;
      if (off + size > base.length || o + size > dstSize) throw new Error('delta copy out of range');
      out.set(base.subarray(off, off + size), o);
      o += size;
    } else if (op > 0) {
      if (o + op > dstSize || pos.p + op > delta.length) throw new Error('delta insert out of range');
      out.set(delta.subarray(pos.p, pos.p + op), o);
      o += op;
      pos.p += op;
    } else {
      throw new Error('invalid delta opcode');
    }
  }
  if (o !== dstSize) throw new Error('delta result size mismatch');
  return out;
}

// Parses a packfile and adds every object to the store. Returns the
// object ids in pack order.
export async function unpack(pack: Uint8Array, store: ObjectStore): Promise<string[]> {
  if (pack.length < 32 || latin1(pack.subarray(0, 4)) !== 'PACK') throw new Error('not a packfile');
  const dv = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  const version = dv.getUint32(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = dv.getUint32(8);
  const trailer = toHex(pack.subarray(pack.length - 20));
  if (toHex(sha1(pack.subarray(0, pack.length - 20))) !== trailer) throw new Error('packfile checksum mismatch');

  const byOffset = new Map<number, GitObject>();
  const oids: string[] = [];
  let p = 12;
  for (let n = 0; n < count; n++) {
    const start = p;
    let c = pack[p++];
    const code = (c >> 4) & 7;
    let size = c & 15, shift = 4;
    while (c & 0x80) {
      c = pack[p++];
      size += (c & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseObj: GitObject | null = null;
    if (code === OFS_DELTA) {
      c = pack[p++];
      let off = c & 0x7f;
      while (c & 0x80) {
        c = pack[p++];
        off = ((off + 1) * 128) + (c & 0x7f);
      }
      baseObj = byOffset.get(start - off) ?? null;
      if (!baseObj) throw new Error('OFS_DELTA base not found');
    } else if (code === REF_DELTA) {
      const baseOid = toHex(pack.subarray(p, p + 20));
      p += 20;
      baseObj = await store.get(baseOid);
      if (!baseObj) throw new Error(`REF_DELTA base ${baseOid} not found`);
    } else if (!TYPE_CODES[code]) {
      throw new Error(`unknown pack object type ${code}`);
    }
    const { out, used } = inflateAt(pack, p);
    p += used;
    if (out.length !== size) throw new Error('pack object size mismatch');
    const obj: GitObject = baseObj ? { type: baseObj.type, data: applyDelta(baseObj.data, out) } : { type: TYPE_CODES[code], data: out };
    byOffset.set(start, obj);
    oids.push(store.write(obj.type, obj.data));
  }
  if (p !== pack.length - 20) throw new Error('trailing data in packfile');
  return oids;
}

// Builds a packfile with the given objects, each stored whole.
export async function buildPack(store: ObjectStore, oids: string[]): Promise<Uint8Array> {
  const w = new ByteWriter();
  const head = new Uint8Array(12);
  head.set([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2]);
  new DataView(head.buffer).setUint32(8, oids.length);
  w.bytes(head);
  for (const oid of oids) {
    const obj = await store.read(oid);
    let size = obj.data.length;
    let c = (CODE_OF[obj.type] << 4) | (size & 15);
    size = Math.floor(size / 16);
    while (size > 0) {
      w.byte(c | 0x80);
      c = size & 0x7f;
      size = Math.floor(size / 128);
    }
    w.byte(c);
    w.bytes(deflate(obj.data));
  }
  const body = w.result();
  return concat([body, new Sha1().update(body).digest()]);
}

// Verifies that a raw object matches its id (used in tests and when
// reading loose objects from the device).
export function verifyObject(oid: string, obj: GitObject): boolean {
  return hashObject(obj.type, obj.data) === oid;
}
