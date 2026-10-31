import { describe, expect, it } from "vitest";
import {
  ARCHIVE_LIMITS,
  type ArchiveEntry,
  archiveProblem,
  attemptOutcome,
  cmiProblem,
  completesTraining,
  contentTypeOf,
  entryNameProblem,
  launchPathOf,
  nextAttemptStatus,
  sessionSeconds,
  xapiOutcome,
} from "./elearning";

/** The e-learning runtime's rules (workforce.md section 14; slice 43; ADR-0093). */

const entry = (name: string, o: Partial<ArchiveEntry> = {}): ArchiveEntry => ({
  name,
  compressedSize: 100,
  uncompressedSize: 300,
  method: 8,
  encrypted: false,
  symlink: false,
  ...o,
});

describe("WORK-006 an archive entry's name stays inside the package", () => {
  it.each([
    ["index.html", null],
    ["shared/scripts/app.js", null],
    ["assets/", null],
    ["", "empty"],
    ["/etc/passwd", "absolute"],
    ["../../evil.js", "traversal"],
    ["a/../../b.html", "traversal"],
    ["a/./b.html", "traversal"],
    ["a//b.html", "traversal"],
    ["a\\..\\b.html", "backslash"],
    ["C:/windows/x.js", "drive"],
    ["bad\u0000name.html", "control"],
    ["name\nnewline.html", "control"],
    // Review L6: C1 controls, separators, bidirectional overrides and isolates, non-NFC names.
    ["name\u0085x.html", "control"],
    ["name\u2028x.html", "control"],
    ["evil\u202Elmth.js", "control"],
    ["a\u2066b.html", "control"],
    ["cafe\u0301.html", "control"],
    ["caf\u00e9.html", null],
    ["trailing./x.html", "reserved"],
    ["x".repeat(ARCHIVE_LIMITS.maxPathLength + 1), "too_long"],
  ])("%j is %s", (name, problem) => {
    expect(entryNameProblem(name)).toBe(problem);
  });
});

describe("WORK-006 an archive is checked before anything is unpacked", () => {
  it("accepts a plain package", () => {
    expect(
      archiveProblem([entry("imsmanifest.xml"), entry("index.html"), entry("img/")]),
    ).toBeNull();
  });

  it.each([
    ["no entries", [], "empty"],
    ["path traversal", [entry("../x.html")], "entry_name"],
    [
      "a duplicate that differs only in case",
      [entry("Index.html"), entry("index.html")],
      "duplicate",
    ],
    ["a symbolic link", [entry("link.html", { symlink: true })], "symlink"],
    ["an encrypted entry", [entry("a.html", { encrypted: true })], "encrypted"],
    ["an unknown compression method", [entry("a.html", { method: 12 })], "method"],
    ["a server-side script", [entry("run.php")], "file_type"],
    ["an executable", [entry("setup.exe")], "file_type"],
    ["an archive inside", [entry("more.zip")], "file_type"],
    ["a file with no extension", [entry("README")], "file_type"],
    [
      "one entry far bigger than it packs",
      [entry("bomb.html", { compressedSize: 1000, uncompressedSize: 1000 * 101 })],
      "ratio",
    ],
    [
      "one entry over the size limit",
      [
        entry("big.mp4", {
          compressedSize: 200 * 1024 * 1024,
          uncompressedSize: 201 * 1024 * 1024,
        }),
      ],
      "too_large",
    ],
    [
      "too many entries",
      Array.from({ length: ARCHIVE_LIMITS.maxEntries + 1 }, (_, i) => entry(`f${i}.html`)),
      "too_many_entries",
    ],
  ])("refuses %s", (_name, entries, problem) => {
    expect(archiveProblem(entries as ArchiveEntry[])?.problem).toBe(problem);
  });

  it("refuses an archive that is too large altogether", () => {
    const each = 150 * 1024 * 1024;
    const entries = [0, 1, 2, 3].map((i) =>
      entry(`v${i}.mp4`, { compressedSize: each, uncompressedSize: each }),
    );
    expect(archiveProblem(entries)?.problem).toBe("too_large");
  });
});

describe("WORK-006 only allowlisted file types are served, each with its own type", () => {
  it.each([
    ["index.html", "text/html; charset=utf-8"],
    ["a/B.JS", "text/javascript; charset=utf-8"],
    ["media/clip.mp4", "video/mp4"],
    ["font.woff2", "font/woff2"],
    ["x.php", null],
    ["x.html.exe", null],
    [".htaccess", null],
    ["noext", null],
  ])("%s is %s", (path, type) => {
    expect(contentTypeOf(path)).toBe(type);
  });
});

describe("WORK-006 the launch page is an HTML file in the package", () => {
  const files = new Set(["index.html", "course/start.html", "course/app.js"]);
  it.each([
    ["index.html", "", { path: "index.html", query: "" }],
    ["start.html?lang=en", "course/", { path: "course/start.html", query: "lang=en" }],
    ["start%2Ehtml", "course/", { path: "course/start.html", query: "" }],
    ["https://evil.example.invalid/x.html", "", null],
    ["//evil.example.invalid/x.html", "", null],
    ["javascript:alert(1)", "", null],
    ["../index.html", "course/", null],
    ["app.js", "course/", null],
    ["missing.html", "", null],
  ])("%s under %j", (href, base, expected) => {
    expect(launchPathOf(href, base, files)).toEqual(expected);
  });
});

