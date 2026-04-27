/**
 * Minimal streaming protobuf wire-format reader scoped to the SCIP schema.
 *
 * A full protobuf runtime (protobufjs, google-protobuf, @bufbuild/protobuf)
 * brings in code generation and ~60 KB of runtime. SCIP only uses five
 * message types we care about (Index, Document, Occurrence,
 * SymbolInformation, Metadata/ToolInfo) and only four wire types. A
 * hand-rolled reader keeps the dependency surface empty and the entire
 * decoder under 250 LOC. See `proto/scip.proto` for the source of truth.
 */

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED32 = 5;

export class ProtoReader {
  private pos: number;

  constructor(
    private readonly buf: Uint8Array,
    start = 0,
    private readonly end: number = buf.byteLength,
  ) {
    this.pos = start;
  }

  get offset(): number {
    return this.pos;
  }

  get finished(): boolean {
    return this.pos >= this.end;
  }

  readTag(): { fieldNumber: number; wireType: number } {
    const tag = this.readVarint();
    return { fieldNumber: tag >>> 3, wireType: tag & 0x7 };
  }

  readVarint(): number {
    // SCIP field numbers + values fit safely in JS number range (< 2^53).
    // We still decode up to 10 bytes in case a producer emits larger values.
    let result = 0;
    let shift = 0;
    while (this.pos < this.end) {
      const byte = this.buf[this.pos++];
      if (byte === undefined) break;
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
      if (shift > 63) throw new Error("scip-ingest: varint too long");
    }
    throw new Error("scip-ingest: unexpected end of buffer in varint");
  }

  readString(): string {
    const len = this.readVarint();
    const start = this.pos;
    this.pos += len;
    return new TextDecoder().decode(this.buf.subarray(start, start + len));
  }

  readSubMessage(): Uint8Array {
    const len = this.readVarint();
    const start = this.pos;
    this.pos += len;
    return this.buf.subarray(start, start + len);
  }

  skip(wireType: number): void {
    switch (wireType) {
      case WIRE_VARINT:
        this.readVarint();
        return;
      case WIRE_FIXED64:
        this.pos += 8;
        return;
      case WIRE_LENGTH_DELIMITED: {
        const len = this.readVarint();
        this.pos += len;
        return;
      }
      case WIRE_FIXED32:
        this.pos += 4;
        return;
      default:
        throw new Error(`scip-ingest: unsupported wire type ${wireType}`);
    }
  }

  /**
   * Iterate every (fieldNumber, wireType) pair in the buffer and invoke
   * the provided visitor. The visitor MUST consume the field (or call
   * `this.skip(wireType)` for the current reader). Unknown fields can be
   * forwarded to `skip` by returning `false`.
   */
  forEachField(visit: (fieldNumber: number, wireType: number, self: ProtoReader) => boolean): void {
    while (!this.finished) {
      const { fieldNumber, wireType } = this.readTag();
      const consumed = visit(fieldNumber, wireType, this);
      if (!consumed) this.skip(wireType);
    }
  }

  /**
   * Read a packed or non-packed repeated int32 field into the provided array.
   * When the wire type is length-delimited, the field is packed; otherwise
   * the caller must invoke this helper once per non-packed tag.
   */
  readRepeatedInt32(wireType: number, out: number[]): void {
    if (wireType === WIRE_LENGTH_DELIMITED) {
      const len = this.readVarint();
      const end = this.pos + len;
      while (this.pos < end) out.push(this.readVarint());
    } else if (wireType === WIRE_VARINT) {
      out.push(this.readVarint());
    } else {
      throw new Error(`scip-ingest: unexpected wire type ${wireType} for int32 field`);
    }
  }
}

export const WireType = {
  VARINT: WIRE_VARINT,
  FIXED64: WIRE_FIXED64,
  LENGTH_DELIMITED: WIRE_LENGTH_DELIMITED,
  FIXED32: WIRE_FIXED32,
} as const;
