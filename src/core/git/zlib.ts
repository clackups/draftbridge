// zlib streams as used by Git: loose objects and packfile entries.

import { Inflate, deflate as pakoDeflate, inflate as pakoInflate } from 'pako';

export function deflate(data: Uint8Array): Uint8Array {
  return pakoDeflate(data);
}

export function inflate(data: Uint8Array): Uint8Array {
  return pakoInflate(data);
}

// Inflates one zlib stream starting at `offset`, which may be followed by
// other data (packfile entries are concatenated without lengths).
// Returns the output and the number of input bytes the stream used.
export function inflateAt(data: Uint8Array, offset: number): { out: Uint8Array; used: number } {
  const inf = new Inflate();
  let strm: { next_in: number } | null = null;
  inf.onStart = (s) => { strm = s; };
  inf.push(data.subarray(offset), false);
  if (!inf.ended || inf.err || !strm) throw new Error(`zlib stream at offset ${offset} is truncated or corrupt`);
  return { out: inf.result, used: (strm as { next_in: number }).next_in };
}