describe("WORK-006 the data model is read through an allowlist", () => {
  it.each([
    ["scorm_1_2", { "cmi.core.lesson_status": "passed", "cmi.core.score.raw": "80" }, null],
    ["scorm_1_2", { "cmi.core.lesson_status": "finished" }, "bad_value"],
    ["scorm_1_2", { "cmi.core.score.raw": "eighty" }, "bad_value"],
    ["scorm_1_2", { "cmi.core.student_name": "x" }, "unknown_element"],
    ["scorm_1_2", { "cmi.core.lesson_location": "x".repeat(256) }, "too_long"],
    ["scorm_2004", { "cmi.completion_status": "completed", "cmi.score.scaled": "0.9" }, null],
    ["scorm_2004", { "cmi.success_status": "maybe" }, "bad_value"],
    ["scorm_2004", { "cmi.suspend_data": "x".repeat(64001) }, "too_long"],
    ["scorm_2004", { "cmi.interactions.0.id": "q1" }, "unknown_element"],
  ] as const)("%s %j", (standard, values, problem) => {
    expect(cmiProblem(standard, values)?.problem ?? null).toBe(problem);
  });
});

describe("WORK-006 an attempt's outcome from what the content reported", () => {
  it.each([
    [
      "scorm_1_2",
      { "cmi.core.lesson_status": "passed", "cmi.core.score.raw": "80" },
      "passed",
      0.8,
    ],
    [
      "scorm_1_2",
      { "cmi.core.lesson_status": "failed", "cmi.core.score.raw": "3", "cmi.core.score.max": "10" },
      "failed",
      0.3,
    ],
    ["scorm_1_2", { "cmi.core.lesson_status": "completed" }, "completed", null],
    ["scorm_1_2", { "cmi.core.lesson_status": "incomplete" }, "in_progress", null],
    ["scorm_1_2", { "cmi.core.lesson_status": "browsed" }, "in_progress", null],
    ["scorm_1_2", { "cmi.core.score.raw": "150" }, "in_progress", 1],
    ["scorm_2004", { "cmi.success_status": "passed", "cmi.score.scaled": "0.95" }, "passed", 0.95],
    [
      "scorm_2004",
      { "cmi.success_status": "failed", "cmi.completion_status": "completed" },
      "failed",
      null,
    ],
    [
      "scorm_2004",
      { "cmi.success_status": "unknown", "cmi.completion_status": "completed" },
      "completed",
      null,
    ],
    [
      "scorm_2004",
      {
        "cmi.completion_status": "incomplete",
        "cmi.score.raw": "5",
        "cmi.score.min": "0",
        "cmi.score.max": "20",
      },
      "in_progress",
      0.25,
    ],
    ["scorm_2004", { "cmi.score.scaled": "-0.5" }, "in_progress", 0],
  ] as const)("%s %j is %s", (standard, cmi, status, score) => {
    expect(attemptOutcome(standard, cmi)).toEqual({ status, score });
  });

  it("completes training on a completion or a pass, never a fail", () => {
    expect(completesTraining("completed")).toBe(true);
    expect(completesTraining("passed")).toBe(true);
    expect(completesTraining("failed")).toBe(false);
    expect(completesTraining("in_progress")).toBe(false);
  });

  it("never undoes a settled completion", () => {
    expect(nextAttemptStatus("passed", "failed")).toBe("passed");
    expect(nextAttemptStatus("completed", "in_progress")).toBe("completed");
    // Review M1: a fail is final for that attempt; a retake is a new attempt.
    expect(nextAttemptStatus("failed", "passed")).toBe("failed");
    expect(nextAttemptStatus("failed", "completed")).toBe("failed");
    expect(nextAttemptStatus("in_progress", "failed")).toBe("failed");
  });
});

describe("WORK-006 session times and xAPI verbs", () => {
  it.each([
    ["0001:30:05.25", 5405],
    ["00:00:10", 10],
    ["PT1H2M3S", 3723],
    ["P1DT0.5S", 86400],
    ["PT", null],
    ["P", null],
    ["10 minutes", null],
    [undefined, null],
  ])("%j is %s seconds", (value, seconds) => {
    expect(sessionSeconds(value)).toBe(seconds);
  });

  it.each([
    ["http://adlnet.gov/expapi/verbs/passed", 0.7, { status: "passed", score: 0.7 }],
    ["http://adlnet.gov/expapi/verbs/completed", undefined, { status: "completed", score: null }],
    ["http://adlnet.gov/expapi/verbs/failed", 2, { status: "failed", score: 1 }],
    ["http://adlnet.gov/expapi/verbs/experienced", 0.5, null],
  ])("%s", (verb, scaled, outcome) => {
    expect(xapiOutcome(verb, scaled as number | undefined)).toEqual(outcome);
  });
});
