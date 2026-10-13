// Kermit packets: framing, block checks, data encoding and Send-Init
// parameter negotiation. Reference: https://www.kermitproject.org/kpackets.html
// and the Kermit Protocol Manual (6th edition).

import { ByteWriter } from '../bytes.ts';

export const SOH = 0x01;
export const CR = 0x0d;

export const tochar = (x: number): number => x + 32;
export const unchar = (c: number): number => c - 32;
export const ctl = (c: number): number => c ^ 64;

// Capability bits of the CAPAS field.
export const CAP_LONG = 2;
export const CAP_WINDOWS = 4;
export const CAP_ATTRIBUTES = 8;

export type CheckType = 1 | 2 | 3;

export interface Packet {
  seq: number;
  type: string;
  // Still encoded (prefixed) data field.
  data: Uint8Array;
  // Block check type the packet arrived with.
  chkt?: CheckType;
}

export interface Params {
  // Longest packet (whole packet after the mark) the owner can receive.
  maxl: number;
  // Seconds the owner wants the other side to wait before resending.
  timeout: number;
  npad: number;
  padc: number;
  eol: number;
  qctl: number;
  // 8th-bit prefix; 0 when not used.
  qbin: number;
  chkt: CheckType;
  // Repeat-count prefix; 0 when not used.
  rept: number;
  capas: number;
  window: number;
  // Longest long packet the owner can receive.
  maxlx: number;
}

// Effective settings for one transaction, after negotiation.
export interface Session {
  // Maximum length of packets we send (the peer's receive limit).
  sendMax: number;
  longPackets: boolean;
  qctl: number;
  qbin: number;
  rept: number;
  chkt: CheckType;
}

export const DEFAULT_SESSION: Session = {
  sendMax: 94, longPackets: false, qctl: 0x23, qbin: 0, rept: 0, chkt: 1,
};

// Our side of the negotiation: 8-bit clean link (USB), willing to do
// 8th-bit prefixing if asked, CRC block checks, repeat counts and long
// packets.
export function localParams(maxlx = 9024): Params {
  return {
    maxl: 94, timeout: 5, npad: 0, padc: 0, eol: CR, qctl: 0x23, qbin: 0x59 /* Y */, chkt: 3,
    rept: 0x7e, capas: CAP_LONG, window: 1, maxlx,
  };
}

export function encodeParams(p: Params): Uint8Array {
  return new Uint8Array([
    tochar(p.maxl), tochar(p.timeout), tochar(p.npad), ctl(p.padc), tochar(p.eol), p.qctl,
    p.qbin || 0x4e /* N */, 0x30 + p.chkt, p.rept || 0x20, tochar(p.capas), tochar(p.window),
    tochar(Math.floor(p.maxlx / 95)), tochar(p.maxlx % 95),
  ]);
}

// Decodes a Send-Init data field; absent fields take their defaults.
export function decodeParams(d: Uint8Array): Params {
  const at = (i: number): number | undefined => (i < d.length && d[i] !== 0x20 ? d[i] : undefined);
  const p: Params = {
    maxl: at(0) !== undefined ? unchar(d[0]) : 80,
    timeout: at(1) !== undefined ? unchar(d[1]) : 5,
    npad: at(2) !== undefined ? unchar(d[2]) : 0,
    padc: at(3) !== undefined ? ctl(d[3]) : 0,
    eol: at(4) !== undefined ? unchar(d[4]) : CR,
    qctl: at(5) ?? 0x23,
    qbin: 0,
    chkt: 1,
    rept: 0,
    capas: 0,
    window: 1,
    maxlx: 500,
  };
  const qbin = at(6);
  if (qbin !== undefined) p.qbin = qbin;
  const chkt = at(7);
  if (chkt === 0x32) p.chkt = 2;
  else if (chkt === 0x33) p.chkt = 3;
  const rept = at(8);
  if (rept !== undefined) p.rept = rept;
  // CAPAS may span several bytes (bit 0 is the continuation flag).
  let i = 9;
  if (at(i) !== undefined) {
    p.capas = unchar(d[i]);
    while (i < d.length && (unchar(d[i]) & 1)) i++;
    const window = at(i + 1);
    if (window !== undefined) p.window = unchar(window);
    const x1 = at(i + 2), x2 = at(i + 3);
    if (x1 !== undefined && x2 !== undefined) p.maxlx = unchar(x1) * 95 + unchar(x2);
  }
  return p;
}

