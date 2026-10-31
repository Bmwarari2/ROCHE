import { describe, expect, it } from "vitest";
import {
  checkFile,
  documentChip,
  fileSize,
  latestVersions,
  readSignature,
  readUpload,
  safeFileName,
  versionChain,
} from "./documents";
import { t } from "./i18n";

const form = (values: Record<string, unknown>) => ({
  get: (name: string) => (values[name] ?? null) as FormDataEntryValue | null,
});
const pdf = (size: number, name = "policy.pdf", type = "application/pdf") => ({ name, size, type });

describe("the document library (PLAT-009)", () => {
  it.each([
    ["available", "Available", "circle-check"],
    ["quarantined", "Held back: not yet checked for viruses", "triangle-alert"],
    ["destroyed", "Destroyed", "circle-minus"],
  ])("says a %s document's status with an icon and a word", (status, label, icon) => {
    expect(documentChip(status, t)).toMatchObject({ label, icon });
  });

  it("warns for a status it does not know", () => {
    expect(documentChip("mystery", t)).toMatchObject({ status: "overdue" });
  });

  it("gives sizes in words", () => {
    expect(fileSize(200, t)).toBe("1 KB");
    expect(fileSize(240_000, t)).toBe("240 KB");
    expect(fileSize(3_240_000, t)).toBe("3.2 MB");
  });

  it("takes a PDF of up to 25 MB and says why anything else is refused", () => {
    expect(checkFile(pdf(1000), t).ok).toBe(true);
    expect(checkFile(pdf(0), t)).toMatchObject({
      ok: false,
      error: "Choose a PDF file to upload.",
    });
    expect(checkFile(null, t).ok).toBe(false);
    expect(checkFile(pdf(1000, "photo.jpg", "image/jpeg"), t)).toMatchObject({
      ok: false,
      error: expect.stringContaining("PDF"),
    });
    expect(checkFile(pdf(25 * 1_048_576 + 1), t)).toMatchObject({
      ok: false,
      error: "Choose a file of 25 MB or less.",
    });
  });

  it("needs a title for a new document but not for a new version", () => {
    expect(readUpload(form({ title: "x", file: pdf(10) }), t, { needsTitle: true })).toMatchObject({
      ok: false,
      errors: { title: expect.any(String) },
    });
    expect(readUpload(form({ file: pdf(10) }), t, { needsTitle: false }).ok).toBe(true);
    expect(
      readUpload(form({ title: "  Medicines   policy ", file: pdf(10) }), t, { needsTitle: true }),
    ).toMatchObject({ ok: true, title: "Medicines policy" });
  });

  it("sends only the last part of a file name", () => {
    expect(safeFileName("C:\\Users\\someone\\policy.pdf")).toBe("policy.pdf");
    expect(safeFileName("folder/policy.pdf")).toBe("policy.pdf");
    expect(safeFileName(`${"a".repeat(300)}.pdf`)).toHaveLength(255);
  });

  it("signs only with a full name and the box ticked", () => {
    expect(readSignature(form({ typedName: "A", confirm: "yes" }), t).ok).toBe(false);
    expect(readSignature(form({ typedName: "Ada Example" }), t)).toMatchObject({
      ok: false,
      errors: { confirm: expect.any(String) },
    });
    expect(readSignature(form({ typedName: " Ada  Example ", confirm: "yes" }), t)).toEqual({
      ok: true,
      typedName: "Ada Example",
    });
  });

  it("follows the version chain newest first and lists only the latest of each document", () => {
    const v1 = { id: "1", previousVersionId: null };
    const v2 = { id: "2", previousVersionId: "1" };
    const v3 = { id: "3", previousVersionId: "2" };
    const other = { id: "9", previousVersionId: null };
    expect(versionChain(v3, [v1, v2, v3, other]).map((v) => v.id)).toEqual(["3", "2", "1"]);
    expect(versionChain(v2, [v1, v2, v3]).map((v) => v.id)).toEqual(["2", "1"]);
    expect(latestVersions([v1, v2, v3, other]).map((v) => v.id)).toEqual(["3", "9"]);
    // A loop never hangs the page.
    expect(
      versionChain({ id: "a", previousVersionId: "b" }, [{ id: "b", previousVersionId: "a" }]),
    ).toHaveLength(2);
  });
});
