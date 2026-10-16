import { createHash } from "node:crypto";
import { PassThrough, type Writable } from "node:stream";
import { crc32, createDeflateRaw } from "node:zlib";

/**
 * A streaming ZIP writer (PKWARE APPNOTE 6.3) for the full export: each file is deflated as it is
 * read and written straight to the output stream, so no file and no archive is held in memory.
 * Sizes and CRC-32 follow each file in a data descriptor; the central directory, with ZIP64
 * records when the archive passes 4 GiB or 65,535 files, closes it. A single file of 4 GiB or more
 * is refused (the export then fails rather than writing an archive a reader would misread).
 */

const LIMIT = 0xffffffff;
const UTF8_AND_DESCRIPTOR = 0x0808; // bit 11: UTF-8 names; bit 3: sizes in a data descriptor
const DEFLATE = 8;

interface Entry {
  readonly name: Buffer;
  readonly crc: number;
  readonly compressed: number;
  readonly size: number;
  readonly offset: number;
}

export interface WrittenEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export class ZipWriter {
  /** The archive's bytes, for the storage port to consume as they are made. */
  readonly output = new PassThrough();
  private readonly entries: Entry[] = [];
  private offset = 0;

  constructor() {
    // A stopped archive's error reaches the writer (`add` rejects) and the reader (the upload);
    // an 'error' event with no listener would crash the worker instead.
    this.output.on("error", () => undefined);
  }

  /** Bytes written so far: the archive's size once finished. */
  get size(): number {
    return this.offset;
  }

  private async write(chunk: Buffer): Promise<void> {
    if (this.output.destroyed) throw new Error("The archive's stream has closed.");
    this.offset += chunk.length;
    if (!this.output.write(chunk)) await drained(this.output);
  }

  /** Stops the archive: a pending write rejects, and the reader sees the error. */
  abort(error: Error): void {
    this.output.destroy(error);
  }

  /** Adds one file, deflated; answers its size and SHA-256 (of the original bytes). */
  async add(
    path: string,
    source:
      | AsyncIterable<Uint8Array | string>
      | Iterable<Uint8Array | string>
      | Uint8Array
      | string,
  ): Promise<WrittenEntry> {
    const name = Buffer.from(path, "utf8");
    const offset = this.offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_AND_DESCRIPTOR, 6);
    local.writeUInt16LE(DEFLATE, 8);
    local.writeUInt16LE(name.length, 26);
    await this.write(Buffer.concat([local, name]));

    const hash = createHash("sha256");
    const deflate = createDeflateRaw();
    let crc = 0;
    let size = 0;
    let compressed = 0;
    const input = typeof source === "string" || source instanceof Uint8Array ? [source] : source;
    // Read the source and drain the deflater together: if either fails, the other is stopped
    // (`deflate.destroy`), so a failed source or a closed archive never leaves a wait hanging.
    const feed = async () => {
      try {
        for await (const part of input) {
          const chunk = typeof part === "string" ? Buffer.from(part, "utf8") : part;
          crc = crc32(chunk, crc);
          size += chunk.length;
          hash.update(chunk);
          if (!deflate.write(chunk)) await drained(deflate);
        }
        deflate.end();
      } catch (error) {
        deflate.destroy(error as Error);
        throw error;
      }
    };
    const drain = async () => {
      try {
        for await (const out of deflate as AsyncIterable<Buffer>) {
          compressed += out.length;
          await this.write(out);
        }
      } catch (error) {
        deflate.destroy(error as Error);
        throw error;
      }
    };
    await Promise.all([feed(), drain()]);
    if (size >= LIMIT || compressed >= LIMIT) {
      throw new RangeError("A single file in the export is too large for the archive.");
    }
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc >>> 0, 4);
    descriptor.writeUInt32LE(compressed, 8);
    descriptor.writeUInt32LE(size, 12);
    await this.write(descriptor);
    this.entries.push({ name, crc, compressed, size, offset });
    return { path, bytes: size, sha256: hash.digest("hex") };
  }

  /** Writes the central directory (with ZIP64 records when needed) and ends the output. */
  async finish(): Promise<void> {
    const start = this.offset;
    for (const e of this.entries) {
      const zip64 = e.offset >= LIMIT;
      const extra = zip64 ? Buffer.alloc(12) : Buffer.alloc(0);
      if (zip64) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(8, 2);
        extra.writeBigUInt64LE(BigInt(e.offset), 4);
      }
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(zip64 ? 45 : 20, 4);
      header.writeUInt16LE(zip64 ? 45 : 20, 6);
      header.writeUInt16LE(UTF8_AND_DESCRIPTOR, 8);
      header.writeUInt16LE(DEFLATE, 10);
      header.writeUInt32LE(e.crc >>> 0, 16);
      header.writeUInt32LE(e.compressed, 20);
      header.writeUInt32LE(e.size, 24);
      header.writeUInt16LE(e.name.length, 28);
      header.writeUInt16LE(extra.length, 30);
      header.writeUInt32LE(zip64 ? LIMIT : e.offset, 42);
      await this.write(Buffer.concat([header, e.name, extra]));
    }
    const size = this.offset - start;
    const count = this.entries.length;
    if (count >= 0xffff || start >= LIMIT || size >= LIMIT) {
      const record = Buffer.alloc(56);
      record.writeUInt32LE(0x06064b50, 0);
      record.writeBigUInt64LE(44n, 4);
      record.writeUInt16LE(45, 12);
      record.writeUInt16LE(45, 14);
      record.writeBigUInt64LE(BigInt(count), 24);
      record.writeBigUInt64LE(BigInt(count), 32);
      record.writeBigUInt64LE(BigInt(size), 40);
      record.writeBigUInt64LE(BigInt(start), 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeBigUInt64LE(BigInt(this.offset), 8);
      locator.writeUInt32LE(1, 16);
      await this.write(Buffer.concat([record, locator]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Math.min(count, 0xffff), 8);
    end.writeUInt16LE(Math.min(count, 0xffff), 10);
    end.writeUInt32LE(Math.min(size, LIMIT), 12);
    end.writeUInt32LE(Math.min(start, LIMIT), 16);
    await this.write(end);
    this.output.end();
  }
}

/** Waits for a stream to drain, or rejects when it closes or fails first. */
function drained(stream: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      stream.off("close", closed);
      stream.off("error", failed);
      resolve();
    };
    const failed = (error: Error) => {
      stream.off("drain", done);
      stream.off("close", closed);
      stream.off("error", failed);
      reject(error);
    };
    const closed = () => failed(new Error("The stream closed before it drained."));
    stream.once("drain", done);
    stream.once("close", closed);
    stream.once("error", failed);
  });
}
