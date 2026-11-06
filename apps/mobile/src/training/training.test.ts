import { CMI_ELEMENTS } from "@harbour/domain";
import { describe, expect, it } from "vitest";
import { toTrainingUpload } from "../sync/training-upload";
import {
  mergeCommits,
  messageStatement,
  nextLocalAttempt,
  startStatement,
  statementsAllowed,
} from "./actions";
import {
  formatBytes,
  isInsideFolder,
  type OfflineManifest,
  parseManifest,
  STORAGE_RESERVE_BYTES,
  safeSegments,
  storageCheck,
} from "./offline-plan";
import {
  OFFLINE_CSP,
  OFFLINE_LRS,
  type OfflineRuntimeConfig,
  offlineLaunchQuery,
  offlineRuntimeMain,
  parseRuntimeMessage,
  type RuntimeWindow,
  withOfflinePolicy,
} from "./offline-runtime";
import { courseItems } from "./view";

/**
 * Training taken offline on the phone (workforce.md section 14.5; MOB-007, WORK-006; slice 72):
 * the storage check, safe paths, the queued rows and how they reach the API, the offline runtime
 * and the list. Invented ids only.
 */

const TENANT = "0199d000-0000-7000-8000-0000000000a1";
const COURSE = "0199d000-0000-7000-8000-000000000c01";
const ATTEMPT = "0199d000-0000-7000-8000-000000000c11";
const ROW = "0199d000-0000-7000-8000-000000000c21";
const SHA = "a".repeat(64);
const MB = 1024 * 1024;

const manifest = (overrides: Partial<OfflineManifest> = {}): OfflineManifest => ({
  courseId: COURSE,
  title: "Fire safety",
  standard: "scorm_1_2",
  launchPath: "index.html",
  launchQuery: "",
  packageSha256: SHA,
  files: [
    { path: "index.html", size: 1000 },
    { path: "assets/app.js", size: 2000 },
  ],
  totalBytes: 3000,
  ...overrides,
});

describe("the storage check before a download, in words", () => {
  it.each([
    ["room to spare", 10 * MB, 10 * MB + STORAGE_RESERVE_BYTES, true],
    ["not enough once the reserve is kept", 10 * MB, 10 * MB + STORAGE_RESERVE_BYTES - 1, false],
    ["an unknown amount free", 10 * MB, Number.NaN, false],
  ])("%s", (_case, total, free, ok) => {
    expect(storageCheck(total, free).ok).toBe(ok);
  });

  it("says what is needed and what is free", () => {
    const check = storageCheck(50 * MB, 120 * MB);
    expect(check).toEqual({
      ok: false,
      words:
        "This course needs 250 MB free on this phone, with room to spare, and the phone has 120 MB. Free some space, then try again.",
    });
  });

  it.each([
    [500, "1 KB"],
    [850 * 1024, "850 KB"],
    [12 * MB, "12 MB"],
    [1.25 * 1024 * MB, "1.3 GB"],
  ])("sizes %s bytes as %s", (bytes, words) => {
    expect(formatBytes(bytes)).toBe(words);
  });
});

describe("a package's files stay in the course's own folder", () => {
  it.each([
    ["index.html", ["index.html"]],
    ["assets/app.js", ["assets", "app.js"]],
    ["../escape.html", null],
    ["/root.html", null],
    ["a//b.html", null],
    ["a/./b.html", null],
    ["folder/", null],
    ["c:\\\\x.html", null],
    ["a\u0000b", null],
    ["x?y", null],
  ])("%s", (path, segments) => {
    expect(safeSegments(path)).toEqual(segments);
  });

  it("refuses a manifest that does not add up, or names an unsafe file", () => {
    expect(parseManifest(manifest())).not.toBeNull();
    expect(parseManifest(manifest({ totalBytes: 1 }))).toBeNull();
    expect(parseManifest(manifest({ launchPath: "missing.html" }))).toBeNull();
    expect(
      parseManifest(
        manifest({ files: [{ path: "../x.html", size: 3000 }], launchPath: "../x.html" }),
      ),
    ).toBeNull();
    expect(parseManifest(manifest({ packageSha256: "nope" }))).toBeNull();
  });
});

