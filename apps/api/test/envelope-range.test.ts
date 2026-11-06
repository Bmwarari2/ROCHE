import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EncryptingDocumentStorage, sliceStream } from "../src/integrations/envelope";
import { LocalDocumentStorage } from "../src/integrations/storage";
import { LocalTenantKeys } from "../src/integrations/tenant-keys";

const dir = mkdtempSync(join(tmpdir(), "harbour-range-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function collect(source: AsyncIterable<Uint8Array> | null): Promise<Buffer> {
  if (!source) throw new Error("no object");
  const parts: Buffer[] = [];
  for await (const chunk of source) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

describe("sliceStream", () => {
  it.each([
    ["inside one chunk", 1, 2, "bc"],
    ["across chunks", 2, 6, "cdefg"],
    ["the first byte", 0, 0, "a"],
    ["to the end", 7, 9, "hij"],
    ["past the end", 8, 20, "ij"],
  ])("%s", async (_name, start, end, expected) => {
    const chunks = ["abc", "def", "ghij"].map((s) => new TextEncoder().encode(s));
    expect((await collect(sliceStream(chunks as never, start, end))).toString()).toBe(expected);
  });
});

describe("an encrypted object read by range (e-learning packages, ADR-0093 and ADR-0109)", () => {
  it("returns exactly the plaintext bytes asked for, across segments", async () => {
    const store = new EncryptingDocumentStorage(
      new LocalDocumentStorage(dir),
      new LocalTenantKeys(),
      { legacyPlaintext: false },
    );
    const key =
      "tenants/00000000-0000-4000-8000-000000000001/documents/00000000-0000-4000-8000-000000000002";
    const bytes = new Uint8Array(200_000).map((_, i) => i % 251);
    await store.put(key, bytes, "application/zip");
    for (const [start, end] of [
      [0, 9],
      [65_530, 65_545],
      [199_990, 199_999],
    ] as const) {
      const got = await collect(await store.getRange(key, start, end));
      expect([...got]).toEqual([...bytes.subarray(start, end + 1)]);
    }
    expect(await store.getRange(`${key.slice(0, -1)}3`, 0, 1)).toBeNull();
  });
});
