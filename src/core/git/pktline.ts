// pkt-line framing of the Git wire protocol.

import { ByteWriter, latin1, utf8 } from '../bytes.ts';

export function pkt(line: string | Uint8Array): Uint8Array {
  const data = typeof line === 'string' ? utf8(line) : line;
  const len = data.length + 4;
  if (len > 65520) throw new Error('pkt-line too long');
  const out = new Uint8Array(len);
  out.set(utf8(len.toString(16).padStart(4, '0')));
  out.set(data, 4);
  return out;
}

export const FLUSH = utf8('0000');

// One parsed pkt-line; null data for a flush (0000) or delim (0001).
export interface Pkt {
  data: Uint8Array | null;
  end: number;
}

export function readPkt(buf: Uint8Array, pos: number): Pkt {
  if (pos + 4 > buf.length) throw new Error('truncated pkt-line');
  const len = parseInt(latin1(buf.subarray(pos, pos + 4)), 16);
  if (Number.isNaN(len)) throw new Error('invalid pkt-line length');
  if (len < 4) return { data: null, end: pos + 4 };
  if (pos + len > buf.length) throw new Error('truncated pkt-line');
  return { data: buf.subarray(pos + 4, pos + len), end: pos + len };
}

export function pktText(data: Uint8Array): string {
  const s = latin1(data);
  return s.endsWith('\n') ? s.slice(0, -1) : s;
}

export function joinPkts(parts: Array<string | Uint8Array | null>): Uint8Array {
  const w = new ByteWriter();
  for (const p of parts) w.bytes(p === null ? FLUSH : pkt(p));
  return w.result();
}
