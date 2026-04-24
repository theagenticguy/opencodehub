/**
 * LSP Content-Length framing.
 *
 * The Language Server Protocol wire format is JSON-RPC 2.0 with a minimal
 * HTTP-style header: `Content-Length: N\r\n\r\n<N bytes of UTF-8 JSON>`.
 * This module owns the bytes-in / bytes-out boundary so the rest of the
 * client can pretend the stream is a queue of parsed messages.
 *
 * The parser is pull-based — callers `append()` bytes as they arrive on
 * stdout and call `drain()` to extract every complete message the buffer
 * holds. It tolerates partial reads (Node's `ReadableStream` often hands
 * over chunks mid-header) and preserves leftover bytes for the next call.
 */

const HEADER_TERMINATOR = "\r\n\r\n";
const CONTENT_LENGTH_RE = /^Content-Length:\s*(\d+)\s*$/im;

/** Serialize a JSON-RPC message to an LSP frame. */
export function encodeFrame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf-8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  return Buffer.concat([header, body]);
}

/**
 * Stateful frame decoder. One instance per LSP stream.
 *
 * `append(chunk)` + `drain()` is the standard loop. `drain()` is safe to
 * call any number of times — it will return an empty array if the buffer
 * doesn't yet contain a complete frame.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  append(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  /**
   * Pull every complete frame out of the internal buffer. Partial frames
   * stay buffered for the next append/drain cycle.
   *
   * Throws if a header is malformed — malformed headers are a hard failure
   * on the LSP wire, not a recoverable condition.
   */
  drain(): unknown[] {
    const messages: unknown[] = [];
    while (true) {
      const headerEnd = this.buffer.indexOf(HEADER_TERMINATOR);
      if (headerEnd === -1) {
        return messages;
      }
      const headerText = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = CONTENT_LENGTH_RE.exec(headerText);
      if (!match || match[1] === undefined) {
        throw new Error(
          `lsp-oracle: missing Content-Length header in frame; got ${JSON.stringify(headerText)}`,
        );
      }
      const length = Number.parseInt(match[1], 10);
      if (!Number.isFinite(length) || length < 0) {
        throw new Error(`lsp-oracle: invalid Content-Length ${JSON.stringify(match[1])}`);
      }
      const bodyStart = headerEnd + HEADER_TERMINATOR.length;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) {
        // Not enough bytes yet — wait for the next append.
        return messages;
      }
      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf-8");
      this.buffer = this.buffer.subarray(bodyEnd);
      try {
        messages.push(JSON.parse(body));
      } catch (err) {
        throw new Error(`lsp-oracle: invalid JSON in LSP frame body: ${(err as Error).message}`);
      }
    }
  }

  /** Length of unparsed bytes still in the buffer. Mainly for tests. */
  get bufferedBytes(): number {
    return this.buffer.length;
  }
}
