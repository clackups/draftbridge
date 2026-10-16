// Web Serial transport (Chrome, Edge, Opera; https pages only). The
// declarations cover the part of the API Draftbridge uses, since the
// TypeScript DOM library does not include it.

import { type ByteChannel, ChunkQueue } from '../core/kermit/channel.ts';

interface SerialPortLike {
  open(options: { baudRate: number; dataBits?: number; stopBits?: number; parity?: string; flowControl?: string; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
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
  private closing: Promise<void> | null = null;
  onClose: (() => void) | null = null;

  private constructor(port: SerialPortLike) {
    this.port = port;
  }

  // Asks the user to pick a port and opens it. Draftling's console is
  // the ESP32's native USB port (USB-to-UART bridges are not supported),
  // which ignores the line speed and the modem lines; Web Serial still
  // wants a speed.
  static async request(): Promise<SerialChannel> {
    const serial = webSerial();
    if (!serial) throw new Error('This browser cannot access serial ports (Web Serial). Use Chrome, Edge or Opera on a computer.');
    const port = await serial.requestPort();
    await port.open({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 65536 });
    const ch = new SerialChannel(port);
    try {
      ch.start();
    } catch (err) {
      await ch.close();
      throw err;
    }
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
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) this.queue.push(value);
        }
      } catch {
        // device unplugged, read error or port closed
      } finally {
        this.queue.close();
        // The port stays open after a read error or end of stream;
        // close it, or the next requestPort() hands back this port
        // and open() fails with "The port is already open".
        void this.close();
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

  // Idempotent: called by the user (Disconnect) and when the read loop
  // ends.
  close(): Promise<void> {
    this.closing ??= this.doClose();
    return this.closing;
  }

  private async doClose(): Promise<void> {
    try {
      await this.reader?.cancel();
    } catch {
      // already gone
    }
    try {
      this.reader?.releaseLock();
    } catch {
      // already released
    }
    try {
      await this.writer?.abort();
    } catch {
      // already gone
    }
    try {
      this.writer?.releaseLock();
    } catch {
      // already released
    }
    try {
      await this.port.close();
    } catch {
      // already closed or unplugged
    }
  }
}
