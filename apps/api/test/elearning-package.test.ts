import { describe, expect, it } from "vitest";
import {
  analysePackage,
  entryStream,
  extractEntry,
  indexEntry,
  type PackageIndexEntry,
  readZipDirectory,
  signLaunchToken,
  verifyEntries,
  verifyLaunchToken,
} from "../src/services/elearning-package";
import {
  buildZip,
  SCORM12_MANIFEST,
  SCORM12_PACKAGE,
  SCORM2004_MANIFEST,
  TINCAN,
} from "./support/zip";

/**
 * Package checks and launch tokens (workforce.md section 14; ADR-0093; slice 43): the archive is
 * read from its central directory and refused before anything is inflated when an entry leaves
 * the package, is a link, is encrypted or would unpack too far; a lying size or CRC is caught on
 * extraction; manifests are read without entities; tokens are signed, bound and short-lived.
 */

const once = (bytes: Buffer) =>
  (async function* () {
    yield bytes;
  })();
const read = async (stream: AsyncIterable<Buffer>) => {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(part);
  return Buffer.concat(parts).toString("utf8");
};

const code = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
};

describe("WORK-006 packages are checked before anything is unpacked", () => {
  it("reads a SCORM 1.2 package and finds its launch page", () => {
    expect(analysePackage(SCORM12_PACKAGE())).toMatchObject({
      standard: "scorm_1_2",
      launchPath: "index.html",
      launchQuery: "lang=en",
      identifier: "fire-safety-1",
      fileCount: 3,
      unpackedBytes: expect.any(Number),
    });
  });

  it("reads a SCORM 2004 package, honouring the resource's base", () => {
    const zip = buildZip([
      { name: "imsmanifest.xml", data: SCORM2004_MANIFEST },
      { name: "course/start.html", data: "<!doctype html>" },
    ]);
    expect(analysePackage(zip)).toMatchObject({
      standard: "scorm_2004",
      launchPath: "course/start.html",
    });
  });

  it("reads an xAPI package from tincan.xml", () => {
    const zip = buildZip([
      { name: "tincan.xml", data: TINCAN },
      { name: "story.html", data: "<!doctype html>" },
    ]);
    expect(analysePackage(zip)).toMatchObject({
      standard: "xapi",
      launchPath: "story.html",
      identifier: "https://courses.example.invalid/fire",
    });
  });

  it.each([
    ["path traversal", [{ name: "../../evil.html", data: "x" }], "archive_entry_name"],
    ["an absolute path", [{ name: "/etc/cron.html", data: "x" }], "archive_entry_name"],
    ["a backslash path", [{ name: "..\\evil.html", data: "x" }], "archive_entry_name"],
    [
      "a symbolic link",
      [{ name: "link.html", data: "/etc/passwd", symlink: true }],
      "archive_symlink",
    ],
    ["an encrypted entry", [{ name: "a.html", data: "x", encrypted: true }], "archive_encrypted"],
    ["a server-side script", [{ name: "x.php", data: "<?php" }], "archive_file_type"],
    [
      "a non-ASCII name without the UTF-8 flag",
      [{ name: "café.html", data: "x", latin1: true }],
      "entry_name",
    ],
    [
      "a zip bomb (one entry unpacking far beyond its packed size)",
      [{ name: "bomb.html", data: Buffer.alloc(5 * 1024 * 1024, 0x41) }],
      "archive_ratio",
    ],
  ])("refuses %s", (_name, entries, expected) => {
    expect(
      code(() =>
        analysePackage(buildZip([{ name: "imsmanifest.xml", data: SCORM12_MANIFEST }, ...entries])),
      ),
    ).toBe(expected);
  });

  it("refuses a header that lies about the size or the CRC when the file is read", () => {
    const lyingSize = buildZip([{ name: "a.html", data: "x".repeat(1000), declaredSize: 10 }]);
    const [entry] = readZipDirectory(lyingSize);
    expect(code(() => extractEntry(lyingSize, entry as never))).toBe("malformed");
    const lyingCrc = buildZip([{ name: "a.html", data: "hello", crc: 1234 }]);
    const [other] = readZipDirectory(lyingCrc);
    expect(code(() => extractEntry(lyingCrc, other as never))).toBe("malformed");
  });

  it("refuses ZIP64 markers and things that are not archives", () => {
    const zip = buildZip([{ name: "a.html", data: "x" }]);
    zip.writeUInt16LE(0xffff, zip.length - 12);
    expect(code(() => readZipDirectory(zip))).toBe("zip64");
    expect(code(() => readZipDirectory(Buffer.from("%PDF-1.7 not a zip at all, sorry")))).toBe(
      "not_zip",
    );
  });

  it("reads manifests without entities and refuses a DOCTYPE", () => {
    const evil = `<?xml version="1.0"?><!DOCTYPE m [<!ENTITY x SYSTEM "file:///etc/passwd">]>${SCORM12_MANIFEST.replace(/^<\?xml[^>]*>/, "")}`;
    const zip = buildZip([
      { name: "imsmanifest.xml", data: evil },
      { name: "index.html", data: "x" },
    ]);
    expect(code(() => analysePackage(zip))).toBe("manifest_doctype");
  });

  it("refuses a launch page outside the package or missing from it", () => {
    const outside = buildZip([
      {
        name: "imsmanifest.xml",
        data: SCORM12_MANIFEST.replace("index.html?lang=en", "https://evil.example.invalid/x.html"),
      },
      { name: "index.html", data: "x" },
    ]);
    expect(code(() => analysePackage(outside))).toBe("bad_launch");
    const missing = buildZip([{ name: "imsmanifest.xml", data: SCORM12_MANIFEST }]);
    expect(code(() => analysePackage(missing))).toBe("bad_launch");
    expect(code(() => analysePackage(buildZip([{ name: "index.html", data: "x" }])))).toBe(
      "no_manifest",
    );
  });

  it("indexes a package's own files and serves each from its own bytes, as a stream", async () => {
    const zip = SCORM12_PACKAGE();
    const { index } = analysePackage(zip);
    expect(indexEntry(index, "missing.js")).toBeNull();
    expect(indexEntry(index, "img/")).toBeNull();
    const app = indexEntry(index, "app.js") as PackageIndexEntry;
    // Only the file's own packed bytes are read (as a ranged read of the stored archive would).
    const text = await read(entryStream(once(zip.subarray(app.o, app.o + app.c)), app));
    expect(text).toContain("window.parent.API");
    await expect(verifyEntries(zip, index)).resolves.toBeUndefined();
  });

  it("fails a served file whose bytes do not match its size or CRC (review H2)", async () => {
    const zip = SCORM12_PACKAGE();
    const app = indexEntry(analysePackage(zip).index, "app.js") as PackageIndexEntry;
    const packed = zip.subarray(app.o, app.o + app.c);
    await expect(read(entryStream(once(packed), { ...app, k: app.k ^ 1 }))).rejects.toThrow();
    await expect(read(entryStream(once(packed), { ...app, u: app.u - 1 }))).rejects.toThrow();
    await expect(verifyEntries(zip, [{ ...app, k: app.k ^ 1 }])).rejects.toThrow();
  });
});

