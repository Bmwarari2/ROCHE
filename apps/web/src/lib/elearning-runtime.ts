/**
 * Harbour's e-learning runtime (ADR-0093): the script of the runtime page on the content origin.
 * It offers the SCORM 1.2 (`window.API`) and SCORM 2004 (`window.API_1484_11`) APIs to the
 * package, which runs in the frame below it on the same (content) origin, keeps the data model in
 * memory, and sends the app only what Harbour keeps (`CMI_ELEMENTS` in packages/domain, the same
 * list here, checked by a test) when the package commits or finishes. It talks to the app only by
 * postMessage, to the app's configured origin, in the protocol's shape, and listens only to the
 * app's window (its parent) from that origin.
 *
 * `runtimeMain` must stay self-contained (no imports, no outer variables): its source is what the
 * content origin serves (`RUNTIME_SOURCE`).
 */

export interface RuntimeWindow {
  readonly parent: { postMessage(message: unknown, targetOrigin: string): void };
  addEventListener(
    type: "message",
    listener: (event: { origin: string; source: unknown; data: unknown }) => void,
  ): void;
  readonly location?: { readonly href: string };
  API?: unknown;
  API_1484_11?: unknown;
}

export interface RuntimeDocument {
  readonly frame: { src: string };
  readonly appOrigin: string;
  readonly attemptId: string;
  /** `/learn/{token}` on the content origin. */
  readonly base: string;
}

