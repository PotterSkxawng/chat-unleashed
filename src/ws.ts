// A minimal WebSocket client, just enough for the DevTools Protocol.
//
// It exists so the browser driver has no runtime dependency of its own: the
// protocol is a text frame in each direction, with ping and pong for keepalive
// and fragmentation handled because a large DOM reply can arrive in pieces.
import { randomBytes, createHash } from "node:crypto";
import net from "node:net";

export interface SocketOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
}

type Handler = (payload: string) => void;

const MAX_HANDSHAKE_BYTES = 64 * 1024;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export class MiniSocket {
  private socket: net.Socket;
  private chunks: Buffer[] = [];
  private buffered = Buffer.alloc(0);
  private messageHandlers: Handler[] = [];
  private closeHandlers: Array<() => void> = [];
  private errorHandlers: Array<(error: Error) => void> = [];
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private fragmentBytes = 0;
  private closed = false;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on("data", (data) => this.read(Buffer.from(data)));
    socket.on("close", () => this.shutdown());
    socket.on("error", (error) => this.fail(error));
  }

  static connect(url: string, options: SocketOptions = {}): Promise<MiniSocket> {
    const parsed = new URL(url);
    if (parsed.protocol === "wss:") return Promise.reject(new Error("wss is not supported by the built-in client"));
    if (parsed.protocol !== "ws:") return Promise.reject(new Error(`unsupported WebSocket protocol ${parsed.protocol}`));
    const port = Number(parsed.port || 80);
    const key = randomBytes(16).toString("base64");
    const timeout = options.timeoutMs ?? 10_000;

    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: parsed.hostname, port });
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(new Error(`timed out after ${timeout}ms connecting to ${url}`));
        }
      }, timeout);

      socket.once("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });

      let handshake = Buffer.alloc(0);
      const onHandshake = (data: Buffer) => {
        handshake = Buffer.concat([handshake, data]);
        const end = handshake.indexOf("\r\n\r\n");
        if (end < 0) {
          if (handshake.length > MAX_HANDSHAKE_BYTES) {
            settled = true;
            clearTimeout(timer);
            socket.off("data", onHandshake);
            socket.destroy();
            reject(new Error(`WebSocket handshake exceeded ${MAX_HANDSHAKE_BYTES} bytes`));
          }
          return;
        }
        if (end + 4 > MAX_HANDSHAKE_BYTES) {
          settled = true;
          clearTimeout(timer);
          socket.off("data", onHandshake);
          socket.destroy();
          reject(new Error(`WebSocket handshake exceeded ${MAX_HANDSHAKE_BYTES} bytes`));
          return;
        }
        socket.off("data", onHandshake);
        const head = handshake.slice(0, end).toString("latin1");
        const rest = handshake.slice(end + 4);
        clearTimeout(timer);
        if (!/^HTTP\/1\.1 101/i.test(head)) {
          settled = true;
          socket.destroy();
          reject(new Error(`handshake refused: ${head.split("\r\n")[0]}`));
          return;
        }
        const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
        const expected = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        if (accept !== expected) {
          settled = true;
          socket.destroy();
          reject(new Error("handshake failed the accept check"));
          return;
        }
        settled = true;
        const client = new MiniSocket(socket);
        if (rest.length) client.read(rest);
        resolve(client);
      };

      socket.on("data", onHandshake);
      socket.once("connect", () => {
        const lines = [
          `GET ${parsed.pathname || "/"}${parsed.search} HTTP/1.1`,
          `Host: ${parsed.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
        ];
        for (const [name, value] of Object.entries(options.headers ?? {})) lines.push(`${name}: ${value}`);
        socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      });
    });
  }

  onMessage(handler: Handler): void {
    this.messageHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  send(text: string): void {
    if (this.closed) return;
    this.writeFrame(0x1, Buffer.from(text, "utf8"));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.writeFrame(0x8, Buffer.alloc(0));
    } catch {
      // The socket may already be gone.
    }
    this.socket.end();
    this.shutdown();
  }

  private shutdown(): void {
    this.closed = true;
    for (const handler of this.closeHandlers.splice(0)) handler();
  }

  private fail(error: Error): void {
    for (const handler of this.errorHandlers.splice(0)) handler(error);
    this.closed = true;
    for (const handler of this.closeHandlers.splice(0)) handler();
  }

  private protocolError(message: string): void {
    const error = new Error(`WebSocket protocol error: ${message}`);
    this.fail(error);
    this.socket.destroy();
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    const mask = randomBytes(4);
    const length = payload.length;
    let header: Buffer;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | length;
    } else if (length < 65_536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode;
    const masked = Buffer.alloc(length);
    for (let i = 0; i < length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  private read(data: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, data]);
    while (this.buffered.length >= 2) {
      const first = this.buffered[0];
      const second = this.buffered[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      if (masked) {
        this.protocolError("server frames must not be masked");
        return;
      }
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffered.length < 4) return;
        length = this.buffered.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffered.length < 10) return;
        const wideLength = this.buffered.readBigUInt64BE(2);
        if (wideLength > BigInt(MAX_FRAME_BYTES)) {
          this.protocolError(`frame exceeds ${MAX_FRAME_BYTES} bytes`);
          return;
        }
        length = Number(wideLength);
        offset = 10;
      }
      if (length > MAX_FRAME_BYTES) {
        this.protocolError(`frame exceeds ${MAX_FRAME_BYTES} bytes`);
        return;
      }
      if ((opcode & 0x08) !== 0 && (!fin || length > 125)) {
        this.protocolError("control frames must be final and at most 125 bytes");
        return;
      }
      if (this.buffered.length < offset + length) return;
      const payload = this.buffered.slice(offset, offset + length);
      this.buffered = this.buffered.slice(offset + length);
      if (opcode === 0x9) {
        this.writeFrame(0xa, payload);
        continue;
      }
      if (opcode === 0x8) {
        this.closed = true;
        this.socket.end();
        this.shutdown();
        return;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x0) {
        if (!this.fragments.length) {
          this.protocolError("continuation frame without an open message");
          return;
        }
        this.fragments.push(payload);
        this.fragmentBytes += payload.length;
      } else {
        if (opcode !== 0x1 && opcode !== 0x2) {
          this.protocolError(`unsupported opcode ${opcode}`);
          return;
        }
        if (this.fragments.length) {
          this.protocolError("new data frame before the fragmented message finished");
          return;
        }
        this.fragments = [payload];
        this.fragmentOpcode = opcode;
        this.fragmentBytes = payload.length;
      }
      if (this.fragmentBytes > MAX_MESSAGE_BYTES) {
        this.protocolError(`message exceeds ${MAX_MESSAGE_BYTES} bytes`);
        return;
      }
      if (!fin) continue;
      const whole = Buffer.concat(this.fragments, this.fragmentBytes);
      this.fragments = [];
      this.fragmentBytes = 0;
      const messageOpcode = this.fragmentOpcode;
      this.fragmentOpcode = 0;
      if (messageOpcode === 0x1) {
        const text = whole.toString("utf8");
        for (const handler of this.messageHandlers) handler(text);
      }
    }
  }
}
