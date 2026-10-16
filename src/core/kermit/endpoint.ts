// Stop-and-wait Kermit transfer logic shared by the client (Draftbridge)
// and the reference server (the device model used in tests): sending a
// batch of files and receiving one.

import type { ByteChannel } from './channel.ts';
import {
  type CheckType, type Packet, type Params, type Session, DEFAULT_SESSION, PacketParser, buildPacket, dataRoom,
  decodeData, decodeParams, encodeChunk, encodeData, encodeParams, localParams, negotiate,
} from './packet.ts';

export class KermitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KermitError';
  }
}

// Error reported by the other side in an E packet.
export class KermitRemoteError extends KermitError {
  constructor(message: string) {
    super(message);
    this.name = 'KermitRemoteError';
  }
}

export interface EndpointOptions {
  // How long to wait for a packet before resending / NAKing.
  timeoutMs?: number;
  retries?: number;
  // The same for the I packet that starts every client command. The
  // server answers it at once, so a short wait tells quickly that the
  // server is gone. Default: timeoutMs and retries.
  initTimeoutMs?: number;
  initRetries?: number;
  // Longest long packet we accept.
  maxlx?: number;
  log?: (line: string) => void;
}

export interface TransferItem {
  name: string;
  data: Uint8Array;
  // Sent as text to display (X packet) instead of a file (F packet).
  display?: boolean;
}

export const next = (seq: number): number => (seq + 1) & 63;
const prev = (seq: number): number => (seq + 63) & 63;

export class Endpoint {
  protected ch: ByteChannel;
  protected parser = new PacketParser();
  protected timeoutMs: number;
  protected retries: number;
  protected initTimeoutMs: number | undefined;
  protected initRetries: number | undefined;
  protected mine: Params;
  protected log: (line: string) => void;
  // Settings of the last parameter negotiation (I or S exchange).
  protected session: Session = DEFAULT_SESSION;

  constructor(ch: ByteChannel, opts: EndpointOptions = {}) {
    this.ch = ch;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.retries = opts.retries ?? 8;
    this.initTimeoutMs = opts.initTimeoutMs;
    this.initRetries = opts.initRetries;
    this.mine = localParams(opts.maxlx ?? 9024);
    this.log = opts.log ?? (() => {});
  }

  // Changes how long to wait for packets and how often to retry.
  setTimeouts(timeoutMs: number, retries: number): void {
    this.timeoutMs = timeoutMs;
    this.retries = retries;
  }

  protected async sendPacket(seq: number, type: string, data: Uint8Array, chkt: CheckType): Promise<void> {
    await this.ch.write(buildPacket(seq, type, data, chkt));
  }