describe("what the phone queues reaches the API's own routes, once", () => {
  const entry = (statement: { params: (string | null)[] }) => {
    const [id, tenant, action, attempt, body] = statement.params;
    return {
      op: "PUT" as const,
      table: "elearning_outbox" as const,
      id: String(id),
      opData: { tenant_id: tenant, action, attempt_id: attempt, body },
    };
  };
  const at = new Date("2026-11-06T10:00:00.000Z");

  it("starts the attempt by the phone's id, with the package's hash", () => {
    const upload = toTrainingUpload(
      entry(startStatement({ attemptId: ATTEMPT, tenantId: TENANT, manifest: manifest(), at })),
    );
    expect(upload).toMatchObject({
      kind: "request",
      method: "PUT",
      path: `/v1/workforce/elearning/offline-attempts/${ATTEMPT}`,
      recordId: ATTEMPT,
      body: { courseId: COURSE, packageSha256: SHA },
    });
  });

  it("sends a SCORM commit as it was made", () => {
    const message = {
      type: "commit" as const,
      cmi: { "cmi.core.lesson_status": "passed" },
      finished: true,
    };
    const upload = toTrainingUpload(
      entry(
        messageStatement({
          id: ROW,
          attemptId: ATTEMPT,
          tenantId: TENANT,
          message,
          at,
          newId: () => ROW,
        }),
      ),
    );
    expect(upload).toMatchObject({
      method: "PATCH",
      path: `/v1/workforce/elearning/attempts/${ATTEMPT}`,
      body: { cmi: { "cmi.core.lesson_status": "passed" }, finished: true },
    });
  });

  it("gives every statement an id before it is queued, so a resend is kept once", () => {
    const given = "0199d000-0000-7000-8000-000000000c31";
    const message = {
      type: "statements" as const,
      statements: [{ verb: { id: "http://adlnet.gov/expapi/verbs/completed" } }],
    };
    const queued = messageStatement({
      id: ROW,
      attemptId: ATTEMPT,
      tenantId: TENANT,
      message,
      at,
      newId: () => given,
    });
    const upload = toTrainingUpload(entry(queued));
    expect(upload).toMatchObject({
      method: "POST",
      path: `/v1/workforce/elearning/attempts/${ATTEMPT}/statements`,
      body: [{ id: given, verb: { id: "http://adlnet.gov/expapi/verbs/completed" } }],
    });
  });

  it.each([
    ["an update", { op: "PATCH" as const }],
    ["a start whose row is not the attempt", { id: ROW }],
    ["no tenant", { opData: { tenant_id: null } }],
    ["an unknown action", { opData: { action: "delete" } }],
    [
      "a statement without an id",
      { opData: { action: "statements", body: JSON.stringify([{ verb: {} }]) } },
    ],
  ])("refuses, in words, %s", (_case, change) => {
    const base = entry(
      startStatement({ attemptId: ATTEMPT, tenantId: TENANT, manifest: manifest(), at }),
    );
    const upload = toTrainingUpload({
      ...base,
      ...("op" in change ? { op: change.op } : {}),
      ...("id" in change ? { id: change.id } : {}),
      opData: { ...base.opData, ...("opData" in change ? change.opData : {}) },
    } as never);
    expect(upload).toMatchObject({ kind: "refused", code: "training_change_unreadable" });
  });
});

