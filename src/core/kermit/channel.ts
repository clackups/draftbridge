// Byte channels: the serial port in the browser, an in-memory pipe in
// tests.

export interface ByteChannel {
  write(data: Uint8Array): Promise<void>;
  // Next chunk of received bytes; null when nothing arrived in time.
  read(timeoutMs: number): Promise<Uint8Array | null>;
}

// Queue of received chunks with a waiting reader.
export class ChunkQueue {
  private chunks: Uint8Array[] = [];
  private waiter: ((c: Uint8Array | null) => void) | null = null;
  private closed = false;

  push(c: Uint8Array): void {
    if (this.closed || c.length === 0) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(c);
    } else {
      this.chunks.push(c);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(null);
    }
  }

  isClosed(): boolean {
    return this.closed;
  }

  read(timeoutMs: number): Promise<Uint8Array | null> {
    const c = this.chunks.shift();
    if (c) return Promise.resolve(c);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve(null);
      }, timeoutMs);
      this.waiter = (chunk) => {
        clearTimeout(timer);
        resolve(chunk);
      };
    });
  }
}

// Two connected channels. `tamper` may alter or drop bytes in transit
// (for testing error recovery).
export function memoryPipe(tamper?: (data: Uint8Array, dir: 'ab' | 'ba') => Uint8Array | null): [ByteChannel, ByteChannel] {
  const qa = new ChunkQueue();
  const qb = new ChunkQueue();
  const send = (q: ChunkQueue, dir: 'ab' | 'ba') => async (data: Uint8Array) => {
    const d = tamper ? tamper(data.slice(), dir) : data.slice();
    if (d) setTimeout(() => q.push(d), 0);
  };
  return [
    { write: send(qb, 'ab'), read: (t) => qa.read(t) },
    { write: send(qa, 'ba'), read: (t) => qb.read(t) },
  ];
}