describe("WORK-006 two readers cannot see different archives (review M3)", () => {
  const two = () =>
    buildZip([
      { name: "a.html", data: "first", store: true },
      { name: "b.html", data: "second", store: true },
    ]);
  const eocdOf = (zip: Buffer) => zip.length - 22;
  const cdOffsetOf = (zip: Buffer) => zip.readUInt32LE(eocdOf(zip) + 16);

  it("reads a well-formed archive", () => {
    expect(readZipDirectory(two()).map((e) => e.name)).toEqual(["a.html", "b.html"]);
  });

  it.each<[string, (zip: Buffer) => Buffer, string]>([
    [
      "a local header whose method differs from the central entry",
      (zip) => {
        zip.writeUInt16LE(8, 8);
        return zip;
      },
      "malformed",
    ],
    [
      "a local header whose name differs from the central entry",
      (zip) => {
        zip.write("x", 30);
        return zip;
      },
      "malformed",
    ],
    [
      "a local header whose sizes differ from the central entry",
      (zip) => {
        zip.writeUInt32LE(1, 22);
        return zip;
      },
      "malformed",
    ],
    [
      "two central entries sharing one entry's data",
      (zip) => {
        const second = cdOffsetOf(zip) + 46 + "a.html".length;
        zip.writeUInt32LE(0, second + 42);
        return zip;
      },
      "malformed",
    ],
    [
      "bytes hidden before the first entry",
      (zip) => {
        const out = Buffer.concat([Buffer.alloc(16), zip]);
        const eocd = eocdOf(out);
        out.writeUInt32LE(out.readUInt32LE(eocd + 16) + 16, eocd + 16);
        let p = out.readUInt32LE(eocd + 16);
        for (let n = 0; n < 2; n += 1) {
          out.writeUInt32LE(out.readUInt32LE(p + 42) + 16, p + 42);
          p += 46 + out.readUInt16LE(p + 28);
        }
        return out;
      },
      "malformed",
    ],
    [
      "a second end record planted in the comment",
      (zip) => {
        const end = zip.subarray(eocdOf(zip));
        const real = Buffer.from(end);
        real.writeUInt16LE(22, 20);
        return Buffer.concat([zip.subarray(0, eocdOf(zip)), real, end]);
      },
      "malformed",
    ],
    [
      "a ZIP64 locator before a classic end record",
      (zip) => {
        const locator = Buffer.alloc(20);
        locator.writeUInt32LE(0x07064b50, 0);
        return Buffer.concat([zip.subarray(0, eocdOf(zip)), locator, zip.subarray(eocdOf(zip))]);
      },
      "zip64",
    ],
    ["bytes after the end record", (zip) => Buffer.concat([zip, Buffer.from("junk")]), "not_zip"],
  ])("refuses %s", (_name, change, expected) => {
    expect(code(() => readZipDirectory(change(two())))).toBe(expected);
  });

  it("refuses a manifest nested deeper than any real one, as a refusal not a crash (review L3)", () => {
    const depth = 200;
    const nested = `${"<item>".repeat(depth)}${"</item>".repeat(depth)}`;
    const zip = buildZip([
      {
        name: "imsmanifest.xml",
        data: SCORM12_MANIFEST.replace(
          '<item identifier="i1" identifierref="r1">',
          `<item>${nested}<item identifier="i1" identifierref="r1">`,
        ).replace("</organization>", "</item></organization>"),
      },
      { name: "index.html", data: "x" },
    ]);
    expect(code(() => analysePackage(zip))).toMatch(/^manifest_unreadable$|^malformed$/);
  });
});

