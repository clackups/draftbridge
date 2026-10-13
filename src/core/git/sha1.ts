// Synchronous SHA-1 (FIPS 180-4). Git object ids are SHA-1 hashes; a
// synchronous implementation keeps the object store code simple and
// works the same in the browser (where crypto.subtle is async only).

export class Sha1 {
  private h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  private block = new Uint8Array(64);
  private blockLen = 0;
  private total = 0;
  private w = new Uint32Array(80);

  update(data: Uint8Array): this {
    let i = 0;
    this.total += data.length;
    if (this.blockLen > 0) {
      const n = Math.min(64 - this.blockLen, data.length);
      this.block.set(data.subarray(0, n), this.blockLen);
      this.blockLen += n;
      i = n;
      if (this.blockLen < 64) return this;
      this.compress(this.block, 0);
      this.blockLen = 0;
    }
    for (; i + 64 <= data.length; i += 64) this.compress(data, i);
    if (i < data.length) {
      this.block.set(data.subarray(i), 0);
      this.blockLen = data.length - i;
    }
    return this;
  }

  digest(): Uint8Array {
    const bits = this.total * 8;
    const pad = new Uint8Array(((this.blockLen < 56 ? 56 : 120) - this.blockLen) + 8);
    pad[0] = 0x80;
    const hi = Math.floor(bits / 0x100000000);
    const lo = bits >>> 0;
    const n = pad.length;
    pad[n - 8] = hi >>> 24; pad[n - 7] = hi >>> 16; pad[n - 6] = hi >>> 8; pad[n - 5] = hi;
    pad[n - 4] = lo >>> 24; pad[n - 3] = lo >>> 16; pad[n - 2] = lo >>> 8; pad[n - 1] = lo;
    this.update(pad);
    const out = new Uint8Array(20);
    for (let i = 0; i < 5; i++) {
      out[i * 4] = this.h[i] >>> 24;
      out[i * 4 + 1] = this.h[i] >>> 16;
      out[i * 4 + 2] = this.h[i] >>> 8;
      out[i * 4 + 3] = this.h[i];
    }
    return out;
  }

  private compress(b: Uint8Array, off: number): void {
    const w = this.w;
    for (let t = 0; t < 16; t++) {
      const j = off + t * 4;
      w[t] = (b[j] << 24) | (b[j + 1] << 16) | (b[j + 2] << 8) | b[j + 3];
    }
    for (let t = 16; t < 80; t++) {
      const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16];
      w[t] = (x << 1) | (x >>> 31);
    }
    let a = this.h[0], bb = this.h[1], c = this.h[2], d = this.h[3], e = this.h[4];
    for (let t = 0; t < 80; t++) {
      let f: number, k: number;
      if (t < 20) { f = (bb & c) | (~bb & d); k = 0x5a827999; }
      else if (t < 40) { f = bb ^ c ^ d; k = 0x6ed9eba1; }
      else if (t < 60) { f = (bb & c) | (bb & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = bb ^ c ^ d; k = 0xca62c1d6; }
      const tmp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) >>> 0;
      e = d;
      d = c;
      c = (bb << 30) | (bb >>> 2);
      bb = a;
      a = tmp;
    }
    this.h[0] += a; this.h[1] += bb; this.h[2] += c; this.h[3] += d; this.h[4] += e;
  }
}

export function sha1(data: Uint8Array): Uint8Array {
  return new Sha1().update(data).digest();
}
