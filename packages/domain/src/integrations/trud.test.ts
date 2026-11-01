import { describe, expect, it } from "vitest";
import { checkTrudRelease, dmdArchiveEntryName, TRUD_DEFAULT_HOSTS, trudUrlAllowed } from "./trud";

/** The TRUD dm+d download's rules (integrations.md section 11, "Release download"; slice 75). */

const SHA = "a".repeat(64);
const limits = { maxArchiveBytes: 1_000_000, allowedHosts: TRUD_DEFAULT_HOSTS };
const release = {
  id: "nhsbsa_dmd_10.1.0_20261026000001.zip",
  name: "Release 10.1.0",
  releaseDate: "2026-10-26",
  archiveFileName: "nhsbsa_dmd_10.1.0_20261026000001.zip",
  archiveFileUrl:
    "https://isd.digital.nhs.uk/download/api/v1/keys/KEY/content/items/24/nhsbsa_dmd_10.1.0_20261026000001.zip",
  archiveFileSizeBytes: 123_456,
  archiveFileSha256: SHA,
};
const answer = (releases: unknown[]) => ({ apiVersion: "1", releases, httpStatus: 200 });

describe("checkTrudRelease", () => {
  it("accepts one release with a dated archive name, an allowed address, a size and a SHA-256", () => {
    expect(checkTrudRelease(answer([release]), limits)).toEqual({
      ok: true,
      release: {
        name: "nhsbsa_dmd_10.1.0_20261026000001",
        releasedOn: "2026-10-26",
        archiveUrl: release.archiveFileUrl,
        bytes: 123_456,
        sha256: SHA,
      },
    });
  });

  it("reads an upper-case SHA-256 as lower case", () => {
    const upper = { ...release, archiveFileSha256: "A".repeat(64) };
    const verdict = checkTrudRelease(answer([upper]), limits);
    expect(verdict.ok && verdict.release.sha256).toBe(SHA);
  });

  it.each([
    ["no answer", null],
    ["no releases", answer([])],
    ["two releases", answer([release, release])],
    ["a release that is not an object", answer(["x"])],
    ["no archive name", answer([{ ...release, archiveFileName: undefined }])],
    ["an archive name with a path", answer([{ ...release, archiveFileName: "../x_20261026.zip" }])],
    ["an archive name without a date", answer([{ ...release, archiveFileName: "nhsbsa_dmd.zip" }])],
    [
      "an archive that is not a zip",
      answer([{ ...release, archiveFileName: "nhsbsa_dmd_10.1.0_20261026000001.tar" }]),
    ],
    [
      "a plain-http address",
      answer([{ ...release, archiveFileUrl: release.archiveFileUrl.replace("https", "http") }]),
    ],
    [
      "an address on another host",
      answer([{ ...release, archiveFileUrl: "https://example.invalid/x.zip" }]),
    ],
    ["a size of zero", answer([{ ...release, archiveFileSizeBytes: 0 }])],
    ["a size over the limit", answer([{ ...release, archiveFileSizeBytes: 1_000_001 }])],
    ["a size that is not a whole number", answer([{ ...release, archiveFileSizeBytes: 1.5 }])],
    ["no SHA-256", answer([{ ...release, archiveFileSha256: undefined }])],
    ["a short SHA-256", answer([{ ...release, archiveFileSha256: "ab" }])],
    [
      "a SHA-256 that is not hexadecimal",
      answer([{ ...release, archiveFileSha256: "g".repeat(64) }]),
    ],
  ])("refuses %s", (_case, body) => {
    expect(checkTrudRelease(body, limits)).toMatchObject({
      ok: false,
      code: "trud_response_invalid",
    });
  });
});

describe("trudUrlAllowed", () => {
  it.each([
    ["https://isd.digital.nhs.uk/trud/api/v1/x", true],
    ["https://ISD.digital.nhs.uk/x", true],
    ["http://isd.digital.nhs.uk/x", false],
    ["https://isd.digital.nhs.uk.example.invalid/x", false],
    ["https://evil.example.invalid/isd.digital.nhs.uk", false],
    ["https://user@isd.digital.nhs.uk/x", false],
    ["https://isd.digital.nhs.uk:8443/x", false],
    ["not a url", false],
    ["file:///etc/passwd", false],
  ])("%s: %s", (url, allowed) => {
    expect(trudUrlAllowed(url, TRUD_DEFAULT_HOSTS)).toBe(allowed);
  });

  it("allows a test host only when it is named, and plain http only when asked for", () => {
    expect(trudUrlAllowed("http://127.0.0.1:4010/x", ["127.0.0.1:4010"])).toBe(false);
    expect(trudUrlAllowed("http://127.0.0.1:4010/x", ["127.0.0.1:4010"], { allowHttp: true })).toBe(
      true,
    );
  });
});

describe("dmdArchiveEntryName", () => {
  const release = "nhsbsa_dmd_10.1.0_20261026000001";
  it.each([
    ["f_vmp2_3261026.xml", { kind: "xml", name: "f_vmp2_3261026.xml" }],
    [`${release}/f_vmp2_3261026.xml`, { kind: "xml", name: "f_vmp2_3261026.xml" }],
    ["week432026-r2_3-GTIN.zip", { kind: "zip", name: "week432026-r2_3-GTIN.zip" }],
    [`${release}/`, { kind: "skip" }],
    ["readme.txt", { kind: "skip" }],
    ["../f_vmp2.xml", { kind: "unsafe" }],
    ["/f_vmp2.xml", { kind: "unsafe" }],
    ["a\\b.xml", { kind: "unsafe" }],
    ["other/f_vmp2.xml", { kind: "unsafe" }],
    [`${release}/deeper/f_vmp2.xml`, { kind: "unsafe" }],
    ["C:f_vmp2.xml", { kind: "unsafe" }],
    [".hidden.xml", { kind: "unsafe" }],
    ["f vmp2.xml", { kind: "unsafe" }],
    ["", { kind: "unsafe" }],
  ])("%j", (entry, expected) => {
    expect(dmdArchiveEntryName(entry, release)).toEqual(expected);
  });
});
