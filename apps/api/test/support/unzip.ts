import { crc32, inflateRawSync } from "node:zlib";

/**
 * A minimal ZIP reader for tests: the central directory (with ZIP64 records), each entry inflated
 * and its CRC-32 checked, so the export's archive is read the way an unzip tool reads it.
 */
export function unzip(archive: Uint8Array): Map<string, Buffer> {
  const buf = Buffer.from(archive);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("no end of central directory");
  let count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) {
    const record = Number(buf.readBigUInt64LE(eocd - 20 + 8));
    count = Number(buf.readBigUInt64LE(record + 32));
    offset = Number(buf.readBigUInt64LE(record + 48));
  }
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error("bad central header");
    const crc = buf.readUInt32LE(offset + 16);
    const compressed = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    let local = buf.readUInt32LE(offset + 42);
    if (local === 0xffffffff) local = Number(buf.readBigUInt64LE(offset + 46 + nameLength + 4));
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLength);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = inflateRawSync(buf.subarray(dataStart, dataStart + compressed));
    if (crc32(data) >>> 0 !== crc) throw new Error(`CRC mismatch in ${name}`);
    files.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}
