import { describe, expect, it } from "vitest";

/**
 * Screens cannot be rendered in these Node tests (no React Native runtime), so these checks read
 * the screen files: every Care mode screen about a person shows the point-of-care header and blocks
 * screen capture, and Today shows the sync status. The Maestro flows exercise them on a device.
 */

interface Fs {
  readdirSync(path: string): string[];
  readFileSync(path: string, encoding: "utf8"): string;
}

async function screenSources(): Promise<Array<{ file: string; source: string }>> {
  // A variable module name keeps node:fs out of the app's type graph (React Native types only).
  const fsName = "node:fs";
  const fs = (await import(/* @vite-ignore */ fsName)) as Fs;
  const dir = new URL("../app/(care)/people/[personId]/", import.meta.url);
  return fs
    .readdirSync(decodeURIComponent(dir.pathname))
    .filter((file) => file.endsWith(".tsx"))
    .map((file) => ({
      file,
      source: fs.readFileSync(decodeURIComponent(new URL(file, dir).pathname), "utf8"),
    }));
}

describe("Care mode screens", () => {
  it("hazard HZ-001 every screen about a person shows the point-of-care header", async () => {
    const screens = await screenSources();
    expect(screens.map((s) => s.file).sort()).toEqual([
      "body-map.tsx",
      "care-plan.tsx",
      "chart.tsx",
      "index.tsx",
      "note.tsx",
      "risks.tsx",
    ]);
    for (const { file, source } of screens) {
      const header = source.includes("<CarePersonHeader") || source.includes("<FormScreen");
      expect(header, file).toBe(true);
    }
  });

  it("blocks screenshots on every record screen", async () => {
    for (const { file, source } of await screenSources()) {
      expect(source.includes("useRecordScreenProtection("), file).toBe(true);
    }
  });

  it("hazard HZ-002 Today shows the last successful sync and the changes waiting to upload", async () => {
    const fsName = "node:fs";
    const fs = (await import(/* @vite-ignore */ fsName)) as Fs;
    const today = fs.readFileSync(
      decodeURIComponent(new URL("../app/(care)/today.tsx", import.meta.url).pathname),
      "utf8",
    );
    expect(today).toContain("syncSummary(");
    expect(today).toContain('testID="today-sync-last"');
    expect(today).toContain('testID="today-sync-queued"');
    expect(today).toContain("<UploadIssues");
  });

  it("hazard HZ-001 the form layout itself starts with the header", async () => {
    const fsName = "node:fs";
    const fs = (await import(/* @vite-ignore */ fsName)) as Fs;
    const form = fs.readFileSync(
      decodeURIComponent(new URL("../components/FormScreen.tsx", import.meta.url).pathname),
      "utf8",
    );
    expect(form.indexOf("<CarePersonHeader")).toBeGreaterThan(-1);
    expect(form.indexOf("<CarePersonHeader")).toBeLessThan(form.indexOf("{children}"));
  });
});