describe("the phone's record of an attempt follows the server's rules", () => {
  const attempt = {
    attemptId: ATTEMPT,
    courseId: COURSE,
    status: "in_progress" as const,
    location: null,
    suspendData: null,
  };

  it("keeps where to resume and moves the status only forward", () => {
    const passed = nextLocalAttempt(attempt, "scorm_1_2", {
      type: "commit",
      cmi: { "cmi.core.lesson_status": "passed", "cmi.core.lesson_location": "page-4" },
      finished: true,
    });
    expect(passed).toMatchObject({ status: "passed", location: "page-4" });
    const after = nextLocalAttempt(passed, "scorm_1_2", {
      type: "commit",
      cmi: { "cmi.core.lesson_status": "incomplete" },
      finished: false,
    });
    expect(after.status).toBe("passed");
  });

  it("settles an xAPI attempt from a completed statement", () => {
    expect(
      nextLocalAttempt(attempt, "xapi", {
        type: "statements",
        statements: [{ verb: { id: "http://adlnet.gov/expapi/verbs/completed" } }],
      }).status,
    ).toBe("completed");
  });
});

function runtime(config: Partial<OfflineRuntimeConfig> = {}) {
  const sent: Record<string, unknown>[] = [];
  const network: string[] = [];
  const win: RuntimeWindow = {
    ReactNativeWebView: { postMessage: (m: string) => void sent.push(JSON.parse(m)) },
    fetch: (url: unknown) => {
      network.push(String(url));
      return Promise.resolve({ ok: true });
    },
  };
  offlineRuntimeMain(win, {
    standard: "scorm_1_2",
    entry: "ab-initio",
    location: null,
    suspendData: null,
    learnerId: ATTEMPT,
    learnerName: "Ada",
    ...config,
  });
  return { win, sent, network };
}

type Api = Record<string, ((...a: unknown[]) => string) | undefined>;

describe("the offline runtime", () => {
  it("sends exactly the elements the API keeps, within their lengths", () => {
    for (const standard of ["scorm_1_2", "scorm_2004"] as const) {
      const h = runtime({ standard });
      const api = (standard === "scorm_1_2" ? h.win.API : h.win.API_1484_11) as Api;
      (api.LMSInitialize ?? api.Initialize)?.("");
      const set = api.LMSSetValue ?? api.SetValue;
      const elements = CMI_ELEMENTS[standard];
      for (const [element, max] of Object.entries(elements)) set?.(element, "x".repeat(max));
      set?.("cmi.comments", "not kept");
      (api.LMSCommit ?? api.Commit)?.("");
      const commit = h.sent.at(-1) as { type: string; cmi: Record<string, string> };
      expect(commit.type).toBe("commit");
      expect(Object.keys(commit.cmi).sort()).toEqual(Object.keys(elements).sort());
    }
  });

  it("tells the course the attempt's id and the first name only, and resumes where it left off", () => {
    const h = runtime({ entry: "resume", location: "page-3", suspendData: "s" });
    const api = h.win.API as Api;
    api.LMSInitialize?.("");
    expect(api.LMSGetValue?.("cmi.core.student_id")).toBe(ATTEMPT);
    expect(api.LMSGetValue?.("cmi.core.student_name")).toBe("Ada");
    expect(api.LMSGetValue?.("cmi.core.lesson_location")).toBe("page-3");
    expect(api.LMSGetValue?.("cmi.core.entry")).toBe("resume");
    expect(api.LMSSetValue?.("cmi.core.student_id", "x")).toBe("false");
  });

  it("keeps an xAPI course's statements on the phone and never lets it reach the network", async () => {
    const h = runtime({ standard: "xapi" });
    const fetch = h.win.fetch as (u: string, i?: unknown) => Promise<{ status: number }>;
    const answer = await fetch(`${OFFLINE_LRS}statements`, {
      method: "POST",
      body: JSON.stringify({ id: "s1", verb: { id: "http://adlnet.gov/expapi/verbs/completed" } }),
    });
    expect(answer.status).toBe(200);
    expect(h.sent).toEqual([
      {
        protocol: "harbour.elearning.offline.v1",
        type: "statements",
        statements: [{ id: "s1", verb: { id: "http://adlnet.gov/expapi/verbs/completed" } }],
      },
    ]);
    await expect(fetch("https://tracker.example.invalid/pixel")).rejects.toThrow("Offline");
    expect(h.network).toEqual([]);
  });

  it("points an xAPI course at the offline record store, naming the attempt, never the person", () => {
    const query = new URLSearchParams(offlineLaunchQuery("xapi", "a=1", ATTEMPT).slice(1));
    expect(query.get("endpoint")).toBe(OFFLINE_LRS);
    expect(query.get("a")).toBe("1");
    expect(JSON.parse(query.get("actor") ?? "{}").account.name).toBe(ATTEMPT);
    expect(offlineLaunchQuery("scorm_1_2", "", ATTEMPT)).toBe("");
  });

  it("reads only its own messages from the WebView", () => {
    expect(
      parseRuntimeMessage(
        JSON.stringify({
          protocol: "harbour.elearning.offline.v1",
          type: "commit",
          cmi: {},
          finished: false,
        }),
      ),
    ).toEqual({ type: "commit", cmi: {}, finished: false });
    expect(
      parseRuntimeMessage(JSON.stringify({ type: "commit", cmi: {}, finished: false })),
    ).toBeNull();
    expect(parseRuntimeMessage("not json")).toBeNull();
    expect(
      parseRuntimeMessage(
        JSON.stringify({
          protocol: "harbour.elearning.offline.v1",
          type: "commit",
          cmi: { a: 1 },
          finished: false,
        }),
      ),
    ).toBeNull();
  });
});

