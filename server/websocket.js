// Minimal RFC 6455 WebSocket server (zero dependencies). Supports masked text
// frames and control frames only, which is sufficient for extension clients.
import crypto from "node:crypto";
import http from "node:http";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP = { CONT: 0x0, TEXT: 0x1, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

export class WsConnection {
  constructor(socket, head = Buffer.alloc(0)) {
    this.socket = socket;
    this.buffer = Buffer.from(head);
    this.fragments = null;
    this.closed = false;
    this.lastActivity = Date.now();
    this.onmessage = null; // (text: string) => void
    this.onclose = null; // () => void
    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this._drain();
    });
    const gone = () => this._finish();
    socket.on("close", gone);
    socket.on("end", gone);
    socket.on("error", gone);
    this._drain();
  }

  get open() {
    return !this.closed && !this.socket.destroyed;
  }

  send(text) {
    if (!this.open) throw new Error("WebSocket is not open");
    this._sendFrame(OP.TEXT, Buffer.from(text, "utf8"));
  }

  ping() {
    if (this.open) this._sendFrame(OP.PING, Buffer.alloc(0));
  }

  close(code = 1000) {
    if (this.closed) return;
    try {
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code);
      this._sendFrame(OP.CLOSE, payload);
    } catch {
      /* socket already gone */
    }
    this.socket.end();
    setTimeout(() => this._finish(), 500).unref?.();
  }

  destroy() {
    this.socket.destroy();
    this._finish();
  }

  _sendFrame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  _feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this._drain();
  }

  _drain() {
    while (!this.closed) {
      const frame = this._readFrame();
      if (!frame) return;
      this._handleFrame(frame);
    }
  }

  _readFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < off + 2) return null;
      len = buf.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (buf.length < off + 8) return null;
      const big = buf.readBigUInt64BE(off);
      off += 8;
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.close(1009);
        return null;
      }
      len = Number(big);
    }
    if (rsv !== 0) {
      // No negotiated extensions, so RSV bits must be zero.
      this.close(1002);
      return null;
    }
    if (opcode < 0x8 && !masked) {
      // Clients must mask their data frames (RFC 6455 5.3).
      this.close(1002);
      return null;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length < off + maskLen + len) return null;
    let payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
    if (masked) {
      const key = buf.subarray(off, off + 4);
      for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
    }
    this.buffer = Buffer.from(buf.subarray(off + maskLen + len));
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    this.lastActivity = Date.now();
    if (opcode >= 0x8) {
      // Control frames must not be fragmented and carry <= 125 bytes.
      if (!fin || payload.length > 125) return this.close(1002);
      if (opcode === OP.CLOSE) return this.close(payload.length >= 2 ? payload.readUInt16BE(0) : 1000);
      if (opcode === OP.PING) return this._sendFrame(OP.PONG, payload);
      return; // PONG: activity already recorded above.
    }
    if (opcode === OP.TEXT || opcode === OP.BINARY) {
      if (fin) return this._deliver(opcode, payload);
      this.fragments = { opcode, chunks: [payload] };
    } else if (opcode === OP.CONT) {
      if (!this.fragments) return this.close(1002);
      this.fragments.chunks.push(payload);
      if (fin) {
        const { opcode: op, chunks } = this.fragments;
        this.fragments = null;
        return this._deliver(op, Buffer.concat(chunks));
      }
    }
  }

  _deliver(opcode, payload) {
    if (opcode !== OP.TEXT) return; // binary messages are not part of this protocol
    this.onmessage?.(payload.toString("utf8"));
  }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {
      /* already destroyed */
    }
    this.onclose?.();
  }
}

export async function createWsServer({ port, host = "127.0.0.1", onConnection }) {
  const server = http.createServer((req, res) => {
    res.writeHead(426, { Connection: "close" });
    res.end("WebSocket connections only");
  });
  server.on("upgrade", (req, socket, head) => {
    const key = req.headers["sec-websocket-key"];
    if ((req.headers.upgrade || "").toLowerCase() !== "websocket" || !key) {
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash("sha1")
      .update(key + WS_GUID)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        "\r\n",
    );
    socket.setTimeout(0);
    onConnection(new WsConnection(socket, head));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return server;
}

export function isPortInUse(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.once("error", () => resolve(true));
    probe.once("listening", () => probe.close(() => resolve(false)));
    probe.listen(port, host);
  });
}