  // Next packet; 'bad' for a damaged one, null on timeout.
  protected async receive(chkts: CheckType[], timeoutMs = this.timeoutMs): Promise<Packet | 'bad' | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const p = this.parser.next(chkts);
      if (p) return p;
      const left = deadline - Date.now();
      if (left <= 0) return null;
      const chunk = await this.ch.read(left);
      if (!chunk) return null;
      this.parser.push(chunk);
    }
  }

  protected async sendError(seq: number, message: string, s: Session = DEFAULT_SESSION): Promise<void> {
    await this.sendPacket(seq, 'E', encodeData(new TextEncoder().encode(message), s), s.chkt);
  }

  // Sends a packet and waits for a reply that `accept` takes, resending
  // on timeouts, damaged replies and NAKs. A NAK for the next packet
  // counts as an ACK.
  protected async exchange(seq: number, type: string, data: Uint8Array, chkt: CheckType,
    accept: (p: Packet) => boolean, replyChkts: CheckType[] = [chkt],
    timeoutMs = this.timeoutMs, retries = this.retries): Promise<Packet> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      await this.sendPacket(seq, type, data, chkt);
      for (;;) {
        const r = await this.receive(replyChkts, timeoutMs);
        if (r === null || r === 'bad') break;
        if (r.type === 'E') throw new KermitRemoteError(new TextDecoder().decode(decodeData(r.data, DEFAULT_SESSION)) || 'error');
        if (accept(r)) return r;
        if (r.type === 'B' && type !== 'B') {
          // The other side repeats the end of its last batch because our
          // ACK got lost: acknowledge it so that it listens again.
          await this.sendPacket(r.seq, 'Y', new Uint8Array(0), r.chkt ?? chkt);
          continue;
        }
        if (r.type === 'N' && r.seq === next(seq) && type !== 'S') return { seq, type: 'Y', data: new Uint8Array(0) };
        if (r.type === 'N') break;
        // anything else is a stale duplicate: keep waiting
      }
      this.log(`resend ${type}#${seq}`);
    }
    throw new KermitError(`no response to ${type} packet (timeout)`);
  }

  // Sends files (or display text) as a complete batch starting with the
  // Send-Init packet `seq`.
  protected async sendTransfer(items: TransferItem[], seq = 0): Promise<void> {
    const ack = (s: number) => (p: Packet) => p.type === 'Y' && p.seq === s;
    const sAck = await this.exchange(seq, 'S', encodeParams(this.mine), 1, ack(seq), [1]);
    const s = negotiate(this.mine, decodeParams(sAck.data));
    this.session = s;
    this.log(`send: block check ${s.chkt}, packet length ${s.sendMax}`);
    seq = next(seq);
    for (const item of items) {
      await this.exchange(seq, item.display ? 'X' : 'F', encodeData(new TextEncoder().encode(item.name), s), s.chkt, ack(seq));
      seq = next(seq);
      const room = dataRoom(s);
      let off = 0;
      while (off < item.data.length) {
        const chunk = encodeChunk(item.data, off, room, s);
        const r = await this.exchange(seq, 'D', chunk.data, s.chkt, ack(seq));
        if (r.data.length > 0 && (r.data[0] === 0x58 || r.data[0] === 0x5a)) throw new KermitError(`receiver cancelled ${item.name}`);
        off += chunk.used;
        seq = next(seq);
      }
      await this.exchange(seq, 'Z', new Uint8Array(0), s.chkt, ack(seq));
      seq = next(seq);
    }
    try {
      await this.exchange(seq, 'B', new Uint8Array(0), s.chkt, ack(seq));
    } catch (err) {
      // Every file was stored when its Z was acknowledged. A receiver
      // whose ACK to B got lost is already idle and may answer the
      // repeated B with an error (Draftling's server does).
      this.log(`end of batch not confirmed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Receives a batch after the Send-Init packet `init` arrived. Returns
  // the files (and display texts) in the order received.
  protected async receiveTransfer(init: Packet, store?: (item: TransferItem) => Promise<void>): Promise<TransferItem[]> {
    const s = negotiate(this.mine, decodeParams(init.data));
    this.session = s;
    let lastAck = { seq: init.seq, type: 'Y', data: encodeParams(this.mine), chkt: 1 as CheckType };
    await this.sendPacket(lastAck.seq, lastAck.type, lastAck.data, lastAck.chkt);
    let expected = next(init.seq);
    const items: TransferItem[] = [];
    let current: { name: string; display: boolean; parts: Uint8Array[] } | null = null;
    let failures = 0;
    for (;;) {
      // Our ACK to the Send-Init may be lost; the sender then repeats it
      // with block check type 1.
      const r = await this.receive(expected === next(init.seq) ? [s.chkt, 1] : [s.chkt]);
      if (r === null || r === 'bad') {
        if (++failures > this.retries) throw new KermitError('transfer timed out');
        await this.sendPacket(expected, 'N', new Uint8Array(0), s.chkt);
        continue;
      }
      if (r.type === 'E') throw new KermitRemoteError(new TextDecoder().decode(decodeData(r.data, s)) || 'error');
      if (r.seq === prev(expected)) {
        // duplicate: our ACK was lost
        await this.sendPacket(lastAck.seq, lastAck.type, lastAck.data, lastAck.chkt);
        continue;
      }
      if (r.seq !== expected) {
        if (++failures > this.retries) throw new KermitError('transfer out of sequence');
        await this.sendPacket(expected, 'N', new Uint8Array(0), s.chkt);
        continue;
      }
      failures = 0;
      let done = false;
      switch (r.type) {
        case 'F':
        case 'X':
          current = { name: new TextDecoder().decode(decodeData(r.data, s)), display: r.type === 'X', parts: [] };
          break;
        case 'A':
          break;
        case 'D':
          if (!current) throw new KermitError('data packet without file header');
          current.parts.push(decodeData(r.data, s));
          break;
        case 'Z':
          if (current && !(r.data.length > 0 && r.data[0] === 0x44 /* D: discard */)) {
            let n = 0;
            for (const p of current.parts) n += p.length;
            const data = new Uint8Array(n);
            let o = 0;
            for (const p of current.parts) { data.set(p, o); o += p.length; }
            const item = { name: current.name, data, display: current.display };
            if (store) {
              try {
                await store(item);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                await this.sendError(r.seq, msg, s);
                throw new KermitError(msg);
              }
            }
            items.push(item);
          }
          current = null;
          break;
        case 'B':
          done = true;
          break;
        default:
          await this.sendError(r.seq, `unexpected packet type ${r.type}`, s);
          throw new KermitError(`unexpected packet type ${r.type}`);
      }
      lastAck = { seq: r.seq, type: 'Y', data: new Uint8Array(0), chkt: s.chkt };
      await this.sendPacket(lastAck.seq, lastAck.type, lastAck.data, lastAck.chkt);
      expected = next(expected);
      if (done) return items;
    }
  }
}
