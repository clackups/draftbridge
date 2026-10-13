// The Draftling's SD card as seen over Kermit: the working tree (the
// document files in the sync directory), git.cfg, and the Git
// repository in .git that Draftling's own sync client keeps (loose
// objects, refs/heads/<branch>, refs/remotes/origin/<branch>, HEAD).

import { fromUtf8, utf8 } from './bytes.ts';
import type { DirEntry } from './kermit/client.ts';
import { type GitObject, decodeLoose, encodeLoose, hashObject, isOid } from './git/objects.ts';
import type { ObjectBackend } from './git/store.ts';
import { deflate, inflate } from './git/zlib.ts';

// What Draftbridge needs from the device; KermitClient implements it.
export interface DeviceFiles {
  get(path: string): Promise<Uint8Array | null>;
  // The directories of the paths must exist.
  send(files: Array<{ path: string; data: Uint8Array }>): Promise<void>;
  dir(path: string): Promise<DirEntry[] | null>;
  remove(path: string): Promise<void>;
  // false if refused (for example because it exists).
  mkdir(path: string): Promise<boolean>;
}

function parentDir(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export const DOC_EXTENSIONS = ['md', 'txt', 'fountain'];

// A document Draftling syncs: not hidden, ending in .md, .txt or
// .fountain (same rule as is_doc() in the firmware).
export function isDoc(name: string): boolean {
  if (name.startsWith('.') || name.includes('/')) return false;
  return DOC_EXTENSIONS.some((ext) => name.length > ext.length + 1 && name.endsWith('.' + ext));
}

// A repository file whose type Draftling knows.
export function hasKnownExtension(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 && DOC_EXTENSIONS.includes(base.slice(dot + 1));
}

export class DeviceRepo implements ObjectBackend {
  readonly files: DeviceFiles;
  // Directories known to exist on the card ("" is the root).
  private dirs = new Set<string>(['']);
  private objectDirsListed = false;

  constructor(files: DeviceFiles) {
    this.files = files;
  }

  // Lists a directory, remembering the sub-directories seen.
  async list(path: string): Promise<DirEntry[] | null> {
    const entries = await this.files.dir(path);
    if (entries) {
      // Draftling answers "No files" both for an empty directory and for
      // one that does not exist, so only a non-empty listing proves it.
      if (entries.length) this.dirs.add(path);
      for (const e of entries) if (e.dir) this.dirs.add(path ? `${path}/${e.name}` : e.name);
    }
    return entries;
  }

  // Creates the directories holding `paths` (Draftling's server does not
  // create them when it receives a file).
  async ensureDirs(paths: string[]): Promise<void> {
    const needed = [...new Set(paths.map(parentDir))].filter((d) => !this.dirs.has(d)).sort();
    for (const dir of needed) {
      const parts = dir.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const d = parts.slice(0, i).join('/');
        if (this.dirs.has(d)) continue;
        // A refusal usually means it exists already; a real problem
        // shows up when the file is written.
        await this.files.mkdir(d);
        this.dirs.add(d);
      }
    }
  }

  // Uploads files, creating their directories first.
  async put(files: Array<{ path: string; data: Uint8Array }>): Promise<void> {
    if (files.length === 0) return;
    await this.ensureDirs(files.map((f) => f.path));
    await this.files.send(files);
  }

  private objectPath(oid: string): string {
    return `.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
  }

  async readObject(oid: string): Promise<GitObject | null> {
    const raw = await this.files.get(this.objectPath(oid));
    if (!raw) return null;
    const obj = decodeLoose(inflate(raw));
    if (hashObject(obj.type, obj.data) !== oid) throw new Error(`object ${oid} on the device is corrupt`);
    return obj;
  }

  async writeObjects(objects: Array<{ oid: string; obj: GitObject }>, progress?: (done: number) => void): Promise<void> {
    if (objects.length && !this.objectDirsListed) {
      // One listing instead of a MKDIR attempt per fan-out directory.
      if (!this.dirs.has('.git')) await this.list('');
      if (this.dirs.has('.git')) await this.list('.git/objects');
      this.objectDirsListed = true;
    }
    // In batches, so that a long transfer reports progress and a broken
    // connection loses little.
    for (let i = 0; i < objects.length; i += 200) {
      await this.put(objects.slice(i, i + 200).map(({ oid, obj }) => ({
        path: this.objectPath(oid),
        data: deflate(encodeLoose(obj.type, obj.data)),
      })));
      progress?.(Math.min(i + 200, objects.length));
    }
  }

  // Resolves a ref (one level of "ref: " indirection, like the firmware).
  async readRef(name: string, depth = 0): Promise<string | null> {
    const raw = await this.files.get(`.git/${name}`);
    if (!raw) return null;
    const text = fromUtf8(raw).trim();
    if (text.startsWith('ref: ')) return depth < 2 ? this.readRef(text.slice(5).trim(), depth + 1) : null;
    const oid = text.slice(0, 40);
    return isOid(oid) ? oid : null;
  }

  async writeRef(name: string, oid: string): Promise<void> {
    await this.put([{ path: `.git/${name}`, data: utf8(oid + '\n') }]);
  }

  async deleteRef(name: string): Promise<void> {
    await this.files.remove(`.git/${name}`);
  }

  async setHead(target: string): Promise<void> {
    const want = `ref: ${target}\n`;
    const cur = await this.files.get('.git/HEAD');
    if (cur && fromUtf8(cur) === want) return;
    await this.put([{ path: '.git/HEAD', data: utf8(want) }]);
  }

  // Document files in the sync directory, with their contents.
  async readWorkingTree(): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    const entries = await this.list('');
    for (const e of entries ?? []) {
      if (e.dir || !isDoc(e.name)) continue;
      const data = await this.files.get(e.name);
      if (data) out.set(e.name, data);
    }
    return out;
  }

  async readConfig(): Promise<string | null> {
    const raw = await this.files.get('git.cfg');
    return raw ? fromUtf8(raw) : null;
  }

  async writeConfig(text: string): Promise<void> {
    await this.put([{ path: 'git.cfg', data: utf8(text) }]);
  }
}
