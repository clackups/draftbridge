// Kermit client for Draftling's Kermit server (F1 -> "Sync via browser",
// firmware components/kermit/kermit.c). Draftbridge uses these server
// functions: I (parameters), GET (R), SEND (S), and the REMOTE commands
// DIRECTORY (G D), DELETE (G E), MKDIR (G m), CD (G C) and FINISH (G F).
//
// Every command starts with an I packet: the server keeps the
// parameters of the last negotiation and decodes commands and encodes
// short replies with them, so the client must know what they are.

import { concat, fromUtf8, utf8 } from '../bytes.ts';
import type { ByteChannel } from './channel.ts';
import { Endpoint, type EndpointOptions, KermitError, KermitRemoteError, type TransferItem } from './endpoint.ts';
import { decodeData, decodeParams, encodeData, encodeParams, genericCommand, negotiate } from './packet.ts';

export { KermitError, KermitRemoteError };

// Error texts by which the server says that a file or directory does
// not exist ("File not found", "No files deleted", "Cannot open
// directory" from Draftling).
const NOT_FOUND = /not found|no such|does not exist|no files deleted|cannot open directory/i;

export function isNotFoundError(err: unknown): boolean {
  return err instanceof KermitRemoteError && NOT_FOUND.test(err.message);
}

export interface DirEntry {
  name: string;
  dir: boolean;
}

export class KermitClient extends Endpoint {
  // Serializes operations: Kermit is one transaction at a time.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(ch: ByteChannel, opts: EndpointOptions = {}) {
    super(ch, opts);
  }

  private run<T>(op: () => Promise<T>): Promise<T> {
    const res = this.queue.then(op, op);
    this.queue = res.catch(() => undefined);
    return res;
  }

  // Commands and the server's first reply use block check 1; a server
  // still repeating the end of a batch uses the negotiated type.
  private static readonly CMD_CHECKS: Array<1 | 2 | 3> = [1, 3, 2];

  private async init(): Promise<void> {
    this.parser.clear();
    const r = await this.exchange(0, 'I', encodeParams(this.mine), 1, (p) => p.type === 'Y' && p.seq === 0, KermitClient.CMD_CHECKS);
    this.session = negotiate(this.mine, decodeParams(r.data));
  }

  // Downloads one file; null when the server reports it does not exist.
  get(path: string): Promise<Uint8Array | null> {
    return this.run(async () => {
      await this.init();
      let init;
      try {
        init = await this.exchange(0, 'R', encodeData(utf8(path), this.session), 1,
          (p) => p.type === 'S' && p.seq === 0, KermitClient.CMD_CHECKS);
      } catch (err) {
        if (isNotFoundError(err)) return null;
        throw err;
      }
      const items = await this.receiveTransfer(init);
      const file = items.find((i) => !i.display);
      if (!file) throw new KermitError(`server sent no file for ${path}`);
      return file.data;
    });
  }

  // Uploads files in one batch, each stored under the given path
  // (relative to the SD card root). The directories must exist.
  send(files: Array<{ path: string; data: Uint8Array }>): Promise<void> {
    if (files.length === 0) return Promise.resolve();
    return this.run(async () => {
      this.parser.clear();
      await this.sendTransfer(files.map((f): TransferItem => ({ name: f.path, data: f.data })));
    });
  }

  // Runs a generic server command; returns the text the server replied
  // with (short replies come in the ACK, long ones as a text transfer).
  generic(cmd: string, ...args: string[]): Promise<string> {
    return this.run(async () => {
      await this.init();
      const r = await this.exchange(0, 'G', encodeData(genericCommand(cmd, ...args), this.session), 1,
        (p) => (p.type === 'Y' || p.type === 'S') && p.seq === 0, KermitClient.CMD_CHECKS);
      if (r.type === 'Y') return fromUtf8(decodeData(r.data, this.session));
      const items = await this.receiveTransfer(r);
      return fromUtf8(concat(items.map((i) => i.data)));
    });
  }

  // Lists a directory ("" is the SD card root). null when it does not
  // exist.
  async dir(path: string): Promise<DirEntry[] | null> {
    let text: string;
    try {
      text = await this.generic('D', path);
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
    return parseDirListing(text);
  }

  // Deletes a file; deleting a missing file is not an error.
  async remove(path: string): Promise<void> {
    try {
      await this.generic('E', path);
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
  }

  // Creates a directory. Returns false when the server refused, which
  // also happens when it exists already.
  async mkdir(path: string): Promise<boolean> {
    try {
      await this.generic('m', path);
      return true;
    } catch (err) {
      if (err instanceof KermitRemoteError) return false;
      throw err;
    }
  }

  // Makes the SD card root the server's current directory (another
  // client may have changed it).
  async resetDirectory(): Promise<void> {
    await this.generic('C');
  }

  // Tells the server this client is done. Draftling acknowledges it and
  // keeps serving until it is stopped on the device.
  async finish(): Promise<void> {
    await this.generic('F');
  }
}

// Draftling lists one entry per line: the name padded to 36 columns,
// the size or "<DIR>", and the modification time; "No files" for an
// empty directory. A bare name per line (directories ending in "/") is
// accepted as well.
const LISTING_LINE = /^(.+?)\s+(<DIR>|\d+)\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

export function parseDirListing(text: string): DirEntry[] {
  const out: DirEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line || line === 'No files') continue;
    let name: string;
    let dir: boolean;
    const m = LISTING_LINE.exec(line);
    if (m) {
      name = m[1];
      dir = m[2] === '<DIR>';
    } else {
      dir = line.endsWith('/');
      name = dir ? line.slice(0, -1) : line;
    }
    if (name && name !== '.' && name !== '..') out.push({ name, dir });
  }
  return out;
}
