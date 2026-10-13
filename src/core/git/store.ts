// Object store with a pluggable backend. Draftbridge keeps the device's
// repository (.git on the SD card) authoritative: objects are read from
// it on demand, and new objects are collected in memory and written to
// it in one batch (flush) before any ref is moved to point at them.

import { type Commit, type GitObject, type ObjectType, type TreeEntry, hashObject, parseCommit, parseTree, serializeCommit, serializeTree } from './objects.ts';

export interface ObjectBackend {
  // Reads an object; null when the backend does not have it.
  readObject(oid: string): Promise<GitObject | null>;
  // Stores objects (already hashed).
  writeObjects(objects: Array<{ oid: string; obj: GitObject }>): Promise<void>;
}

export class MissingObjectError extends Error {
  readonly oid: string;

  constructor(oid: string) {
    super(`object ${oid} is missing`);
    this.name = 'MissingObjectError';
    this.oid = oid;
  }
}

export class ObjectStore {
  private cache = new Map<string, GitObject>();
  private pending = new Map<string, GitObject>();
  // Objects known to exist in the backend.
  private stored = new Set<string>();
  private missing = new Set<string>();
  private backend: ObjectBackend;

  constructor(backend: ObjectBackend) {
    this.backend = backend;
  }

  async get(oid: string): Promise<GitObject | null> {
    const hit = this.cache.get(oid);
    if (hit) return hit;
    if (this.missing.has(oid)) return null;
    const obj = await this.backend.readObject(oid);
    if (!obj) {
      this.missing.add(oid);
      return null;
    }
    this.cache.set(oid, obj);
    this.stored.add(oid);
    return obj;
  }

  async has(oid: string): Promise<boolean> {
    return (await this.get(oid)) !== null;
  }

  async read(oid: string, type?: ObjectType): Promise<GitObject> {
    const obj = await this.get(oid);
    if (!obj) throw new MissingObjectError(oid);
    if (type && obj.type !== type) throw new Error(`object ${oid} is a ${obj.type}, expected ${type}`);
    return obj;
  }

  // Adds an object; it reaches the backend on the next flush unless the
  // backend is already known to have it.
  write(type: ObjectType, data: Uint8Array): string {
    const oid = hashObject(type, data);
    this.missing.delete(oid);
    if (!this.cache.has(oid)) this.cache.set(oid, { type, data });
    if (!this.stored.has(oid)) this.pending.set(oid, { type, data });
    return oid;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  async flush(): Promise<number> {
    if (this.pending.size === 0) return 0;
    const list = [...this.pending].map(([oid, obj]) => ({ oid, obj }));
    await this.backend.writeObjects(list);
    for (const { oid } of list) {
      this.stored.add(oid);
      this.pending.delete(oid);
    }
    return list.length;
  }

  async readTree(oid: string | null): Promise<TreeEntry[]> {
    if (!oid) return [];
    return parseTree((await this.read(oid, 'tree')).data);
  }

  // Stores a tree; an empty tree yields null (Draftling never stores
  // empty trees: an empty directory does not exist in Git).
  writeTree(entries: TreeEntry[]): string | null {
    if (entries.length === 0) return null;
    return this.write('tree', serializeTree(entries));
  }

  async readCommit(oid: string): Promise<Commit> {
    return parseCommit((await this.read(oid, 'commit')).data);
  }

  writeCommit(c: Commit): string {
    return this.write('commit', serializeCommit(c));
  }
}

// In-memory backend, used by tests and by the reference device.
export class MemoryBackend implements ObjectBackend {
  readonly objects = new Map<string, GitObject>();

  async readObject(oid: string): Promise<GitObject | null> {
    return this.objects.get(oid) ?? null;
  }

  async writeObjects(objects: Array<{ oid: string; obj: GitObject }>): Promise<void> {
    for (const { oid, obj } of objects) this.objects.set(oid, obj);
  }
}
