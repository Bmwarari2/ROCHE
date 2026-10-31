import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ZipWriter } from "../src/services/zip-writer";
import { unzip } from "./support/unzip";

/**
 * The streaming ZIP writer behind the full export (PLAT-015; HZ-071): every file reads back
 * byte for byte with its CRC-32, whatever its source, and the archive is read while it is written.
 */

async function collect(writer: ZipWriter, build: () => Promise<void>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const reading = (async () => {
    for await (const chunk of writer.output) chunks.push(chunk as Buffer);
  })();
  await build();
  await reading;
  return Buffer.concat(chunks);
}

async function* inParts(data: Buffer, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size);
}

describe("the streaming ZIP writer", () => {
  const big = randomBytes(3 * 1024 * 1024);
  type Source = () => string | Uint8Array | AsyncIterable<Uint8Array>;
  it.each<readonly [string, string, Buffer, Source]>([
    ["an empty file", "empty.csv", Buffer.alloc(0), () => ""],
    [
      "a string",
      "tables/person.csv",
      Buffer.from("id,name\n1,Ada Example\n"),
      () => "id,name\n1,Ada Example\n",
    ],
    ["bytes", "documents/a.pdf", Buffer.from([1, 2, 3, 255]), () => new Uint8Array([1, 2, 3, 255])],
    ["a stream of parts", "big.bin", big, () => inParts(big, 65_536)],
    ["a non-ASCII name", "tables/café.jsonl", Buffer.from("{}\n"), () => "{}\n"],
  ])("writes %s that reads back exactly", async (_, path, expected, source) => {
    const writer = new ZipWriter();
    let written = { bytes: -1, sha256: "" };
    const archive = await collect(writer, async () => {
      written = await writer.add(path, source() as string);
      await writer.add("manifest.json", "{}");
      await writer.finish();
    });
    const files = unzip(archive);
    expect(files.get(path)).toEqual(expected);
    expect(files.get("manifest.json")?.toString()).toBe("{}");
    expect(written.bytes).toBe(expected.length);
    expect(written.sha256).toBe(createHash("sha256").update(expected).digest("hex"));
    expect(writer.size).toBe(archive.length);
  });

  it("writes ZIP64 end records when there are 65,535 files or more", async () => {
    const writer = new ZipWriter();
    const archive = await collect(writer, async () => {
      for (let i = 0; i < 65_536; i += 1) await writer.add(`f/${i}`, "");
      await writer.finish();
    });
    const files = unzip(archive);
    expect(files.size).toBe(65_536);
    expect(files.get("f/65535")?.length).toBe(0);
  }, 60_000);

  it("rejects promptly when the source fails partway, and stops the archive", async () => {
    const writer = new ZipWriter();
    const reading = (async () => {
      for await (const _ of writer.output) {
        // drain
      }
    })().catch((error: Error) => error);
    async function* failing(): AsyncGenerator<Uint8Array> {
      yield randomBytes(200_000);
      throw new Error("source failed");
    }
    await expect(writer.add("big.bin", failing())).rejects.toThrow("source failed");
    writer.abort(new Error("source failed"));
    expect(await reading).toBeInstanceOf(Error);
  });

  it("rejects promptly when the reader stops partway (a failed upload)", async () => {
    const writer = new ZipWriter();
    let read = 0;
    writer.output.on("data", (chunk: Buffer) => {
      read += chunk.length;
      if (read > 100_000) writer.output.destroy(new Error("upload failed"));
    });
    writer.output.on("error", () => undefined);
    await expect(writer.add("big.bin", inParts(randomBytes(4_000_000), 16_384))).rejects.toThrow();
  });

  it("pulls nothing more from the source once the reader has died mid-pull, and closes it first", async () => {
    const writer = new ZipWriter();
    const pulls: number[] = [];
    let closed = false;
    async function* slow(): AsyncGenerator<Uint8Array> {
      try {
        for (let i = 0; i < 100; i += 1) {
          pulls.push(i);
          // A cursor FETCH: the source is mid-await when the reader dies.
          await new Promise((resolve) => setTimeout(resolve, 20));
          yield randomBytes(200_000);
        }
      } finally {
        closed = true;
      }
    }
    writer.output.once("data", () => {
      setTimeout(() => writer.output.destroy(new Error("upload failed")), 5);
    });
    await expect(writer.add("slow.bin", slow())).rejects.toThrow();
    const after = pulls.length;
    expect(closed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(pulls.length).toBe(after);
  });

  it("refuses at once to wait on a stream that has already closed", async () => {
    const writer = new ZipWriter();
    writer.abort(new Error("gone"));
    await expect(writer.add("x.csv", "a,b\n")).rejects.toThrow();
  });
});