describe("the training list says what each course is on this phone", () => {
  const kept = { manifest: manifest(), downloadedAt: "2026-11-06T09:00:00.000Z" };
  const attempt = (status: "in_progress" | "completed") => ({
    attemptId: ATTEMPT,
    courseId: COURSE,
    status,
    location: null,
    suspendData: null,
  });

  it.each([
    ["offered online, not downloaded", [], [], new Set<string>(), "Not on this phone", true, false],
    ["downloaded", [kept], [], new Set<string>(), "On this phone", false, true],
    [
      "finished, waiting to send",
      [kept],
      [attempt("completed")],
      new Set([ATTEMPT]),
      "Finished on this phone, waiting to send",
      false,
      false,
    ],
    [
      "finished and sent",
      [kept],
      [attempt("completed")],
      new Set<string>(),
      "Finished",
      false,
      false,
    ],
  ] as const)("%s", (_case, downloaded, attempts, waiting, words, canDownload, canOpen) => {
    const [item] = courseItems({
      online: [{ id: COURSE, title: "Fire safety", status: "active" }],
      downloaded,
      attempts,
      waitingAttemptIds: waiting,
      downloading: null,
    });
    expect(item).toMatchObject({ stateWords: words, canDownload, canOpen });
  });

  it("shows the courses on the phone when there is no connection, and offers no download", () => {
    const items = courseItems({
      online: null,
      downloaded: [kept],
      attempts: [],
      waitingAttemptIds: new Set(),
      downloading: null,
    });
    expect(items).toMatchObject([
      { courseId: COURSE, canDownload: false, canOpen: true, size: "3 KB" },
    ]);
  });
});

