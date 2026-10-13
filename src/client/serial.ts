// Web Serial transport (Chrome, Edge, Opera; https pages only). The
// declarations cover the part of the API Draftbridge uses, since the
// TypeScript DOM library does not include it.

import { type ByteChannel, ChunkQueue } from '../core/kermit/channel.ts';

interface SerialPortLike {
  open(options: { baudRate: number; dataBits?: number; stopBits?: number; parity?: string; flowControl?: string; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
}

interface SerialLike {
  requestPort(options?: { filters?: Array<{ usbVendorId?: number }> }): Promise<SerialPortLike>;
  addEventListener(type: 'disconnect', listener: (ev: Event) => void): void;
}

export function webSerial(): SerialLike | null {
  const nav = navigator as Navigator & { serial?: SerialLike };
  return nav.serial ?? null;
}

export class SerialChannel implements ByteChannel {
  private port: SerialPortLike;
  private queue = new ChunkQueue();
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reading: Promise<void> | null = null;
  onClose: (() => void) | null = null;

  private constructor(port: SerialPortLike) {
    this.port = port;
  }

  // Asks the user to pick a port and opens it.
  static async request(baudRate: number): Promise<SerialChannel> {
    const serial = webSerial();
    if (!serial) throw new Error('This browser cannot access serial ports (Web Serial). Use Chrome, Edge or Opera on a computer.');
    const port = await serial.requestPort();
    await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 65536 });
    const ch = new SerialChannel(port);
    ch.start();
    return ch;
  }

  get closed(): boolean {
    return this.queue.isClosed();
  }

  private start(): void {
    const readable = this.port.readable;
    const writable = this.port.writable;
    if (!readable || !writable) throw new Error('the serial port is not readable / writable');
    this.reader = readable.getReader();
    this.writer = writable.getWriter();
    const reader = this.reader;
    this.reading = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) this.queue.push(value);
        }
      } catch {
        // device unplugged or port closed
      } finally {
        this.queue.close();
        this.onClose?.();
      }
    })();
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.writer || this.closed) throw new Error('the serial port is closed');
    await this.writer.write(data);
  }

  read(timeoutMs: number): Promise<Uint8Array | null> {
    return this.queue.read(timeoutMs);
  }

  async close(): Promise<void> {
    try {
      await this.reader?.cancel();
    } catch {
      // already gone
    }
    await this.reading;
    try {
      this.reader?.releaseLock();
      this.writer?.releaseLock();
      await this.port.close();
    } catch {
      // already gone
    }
  }
}
