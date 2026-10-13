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
  // Output lines; a field left out keeps its state.
  setSignals?(signals: { dataTerminalReady?: boolean; requestToSend?: boolean; break?: boolean }): Promise<void>;
  // Input lines only: the API cannot read DTR and RTS back.
  getSignals?(): Promise<{ dataCarrierDetect: boolean; clearToSend: boolean; ringIndicator: boolean; dataSetReady: boolean }>;
}

interface SerialLike {
  requestPort(options?: { filters?: Array<{ usbVendorId?: number }> }): Promise<SerialPortLike>;
  addEventListener(type: 'disconnect', listener: (ev: Event) => void): void;
}

export function webSerial(): SerialLike | null {
  const nav = navigator as Navigator & { serial?: SerialLike };
  return nav.serial ?? null;
}

// Time between releasing DTR / RTS and the first packet.
const SETTLE_MS = 100;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class SerialChannel implements ByteChannel {
  private port: SerialPortLike;
  // What happened to the modem lines when the port was opened, for the
  // transfer log.
  readonly signalLog: string[] = [];
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
    await ch.releaseControlLines();
    ch.start();
    return ch;
  }

  // Boards with a USB-to-UART bridge (the Seeed reTerminal's CH343) wire
  // DTR and RTS to the ESP32's EN and GPIO0 like esptool's auto-reset
  // circuit: RTS alone resets the chip, DTR alone pulls GPIO0 (boot
  // mode) low, both or neither leave it running. port.open() asserts
  // both, so release them as idf.py monitor and esptool's no_reset do:
  // RTS first, which passes only through DTR alone (no reset), then DTR.
  // Native USB ports ignore the lines.
  private async releaseControlLines(): Promise<void> {
    const log = (m: string) => this.signalLog.push(`serial: ${m}`);
    const port = this.port;
    const info = port.getInfo();
    const hex = (n: number | undefined) => n === undefined ? '?' : n.toString(16).padStart(4, '0');
    log(`opened USB ${hex(info.usbVendorId)}:${hex(info.usbProductId)}, DTR on, RTS on (as opened)`);
    if (!port.setSignals) {
      log('setSignals() not available, DTR / RTS left as opened');
      return;
    }
    await this.logInputs();
    try {
      await port.setSignals({ requestToSend: false });
      log('RTS off (DTR on)');
      await port.setSignals({ dataTerminalReady: false });
      log('DTR off (RTS off)');
    } catch (err) {
      log(`setSignals() failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.logInputs();
    await sleep(SETTLE_MS);
  }

  private async logInputs(): Promise<void> {
    if (!this.port.getSignals) return;
    try {
      const s = await this.port.getSignals();
      const on = (b: boolean) => b ? 'on' : 'off';
      this.signalLog.push(`serial: inputs DSR ${on(s.dataSetReady)}, CTS ${on(s.clearToSend)}, DCD ${on(s.dataCarrierDetect)}, RI ${on(s.ringIndicator)}`);
    } catch (err) {
      this.signalLog.push(`serial: getSignals() failed: ${err instanceof Error ? err.message : String(err)}`);
    }
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