describe("the security review of slice 72", () => {
  it("puts a policy on the page that lets nothing reach the network, and stops beacons and sockets", () => {
    const appended: Record<string, unknown>[] = [];
    const win: RuntimeWindow = {
      document: {
        head: { appendChild: (n: unknown) => appended.push(n as Record<string, unknown>) },
        documentElement: null,
        createElement: () => ({}),
      },
      navigator: {},
    };
    offlineRuntimeMain(win, {
      standard: "scorm_1_2",
      entry: "ab-initio",
      location: null,
      suspendData: null,
      learnerId: ATTEMPT,
      learnerName: "Ada",
    });
    expect(appended[0]).toEqual({ httpEquiv: "Content-Security-Policy", content: OFFLINE_CSP });
    expect(OFFLINE_CSP).toContain("connect-src 'none'");
    const beacon = win.navigator?.sendBeacon as (() => boolean) | undefined;
    expect(beacon?.()).toBe(false);
    expect(() => new (win.WebSocket as new () => unknown)()).toThrow("Offline");
  });

  it("merges held-back commits, the newer elements on top", () => {
    const first = { type: "commit" as const, cmi: { a: "1", b: "1" }, finished: false };
    const second = { type: "commit" as const, cmi: { b: "2" }, finished: true };
    expect(mergeCommits(null, first)).toEqual(first);
    expect(mergeCommits(first, second)).toEqual({
      type: "commit",
      cmi: { a: "1", b: "2" },
      finished: true,
    });
  });

  it("never queues more statements for an attempt than the server keeps", () => {
    const attempt = {
      attemptId: ATTEMPT,
      courseId: COURSE,
      status: "in_progress" as const,
      location: null,
      suspendData: null,
    };
    expect(statementsAllowed({ ...attempt, statementsQueued: 4950 }, 50)).toBe(true);
    expect(statementsAllowed({ ...attempt, statementsQueued: 4951 }, 50)).toBe(false);
  });

  it.each([
    ["file:///data/app/elearning/t/c/index.html", true],
    ["file:///data/app/elearning/t/c/a/b.png", true],
    ["file:///data/app/elearning/t/c", false],
    ["file:///data/app/elearning/t/c-other/index.html", false],
    ["file:///data/app/elearning/t/c/../other/index.html", false],
    ["file:///data/app/elearning/t/c/%2e%2e/other/x.html", false],
    ["https://tracker.example.invalid/", false],
  ])("opens %s inside the course's folder: %s", (url, inside) => {
    expect(isInsideFolder(url, "file:///data/app/elearning/t/c")).toBe(inside);
  });
});

describe("the security re-check of slice 72", () => {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${OFFLINE_CSP}">`;

  it.each([
    [
      "a head",
      "<html><head><title>x</title></head></html>",
      `<html><head>${meta}<title>x</title></head></html>`,
    ],
    [
      "a head with attributes",
      '<HEAD lang="en"><script src="a.js"></script>',
      `<HEAD lang="en">${meta}<script src="a.js"></script>`,
    ],
    ["no head", "<html><body>x</body></html>", `<html><head>${meta}</head><body>x</body></html>`],
    ["neither", "<p>x</p>", `<head>${meta}</head><p>x</p>`],
    [
      "a head hidden in a comment first",
      "<!--<head>--><html><head></head></html>",
      `<!--<head>--><html><head>${meta}</head></html>`,
    ],
  ])("writes the offline policy first into a page with %s", (_case, html, kept) => {
    expect(withOfflinePolicy(html)).toBe(kept);
  });

  it("refuses, from the bridge, an element the API does not keep, or a value past its length", () => {
    const commit = (cmi: Record<string, string>) =>
      parseRuntimeMessage(
        JSON.stringify({
          protocol: "harbour.elearning.offline.v1",
          type: "commit",
          cmi,
          finished: false,
        }),
      );
    expect(commit({ "cmi.core.lesson_status": "passed" })).not.toBeNull();
    expect(commit({ "cmi.comments": "x" })).toBeNull();
    expect(commit({ "cmi.core.lesson_location": "x".repeat(256) })).toBeNull();
  });

  it("refuses, from the bridge, a statement over 16 KB", () => {
    const big = {
      id: "s1",
      verb: { id: "http://adlnet.gov/expapi/verbs/completed" },
      pad: "x".repeat(17 * 1024),
    };
    expect(
      parseRuntimeMessage(
        JSON.stringify({
          protocol: "harbour.elearning.offline.v1",
          type: "statements",
          statements: [big],
        }),
      ),
    ).toBeNull();
  });
});