function isPrefixChar(c: number): boolean {
  return (c >= 33 && c <= 62) || (c >= 96 && c <= 126);
}

// Combines both sides' parameters into the session settings. `mine` and
// `theirs` are symmetric: the result is the same for both peers except
// for the maximum length each side may send.
export function negotiate(mine: Params, theirs: Params): Session {
  let qbin = 0;
  if (isPrefixChar(mine.qbin) && (theirs.qbin === 0x59 || theirs.qbin === mine.qbin)) qbin = mine.qbin;
  else if (isPrefixChar(theirs.qbin) && mine.qbin === 0x59) qbin = theirs.qbin;
  const chkt: CheckType = mine.chkt === theirs.chkt ? mine.chkt : 1;
  const rept = mine.rept && mine.rept === theirs.rept && isPrefixChar(mine.rept) && mine.rept !== 0x20 ? mine.rept : 0;
  const longPackets = (mine.capas & CAP_LONG) !== 0 && (theirs.capas & CAP_LONG) !== 0;
  const sendMax = longPackets ? Math.max(Math.min(theirs.maxlx, 9024), 20) : Math.min(Math.max(theirs.maxl, 20), 94);
  return { sendMax, longPackets, qctl: theirs.qctl, qbin, rept, chkt };
}

// ---- block checks ------------------------------------------------------

