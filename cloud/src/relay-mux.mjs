// A tiny length-prefixed frame multiplexer over one duplex socket, shared by the relay server and the
// plugin's link client. Only the relay opens streams (one per incoming Cursor request); the plugin
// answers on the same stream id. Each DATA frame is written to the socket as it arrives, so an SSE
// response or a ~50s wait_message is forwarded chunk by chunk and never buffered until it completes.
import { EventEmitter } from "node:events";

const HEADER = 9; // streamId(uint32) + type(uint8) + length(uint32)
export const FrameType = { OPEN: 1, HEAD: 2, DATA: 3, END: 4, RESET: 5, PING: 6, PONG: 7 };
const heartbeatMs = 20_000;
const deadMs = 70_000;
const maxFrameBytes = 16 * 1024 * 1024;

// One logical stream. `writeData` returns false when the socket is backpressured; the caller pauses
// its source and resumes on the mux "drain" event. The receive side emits "data"/"end"/"reset" and,
// for the relay, "head" (the response status and headers the plugin sends back).
class Stream extends EventEmitter {
  constructor(mux, id) {
    super();
    this.mux = mux;
    this.id = id;
    this.ended = false;
    this.closed = false;
  }
  head(meta) { return this.closed ? false : this.mux._send(this.id, FrameType.HEAD, Buffer.from(JSON.stringify(meta))); }
  writeData(chunk) { return this.closed ? false : this.mux._send(this.id, FrameType.DATA, chunk); }
  end() {
    if (this.ended || this.closed) return;
    this.ended = true;
    this.mux._send(this.id, FrameType.END);
  }
  // Drop the stream locally after both directions are done; no frame is sent.
  close() {
    if (this.closed) return;
    this.closed = true;
    this.mux.streams.delete(this.id);
  }
  // Abort the stream and tell the other side.
  reset() {
    if (this.closed) return;
    this.closed = true;
    this.mux.streams.delete(this.id);
    this.mux._send(this.id, FrameType.RESET);
  }
}

export function createMux(socket, { onStream, onClose, role } = {}) {
  const mux = new EventEmitter();
  mux.setMaxListeners(0); // one transient "drain" listener per in-flight stream
  mux.streams = new Map();
  socket.setNoDelay?.(true);
  let buf = Buffer.alloc(0);
  let nextId = 1; // only the opener (relay) allocates ids
  let lastRecv = Date.now();
  let closed = false;

  mux._send = (id, type, payload = Buffer.alloc(0)) => {
    if (closed) return false;
    const head = Buffer.allocUnsafe(HEADER);
    head.writeUInt32BE(id, 0);
    head.writeUInt8(type, 4);
    head.writeUInt32BE(payload.length, 5);
    socket.write(head);
    return payload.length ? socket.write(payload) : !socket.writableNeedDrain;
  };

  function shutdown(reason) {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    for (const stream of mux.streams.values()) {
      stream.closed = true;
      stream.emit("reset");
    }
    mux.streams.clear();
    socket.destroy();
    onClose?.(reason);
    mux.emit("close", reason);
  }

  function handle(id, type, payload) {
    lastRecv = Date.now();
    if (type === FrameType.PING) return void mux._send(id, FrameType.PONG);
    if (type === FrameType.PONG) return;
    if (type === FrameType.OPEN) {
      const stream = new Stream(mux, id);
      mux.streams.set(id, stream);
      onStream?.(stream, JSON.parse(payload.toString()));
      return;
    }
    const stream = mux.streams.get(id);
    if (!stream) return; // frame for a stream already torn down
    if (type === FrameType.HEAD) stream.emit("head", JSON.parse(payload.toString()));
    else if (type === FrameType.DATA) stream.emit("data", payload);
    else if (type === FrameType.END) stream.emit("end");
    else if (type === FrameType.RESET) {
      stream.closed = true;
      mux.streams.delete(id);
      stream.emit("reset");
    }
  }

  socket.on("data", (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= HEADER) {
      const length = buf.readUInt32BE(5);
      if (length > maxFrameBytes) return shutdown("frame too large");
      if (buf.length < HEADER + length) break;
      const id = buf.readUInt32BE(0);
      const type = buf.readUInt8(4);
      const payload = buf.subarray(HEADER, HEADER + length);
      buf = buf.subarray(HEADER + length);
      try { handle(id, type, payload); } catch { shutdown("bad frame"); return; }
    }
  });
  socket.on("drain", () => mux.emit("drain"));
  socket.on("error", () => shutdown("socket error"));
  socket.on("close", () => shutdown("socket closed"));

  const timer = setInterval(() => {
    if (Date.now() - lastRecv > deadMs) return shutdown("no heartbeat");
    mux._send(0, FrameType.PING);
  }, heartbeatMs);
  timer.unref?.();

  // The relay opens a stream per request; the plugin never calls this.
  mux.open = (meta) => {
    const stream = new Stream(mux, nextId);
    nextId = nextId >= 0xffffffff ? 1 : nextId + 1;
    mux.streams.set(stream.id, stream);
    mux._send(stream.id, FrameType.OPEN, Buffer.from(JSON.stringify(meta)));
    return stream;
  };
  mux.close = () => shutdown("closed by caller");
  if (role) mux.role = role;
  return mux;
}

// Pipe a Node readable into a mux stream with backpressure, sending END when the source ends. With
// closeOnEnd the stream is also dropped locally (the responder is done after its last body chunk).
export function pumpInto(source, stream, { closeOnEnd = false } = {}) {
  const onDrain = () => source.resume();
  stream.mux.on("drain", onDrain);
  const cleanup = () => stream.mux.off("drain", onDrain);
  source.on("data", (chunk) => { if (!stream.writeData(chunk)) source.pause(); });
  source.on("end", () => { stream.end(); if (closeOnEnd) stream.close(); cleanup(); });
  source.on("error", () => { stream.reset(); cleanup(); });
  stream.once("reset", () => { source.destroy?.(); cleanup(); });
}