describe("WORK-006 launch tokens are signed, bound to one attempt and short-lived", () => {
  const claims = {
    attemptId: "0199f300-0000-7000-8000-0000000000a1",
    tenantId: "0199f300-0000-7000-8000-0000000000b1",
    workerId: "0199f300-0000-7000-8000-0000000000c1",
    courseId: "0199f300-0000-7000-8000-0000000000d1",
    nonce: "0199f300-0000-7000-8000-0000000000e1",
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  };
  const secret = "test-elearning-launch-secret-0123456789abcdef";

  it("round-trips, and refuses a changed payload, another secret or an expired token", () => {
    const token = signLaunchToken(claims, secret);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyLaunchToken(token, secret)).toEqual(claims);
    const [payload, sig] = token.split(".");
    const other = Buffer.from(
      JSON.stringify([
        claims.attemptId,
        claims.tenantId,
        claims.courseId,
        claims.courseId,
        claims.nonce,
        claims.expiresAt,
      ]),
    ).toString("base64url");
    expect(verifyLaunchToken(`${other}.${sig}`, secret)).toBeNull();
    expect(verifyLaunchToken(token, `${secret}x`)).toBeNull();
    expect(verifyLaunchToken(`${payload}.${sig}.x`, secret)).toBeNull();
    expect(
      verifyLaunchToken(signLaunchToken({ ...claims, expiresAt: 1 }, secret), secret),
    ).toBeNull();
  });
});
