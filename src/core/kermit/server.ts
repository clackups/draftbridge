// Simulated Draftling Kermit server for the tests. It reproduces the
// behaviour of the firmware's server (components/kermit/kermit.c, see
// docs/kermit.md) that Draftbridge depends on:
//
//   - parameters persist from the last I / S negotiation and are used to
//     decode R and G commands and to encode short replies;
//   - an upload into a directory that does not exist fails; REMOTE MKDIR
//     creates one directory at a time;
//   - a name without lower-case letters is stored in lower case;
//   - directory listings are "name size|<DIR> date" lines or "No files";
//   - error texts: "File not found", "No files deleted", "Cannot open
//     directory", "Cannot create file", "Cannot create directory";
//   - an idle server answers a stray B packet with an error;
//   - FINISH is acknowledged and the server keeps running.

import { fromUtf8, utf8 } from '../bytes.ts';
import type { ByteChannel } from './channel.ts';
import { Endpoint, type EndpointOptions, KermitError } from './endpoint.ts';
import { dataRoom, decodeData, decodeParams, encodeData, encodeParams, negotiate, parseGeneric } from './packet.ts';

export interface FsEntry {
  name: string;
  dir: boolean;
  size: number;
}

export interface ServerFs {
  read(path: string): Promise<Uint8Array | null>;
  // Throws when the parent directory does not exist.
  write(path: string, data: Uint8Array): Promise<void>;
  // false when the file does not exist.
  remove(path: string): Promise<boolean>;
  // null when the directory does not exist.
  list(path: string): Promise<FsEntry[] | null>;
  // false when it exists or its parent does not.
  mkdir(path: string): Promise<boolean>;
}

// Resolves a client path against the root: no way out of it.
export function safePath(path: string): string | null {
  const out: string[] = [];
  for (const p of path.replace(/\\/g, '/').split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      if (!out.length) return null;
      out.pop();
    } else {
      out.push(p);
    }
  }
  return out.join('/');
}

function commonForm(name: string): string {
  return /[a-z]/.test(name) ? name : name.toLowerCase();
}

export class KermitServer extends Endpoint {
  private fs: ServerFs;
  private stopped = false;
  finished = 0;

  constructor(ch: ByteChannel, fs: ServerFs, opts: EndpointOptions = {}) {
    super(ch, opts);
    this.fs = fs;
  }

  stop(): void {
    this.stopped = true;
  }

  async serve(): Promise<void> {
    while (!this.stopped) {
      const p = await this.receive([1, 3, 2], 100);
      if (p === null || p === 'bad') continue;
      try {
        await this.handle(p.type, p.seq, p.data);
      } catch (err) {
        if (!(err instanceof KermitError)) await this.sendError(0, err instanceof Error ? err.message : String(err));
      }
    }
  }

  private text(data: Uint8Array): string {
    return fromUtf8(decodeData(data, this.session));
  }

  private async handle(type: string, seq: number, data: Uint8Array): Promise<void> {
    switch (type) {
      case 'I':
        this.session = negotiate(this.mine, decodeParams(data));
        await this.sendPacket(seq, 'Y', encodeParams(this.mine), 1);
        return;
      case 'S':
        await this.receiveTransfer({ seq, type, data }, async (item) => {
          const path = safePath(commonForm(item.name));
          if (!path) throw new Error('Invalid file name');
          try {
            await this.fs.write(path, item.data);
          } catch {
            throw new Error('Cannot create file');
          }
        });
        return;
      case 'R': {
        const path = safePath(this.text(data));
        const content = path ? await this.fs.read(path) : null;
        if (!content) {
          await this.sendError(seq, 'File not found');
          return;
        }
        await this.sendTransfer([{ name: path!.slice(path!.lastIndexOf('/') + 1), data: content }]);
        return;
      }
      case 'G':
        await this.generic(seq, decodeData(data, this.session));
        return;
      case 'E':
      case 'Y':
      case 'N':
        return;
      default:
        await this.sendError(seq, 'Unimplemented server command');
    }
  }

  private async reply(seq: number, text: string): Promise<void> {
    const enc = encodeData(utf8(text), this.session);
    if (enc.length <= dataRoom({ ...this.session, chkt: 1 })) await this.sendPacket(seq, 'Y', enc, 1);
    else await this.sendTransfer([{ name: '', data: utf8(text), display: true }]);
  }

  private async generic(seq: number, d: Uint8Array): Promise<void> {
    const { cmd, args } = parseGeneric(d);
    const arg = args[0] ?? '';
    const path = safePath(arg);
    switch (cmd) {
      case 'C':
        if (arg && (path === null || !(await this.fs.list(path)))) await this.sendError(seq, 'No such directory');
        else await this.reply(seq, '/');
        return;
      case 'D': {
        const list = path === null ? null : await this.fs.list(path);
        if (!list) {
          await this.sendError(seq, 'Cannot open directory');
          return;
        }
        const lines = list.map((e) => `${e.name.padEnd(36)} ${(e.dir ? '<DIR>' : String(e.size)).padStart(10)}  2026-10-12 09:41\r\n`);
        await this.reply(seq, lines.length ? lines.join('') : 'No files\r\n');
        return;
      }
      case 'E':
        if (path && (await this.fs.remove(path))) await this.reply(seq, '1 file(s) deleted');
        else await this.sendError(seq, 'No files deleted');
        return;
      case 'm':
        if (path && (await this.fs.mkdir(path))) await this.reply(seq, 'Directory created');
        else await this.sendError(seq, 'Cannot create directory');
        return;
      case 'F':
      case 'L':
        this.finished++;
        await this.sendPacket(seq, 'Y', new Uint8Array(0), 1);
        return;
      default:
        await this.sendError(seq, 'Unimplemented server command');
    }
  }
}

// In-memory SD card for the simulated device.
export class MemoryFs implements ServerFs {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>(['']);

  private parent(path: string): string {
    const i = path.lastIndexOf('/');
    return i < 0 ? '' : path.slice(0, i);
  }

  // Test helper: stores a file, creating its directories.
  put(path: string, data: Uint8Array | string): void {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'));
    this.files.set(path, typeof data === 'string' ? utf8(data) : data);
  }

  text(path: string): string | undefined {
    const f = this.files.get(path);
    return f ? fromUtf8(f) : undefined;
  }

  async read(path: string): Promise<Uint8Array | null> {
    return this.files.get(path) ?? null;
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    if (!this.dirs.has(this.parent(path)) || this.dirs.has(path)) throw new Error('Cannot create file');
    this.files.set(path, data);
  }

  async remove(path: string): Promise<boolean> {
    return this.files.delete(path);
  }

  async mkdir(path: string): Promise<boolean> {
    if (!path || this.dirs.has(path) || this.files.has(path) || !this.dirs.has(this.parent(path))) return false;
    this.dirs.add(path);
    return true;
  }

  async list(path: string): Promise<FsEntry[] | null> {
    if (!this.dirs.has(path)) return null;
    const out: FsEntry[] = [];
    for (const d of this.dirs) if (d && this.parent(d) === path) out.push({ name: d.slice(d.lastIndexOf('/') + 1), dir: true, size: 0 });
    for (const [f, data] of this.files) if (this.parent(f) === path) out.push({ name: f.slice(f.lastIndexOf('/') + 1), dir: false, size: data.length });
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
  }
}