function crc16(data: Uint8Array): number {
  let crc = 0;
  for (const b of data) {
    let c = (crc ^ b) & 0xff;
    for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return crc;
}

export function blockCheck(data: Uint8Array, type: CheckType): number[] {
  if (type === 3) {
    const c = crc16(data);
    return [tochar((c >>> 12) & 0x0f), tochar((c >>> 6) & 0x3f), tochar(c & 0x3f)];
  }
  let s = 0;
  for (const b of data) s += b;
  if (type === 2) return [tochar((s >>> 6) & 0x3f), tochar(s & 0x3f)];
  return [tochar((s + ((s & 192) >>> 6)) & 63)];
}

// ---- framing -----------------------------------------------------------

export function buildPacket(seq: number, type: string, data: Uint8Array, chkt: CheckType, eol = CR): Uint8Array {
  const w = new ByteWriter();
  const ck = chkt;
  const n = data.length + ck;
  w.byte(SOH);
  if (n + 2 <= 94) {
    w.byte(tochar(n + 2));
    w.byte(tochar(seq & 63));
    w.byte(type.charCodeAt(0));
  } else {
    w.byte(tochar(0));
    w.byte(tochar(seq & 63));
    w.byte(type.charCodeAt(0));
    w.byte(tochar(Math.floor(n / 95)));
    w.byte(tochar(n % 95));
    const hdr = w.result().subarray(1);
    w.byte(blockCheck(hdr, 1)[0]);
  }
  w.bytes(data);
  const body = w.result().subarray(1);
  for (const c of blockCheck(body, chkt)) w.byte(c);
  w.byte(eol);
  return w.result();
}

// Accumulates received bytes and extracts packets. Bytes outside of
// packets (console output) are skipped.
export class PacketParser {
  private buf = new Uint8Array(0);

  push(data: Uint8Array): void {
    const nb = new Uint8Array(this.buf.length + data.length);
    nb.set(this.buf);
    nb.set(data, this.buf.length);
    this.buf = nb;
  }

  clear(): void {
    this.buf = new Uint8Array(0);
  }

  // Returns a packet, 'bad' for a damaged one, or null if more bytes are
  // needed. `chkts` are the block check types the packet may use, tried
  // in order (a Send-Init packet always uses type 1).
  next(chkts: CheckType[]): Packet | 'bad' | null {
    for (;;) {
      const start = this.buf.indexOf(SOH);
      if (start < 0) {
        this.buf = new Uint8Array(0);
        return null;
      }
      if (start > 0) this.buf = this.buf.slice(start);
      const b = this.buf;
      if (b.length < 2) return null;
      const len = unchar(b[1]);
      let total: number, dataStart: number;
      if (len === 0) {
        if (b.length < 7) return null;
        if (blockCheck(b.subarray(1, 6), 1)[0] !== b[6]) return this.drop();
        total = 7 + unchar(b[4]) * 95 + unchar(b[5]);
        dataStart = 7;
      } else if (len < 3 || len > 94) {
        return this.drop();
      } else {
        total = 2 + len;
        dataStart = 4;
      }
      // A mark inside the packet means it was cut short: resynchronize.
      const inner = b.subarray(1, Math.min(total, b.length)).indexOf(SOH);
      if (inner >= 0) {
        this.buf = b.slice(inner + 1);
        return 'bad';
      }
      if (b.length < total) return null;
      this.buf = b.slice(total);
      for (const chkt of chkts) {
        if (total - chkt < dataStart) continue;
        const expect = blockCheck(b.subarray(1, total - chkt), chkt);
        if (expect.every((c, i) => c === b[total - chkt + i])) {
          return { seq: unchar(b[2]), type: String.fromCharCode(b[3]), data: b.slice(dataStart, total - chkt), chkt };
        }
      }
      return 'bad';
    }
  }

  private drop(): 'bad' {
    this.buf = this.buf.slice(1);
    return 'bad';
  }
}

// ---- data field encoding ----------------------------------------------

function encodeByte(w: ByteWriter, b: number, s: Session): void {
  if (s.qbin && b & 0x80) {
    w.byte(s.qbin);
    b &= 0x7f;
  }
  const a7 = b & 0x7f;
  if (a7 < 32 || a7 === 127) {
    w.byte(s.qctl);
    w.byte(ctl(b));
  } else if (a7 === s.qctl || (s.qbin && a7 === s.qbin) || (s.rept && a7 === s.rept)) {
    w.byte(s.qctl);
    w.byte(b);
  } else {
    w.byte(b);
  }
}

// Encodes as much of `src` (from `offset`) as fits into `room` bytes.
// Returns the encoded field and the number of source bytes consumed.
export function encodeChunk(src: Uint8Array, offset: number, room: number, s: Session): { data: Uint8Array; used: number } {
  const w = new ByteWriter();
  let i = offset;
  while (i < src.length) {
    const b = src[i];
    let run = 1;
    if (s.rept) while (i + run < src.length && src[i + run] === b && run < 94) run++;
    const one = new ByteWriter();
    let used: number;
    if (s.rept && run > 2) {
      one.byte(s.rept);
      one.byte(tochar(run));
      encodeByte(one, b, s);
      used = run;
    } else {
      encodeByte(one, b, s);
      used = 1;
    }
    if (w.length + one.length > room) break;
    w.bytes(one.result());
    i += used;
  }
  return { data: w.result(), used: i - offset };
}

export function encodeData(src: Uint8Array, s: Session): Uint8Array {
  return encodeChunk(src, 0, Number.MAX_SAFE_INTEGER, s).data;
}

export function decodeData(d: Uint8Array, s: Session): Uint8Array {
  const w = new ByteWriter();
  let i = 0;
  while (i < d.length) {
    let c = d[i++];
    let n = 1;
    if (s.rept && c === s.rept) {
      n = unchar(d[i++]);
      c = d[i++];
    }
    let hi = 0;
    if (s.qbin && c === s.qbin) {
      hi = 0x80;
      c = d[i++];
    }
    if (c === s.qctl) {
      c = d[i++];
      const a7 = c & 0x7f;
      if (a7 >= 0x3f && a7 <= 0x5f) c = ctl(c);
    }
    c |= hi;
    for (let k = 0; k < n; k++) w.byte(c);
  }
  return w.result();
}

// Room for data in a packet of at most `sendMax` bytes after the mark.
export function dataRoom(s: Session): number {
  return s.longPackets ? s.sendMax - 6 - s.chkt : s.sendMax - 2 - s.chkt;
}

// Generic server command (G packet): a command letter followed by
// length-prefixed arguments.
export function genericCommand(cmd: string, ...args: string[]): Uint8Array {
  const w = new ByteWriter();
  w.byte(cmd.charCodeAt(0));
  for (const a of args) {
    const b = new TextEncoder().encode(a);
    if (b.length > 94) throw new Error('generic command argument too long');
    w.byte(tochar(b.length));
    w.bytes(b);
  }
  return w.result();
}

export function parseGeneric(d: Uint8Array): { cmd: string; args: string[] } {
  const cmd = String.fromCharCode(d[0]);
  const args: string[] = [];
  let i = 1;
  while (i < d.length) {
    const n = unchar(d[i++]);
    args.push(new TextDecoder().decode(d.subarray(i, i + n)));
    i += n;
  }
  return { cmd, args };
}