export function runtimeMain(win: RuntimeWindow, doc: RuntimeDocument): void {
  const PROTOCOL = "harbour.elearning.v1";
  const KEPT: Record<string, Record<string, number>> = {
    scorm_1_2: {
      "cmi.core.lesson_status": 20,
      "cmi.core.lesson_location": 255,
      "cmi.core.score.raw": 20,
      "cmi.core.score.min": 20,
      "cmi.core.score.max": 20,
      "cmi.core.session_time": 20,
      "cmi.core.exit": 20,
      "cmi.suspend_data": 64000,
    },
    scorm_2004: {
      "cmi.completion_status": 20,
      "cmi.success_status": 20,
      "cmi.location": 1000,
      "cmi.score.scaled": 20,
      "cmi.score.raw": 20,
      "cmi.score.min": 20,
      "cmi.score.max": 20,
      "cmi.progress_measure": 20,
      "cmi.session_time": 40,
      "cmi.exit": 20,
      "cmi.suspend_data": 64000,
    },
  };
  const READ_ONLY = new Set([
    "cmi.core.student_id",
    "cmi.core.student_name",
    "cmi.core.entry",
    "cmi.core.credit",
    "cmi.core.lesson_mode",
    "cmi.core.total_time",
    "cmi.launch_data",
    "cmi.learner_id",
    "cmi.learner_name",
    "cmi.entry",
    "cmi.credit",
    "cmi.mode",
    "cmi.total_time",
  ]);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const MAX_VALUE = 64000;
  const MAX_ELEMENTS = 2000;

  let started = false;
  let standard = "";
  let initialised = false;
  let finished = false;
  let lastError = "0";
  const values = new Map<string, string>();
  const dirty = new Set<string>();

  const send = (message: Record<string, unknown>) =>
    win.parent.postMessage(
      { protocol: PROTOCOL, attemptId: doc.attemptId, ...message },
      doc.appOrigin,
    );

  const commit = (finishing: boolean) => {
    const kept = KEPT[standard] ?? {};
    const cmi: Record<string, string> = {};
    for (const key of dirty) {
      const max = kept[key];
      const value = values.get(key);
      if (max !== undefined && value !== undefined && value.length <= max) cmi[key] = value;
    }
    dirty.clear();
    send({ type: "commit", cmi, finished: finishing });
  };

  const getValue = (element: unknown): string => {
    lastError = "0";
    if (!initialised) {
      lastError = standard === "scorm_2004" ? "122" : "301";
      return "";
    }
    const key = String(element);
    if (key.endsWith("._count")) return "0";
    const value = values.get(key);
    if (value === undefined) {
      lastError = standard === "scorm_2004" ? "403" : "201";
      return "";
    }
    return value;
  };

  const setValue = (element: unknown, value: unknown): string => {
    lastError = "0";
    if (!initialised || finished) {
      lastError = standard === "scorm_2004" ? "132" : "301";
      return "false";
    }
    const key = String(element);
    const text = String(value);
    if (READ_ONLY.has(key)) {
      lastError = standard === "scorm_2004" ? "404" : "403";
      return "false";
    }
    if (
      !key.startsWith("cmi.") ||
      text.length > MAX_VALUE ||
      (values.size >= MAX_ELEMENTS && !values.has(key))
    ) {
      lastError = standard === "scorm_2004" ? "351" : "405";
      return "false";
    }
    values.set(key, text);
    dirty.add(key);
    return "true";
  };

  const errorString = (code: unknown) => (String(code) === "0" ? "No error" : "Error");

  win.API = {
    LMSInitialize: () => {
      if (!started || initialised) return "false";
      initialised = true;
      return "true";
    },
    LMSFinish: () => {
      if (!initialised || finished) return "false";
      commit(true);
      finished = true;
      return "true";
    },
    LMSGetValue: getValue,
    LMSSetValue: setValue,
    LMSCommit: () => {
      if (!initialised || finished) return "false";
      commit(false);
      return "true";
    },
    LMSGetLastError: () => lastError,
    LMSGetErrorString: errorString,
    LMSGetDiagnostic: errorString,
  };
  win.API_1484_11 = {
    Initialize: () => {
      if (!started || initialised) return "false";
      initialised = true;
      return "true";
    },
    Terminate: () => {
      if (!initialised || finished) return "false";
      commit(true);
      finished = true;
      return "true";
    },
    GetValue: getValue,
    SetValue: setValue,
    Commit: () => {
      if (!initialised || finished) return "false";
      commit(false);
      return "true";
    },
    GetLastError: () => lastError,
    GetErrorString: errorString,
    GetDiagnostic: errorString,
  };

  const str = (v: unknown, max: number) => typeof v === "string" && v.length <= max;

  win.addEventListener("message", (event) => {
    if (event.origin !== doc.appOrigin || event.source !== win.parent) return;
    const m = event.data as Record<string, unknown> | null;
    if (!m || typeof m !== "object" || m.protocol !== PROTOCOL || m.attemptId !== doc.attemptId)
      return;
    if (m.type !== "start" || started) return;
    const ok =
      (m.standard === "scorm_1_2" || m.standard === "scorm_2004" || m.standard === "xapi") &&
      str(m.launchPath, 240) &&
      str(m.launchQuery, 500) &&
      (m.location === null || str(m.location, 1000)) &&
      (m.suspendData === null || str(m.suspendData, 64000)) &&
      (m.entry === "ab-initio" || m.entry === "resume") &&
      typeof m.learnerId === "string" &&
      UUID.test(m.learnerId) &&
      str(m.learnerName, 200);
    if (!ok) return;
    const path = String(m.launchPath);
    const segments = path.split("/");
    if (
      path.startsWith("/") ||
      segments.some((s) => s === "" || s === "." || s === "..") ||
      /[\\?#:]/.test(path)
    ) {
      return;
    }
    started = true;
    standard = String(m.standard);
    const resume = m.entry === "resume";
    if (standard === "scorm_1_2") {
      values.set("cmi.core.student_id", String(m.learnerId));
      values.set("cmi.core.student_name", String(m.learnerName));
      values.set("cmi.core.lesson_location", m.location === null ? "" : String(m.location));
      values.set("cmi.core.lesson_status", resume ? "incomplete" : "not attempted");
      values.set("cmi.core.entry", resume ? "resume" : "ab-initio");
      values.set("cmi.core.credit", "credit");
      values.set("cmi.core.lesson_mode", "normal");
      values.set("cmi.core.total_time", "0000:00:00");
      values.set("cmi.core.score.raw", "");
      values.set("cmi.launch_data", "");
      values.set("cmi.suspend_data", m.suspendData === null ? "" : String(m.suspendData));
    } else if (standard === "scorm_2004") {
      values.set("cmi.learner_id", String(m.learnerId));
      values.set("cmi.learner_name", String(m.learnerName));
      values.set("cmi.location", m.location === null ? "" : String(m.location));
      values.set("cmi.completion_status", resume ? "incomplete" : "not attempted");
      values.set("cmi.success_status", "unknown");
      values.set("cmi.entry", resume ? "resume" : "ab-initio");
      values.set("cmi.credit", "credit");
      values.set("cmi.mode", "normal");
      values.set("cmi.total_time", "PT0S");
      values.set("cmi.suspend_data", m.suspendData === null ? "" : String(m.suspendData));
    }
    const encoded = segments.map((s) => encodeURIComponent(s)).join("/");
    let query = "";
    if (standard === "xapi") {
      // xAPI content sends statements to the content origin's endpoint for this launch only; the
      // actor names the attempt, never the person.
      const base = new URL(`${doc.base}/xapi/`, String(win.location?.href ?? "")).href;
      const params = new URLSearchParams(String(m.launchQuery));
      params.set("endpoint", base);
      params.set("auth", "Basic aGFyYm91cjpsYXVuY2g=");
      params.set(
        "actor",
        JSON.stringify({
          objectType: "Agent",
          account: { homePage: doc.appOrigin, name: doc.attemptId },
        }),
      );
      params.set("registration", doc.attemptId);
      query = `?${params.toString()}`;
    } else if (m.launchQuery) {
      query = `?${String(m.launchQuery)}`;
    }
    doc.frame.src = `${doc.base}/c/${encoded}${query}`;
  });

  send({ type: "ready" });
}

/** What the content origin serves as `_harbour/runtime.js`. */
export const RUNTIME_SOURCE = `(${runtimeMain.toString()})(window, (function () {
  var script = document.currentScript;
  return {
    frame: document.getElementById("content"),
    appOrigin: script.getAttribute("data-app"),
    attemptId: script.getAttribute("data-attempt"),
    base: script.getAttribute("data-base")
  };
})());`;
