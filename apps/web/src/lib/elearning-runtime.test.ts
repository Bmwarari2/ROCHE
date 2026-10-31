import { CMI_ELEMENTS } from "@harbour/domain";
import { describe, expect, it } from "vitest";
import { RUNTIME_SOURCE, runtimeMain } from "./elearning-runtime";

/**
 * Harbour's runtime on the content origin (ADR-0093): it offers the SCORM APIs only after the app
 * starts it, listens only to the app's window from the app's origin, refuses read-only elements,
 * and sends the app only the elements Harbour keeps.
 */

const APP = "https://app.example.invalid";
const ATTEMPT = "0199f300-0000-7000-8000-0000000000a1";
const LEARNER = "0199f300-0000-7000-8000-0000000000c1";

function harness() {
  const sent: unknown[] = [];
  const parent = { postMessage: (m: unknown, origin: string) => sent.push({ m, origin }) };
  let listener: ((e: { origin: string; source: unknown; data: unknown }) => void) | null = null;
  const win: Record<string, unknown> = {
    parent,
    location: { href: "https://learn.example.invalid/learn/tok.sig/" },
    addEventListener: (_: string, fn: typeof listener) => {
      listener = fn;
    },
  };
  const frame = { src: "" };
  runtimeMain(win as never, { frame, appOrigin: APP, attemptId: ATTEMPT, base: "/learn/tok.sig" });
  const deliver = (data: unknown, origin = APP, source: unknown = parent) =>
    listener?.({ origin, source, data });
  const start = (o: Record<string, unknown> = {}) =>
    deliver({
      protocol: "harbour.elearning.v1",
      type: "start",
      attemptId: ATTEMPT,
      standard: "scorm_1_2",
      launchPath: "course/index.html",
      launchQuery: "lang=en",
      location: null,
      suspendData: null,
      entry: "ab-initio",
      learnerId: LEARNER,
      learnerName: "Ada Example",
      ...o,
    });
  return { win, frame, sent, deliver, start };
}

type Api12 = Record<string, (...a: unknown[]) => string>;

describe("WORK-006 the runtime", () => {
  it("sends exactly the elements the API keeps, within their lengths", () => {
    for (const standard of ["scorm_1_2", "scorm_2004"] as const) {
      const h = harness();
      h.start({ standard });
      const api = (standard === "scorm_1_2" ? h.win.API : h.win.API_1484_11) as Api12;
      (api.LMSInitialize ?? api.Initialize)?.("");
      const set = api.LMSSetValue ?? api.SetValue;
      const elements = CMI_ELEMENTS[standard];
      for (const [element, max] of Object.entries(elements)) set?.(element, "x".repeat(max));
      set?.("cmi.comments", "not kept");
      (api.LMSCommit ?? api.Commit)?.("");
      const commit = (h.sent.at(-1) as { m: { cmi: Record<string, string> } }).m;
      expect(Object.keys(commit.cmi).sort()).toEqual(Object.keys(elements).sort());
      const over = harness();
      over.start({ standard });
      const overApi = (standard === "scorm_1_2" ? over.win.API : over.win.API_1484_11) as Api12;
      (overApi.LMSInitialize ?? overApi.Initialize)?.("");
      const location = standard === "scorm_1_2" ? "cmi.core.lesson_location" : "cmi.location";
      (overApi.LMSSetValue ?? overApi.SetValue)?.(
        location,
        "x".repeat((elements[location] ?? 0) + 1),
      );
      (overApi.LMSCommit ?? overApi.Commit)?.("");
      expect((over.sent.at(-1) as { m: { cmi: Record<string, string> } }).m.cmi).toEqual({});
    }
    expect(RUNTIME_SOURCE).toContain("document.currentScript");
  });

  it("says it is ready to the app's origin only, and starts only from the app's window", () => {
    const h = harness();
    expect(h.sent).toEqual([
      { m: { protocol: "harbour.elearning.v1", attemptId: ATTEMPT, type: "ready" }, origin: APP },
    ]);
    const api = h.win.API as Api12;
    expect(api.LMSInitialize?.("")).toBe("false");
    h.start({});
    h.deliver({ protocol: "harbour.elearning.v1", type: "start" }, "https://evil.example.invalid");
    expect(h.frame.src).toBe("/learn/tok.sig/c/course/index.html?lang=en");
  });

  it.each([
    ["another origin", { origin: "https://evil.example.invalid" }],
    ["another window", { source: {} }],
  ])("ignores a start from %s", (_name, where) => {
    const h = harness();
    h.deliver(
      {
        protocol: "harbour.elearning.v1",
        type: "start",
        attemptId: ATTEMPT,
        standard: "scorm_1_2",
        launchPath: "index.html",
        launchQuery: "",
        location: null,
        suspendData: null,
        entry: "ab-initio",
        learnerId: LEARNER,
        learnerName: "Ada Example",
      },
      (where as { origin?: string }).origin ?? APP,
      (where as { source?: unknown }).source ?? h.win.parent,
    );
    expect(h.frame.src).toBe("");
  });

  it.each([
    ["../escape.html"],
    ["/abs.html"],
    ["https://evil.example.invalid/x.html"],
    ["a//b.html"],
  ])("refuses to launch %s", (launchPath) => {
    const h = harness();
    h.start({ launchPath });
    expect(h.frame.src).toBe("");
  });

  it("runs SCORM 1.2: read-only elements refused, only kept elements committed", () => {
    const h = harness();
    h.start({ entry: "resume", location: "p3", suspendData: "s" });
    const api = h.win.API as Api12;
    expect(api.LMSInitialize?.("")).toBe("true");
    expect(api.LMSGetValue?.("cmi.core.student_name")).toBe("Ada Example");
    expect(api.LMSGetValue?.("cmi.core.entry")).toBe("resume");
    expect(api.LMSGetValue?.("cmi.core.lesson_location")).toBe("p3");
    expect(api.LMSSetValue?.("cmi.core.student_name", "x")).toBe("false");
    expect(api.LMSGetLastError?.()).toBe("403");
    expect(api.LMSSetValue?.("cmi.core.lesson_status", "passed")).toBe("true");
    expect(api.LMSSetValue?.("cmi.core.score.raw", "90")).toBe("true");
    expect(api.LMSSetValue?.("cmi.interactions.0.id", "q1")).toBe("true");
    expect(api.LMSFinish?.("")).toBe("true");
    const commit = (
      h.sent.at(-1) as { m: { type: string; cmi: Record<string, string>; finished: boolean } }
    ).m;
    expect(commit).toMatchObject({
      type: "commit",
      finished: true,
      cmi: { "cmi.core.lesson_status": "passed", "cmi.core.score.raw": "90" },
    });
    expect(commit.cmi).not.toHaveProperty("cmi.interactions.0.id");
    expect(api.LMSSetValue?.("cmi.core.lesson_status", "failed")).toBe("false");
  });

  it("runs SCORM 2004 and gives xAPI content an endpoint for this launch only", () => {
    const h = harness();
    h.start({ standard: "scorm_2004" });
    const api = h.win.API_1484_11 as Api12;
    expect(api.Initialize?.("")).toBe("true");
    expect(api.GetValue?.("cmi.learner_id")).toBe(LEARNER);
    expect(api.SetValue?.("cmi.completion_status", "completed")).toBe("true");
    expect(api.Commit?.("")).toBe("true");
    const x = harness();
    x.start({ standard: "xapi", launchPath: "story.html", launchQuery: "" });
    const url = new URL(x.frame.src, "https://learn.example.invalid/learn/tok.sig/");
    expect(url.pathname).toBe("/learn/tok.sig/c/story.html");
    expect(url.searchParams.get("endpoint")).toBe(
      "https://learn.example.invalid/learn/tok.sig/xapi/",
    );
    expect(url.searchParams.get("actor")).toContain(ATTEMPT);
    expect(url.searchParams.get("actor")).not.toContain("Ada");
  });
});
