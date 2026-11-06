/**
 * The runtime a course runs against on the phone, offline (workforce.md section 14.5; mobile slice
 * 72). Injected into the WebView before the package's launch page loads, it offers the SCORM 1.2
 * (`window.API`) and SCORM 2004 (`window.API_1484_11`) APIs and answers an xAPI course's requests
 * to its learning record store, which the launch query points at an address that never leaves the
 * phone (`OFFLINE_LRS`). It keeps the data model in memory and tells the app only what Harbour
 * keeps (the same lists as `CMI_ELEMENTS` in packages/domain, checked by a test) when the course
 * commits or finishes, and the statements it makes, through `ReactNativeWebView.postMessage`.
 *
 * `offlineRuntimeMain` must stay self-contained (no imports, no outer variables): its source is
 * what the WebView runs (`offlineRuntimeSource`).
 */

import { CMI_ELEMENTS, XAPI_STATEMENT_MAX_BYTES } from "@harbour/domain";

/** Where an offline xAPI course sends its statements: caught on the phone, never fetched. */
export const OFFLINE_LRS = "https://lrs.offline.invalid/xapi/";
export const RUNTIME_PROTOCOL = "harbour.elearning.offline.v1";

export interface OfflineRuntimeConfig {
  readonly standard: "scorm_1_2" | "scorm_2004" | "xapi";
  readonly entry: "ab-initio" | "resume";
  readonly location: string | null;
  readonly suspendData: string | null;
  /** The attempt's id: the learner as the course sees them, never the person's own id. */
  readonly learnerId: string;
  /** The member's first name only. */
  readonly learnerName: string;
}

/**
 * The content security policy the runtime puts on the launch page before anything loads: the
 * package's own files on the phone and inline code only, nothing from the network, no forms
 * posted anywhere (security review of slice 72, M1). A platform-level block is H-1366.
 */
export const OFFLINE_CSP =
  "default-src file: data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'";

export interface RuntimeWindow {
  ReactNativeWebView?: { postMessage(message: string): void };
  document?: {
    readonly head: { appendChild(node: unknown): unknown } | null;
    readonly documentElement: { appendChild(node: unknown): unknown } | null;
    createElement(tag: string): Record<string, unknown>;
  };
  navigator?: Record<string, unknown>;
  WebSocket?: unknown;
  EventSource?: unknown;
  API?: unknown;
  API_1484_11?: unknown;
  fetch?: unknown;
  XMLHttpRequest?: unknown;
}

export function offlineRuntimeMain(win: RuntimeWindow, config: OfflineRuntimeConfig): void {
  const PROTOCOL = "harbour.elearning.offline.v1";
  const LRS = "https://lrs.offline.invalid/xapi/";
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
  const MAX_VALUE = 64000;
  const MAX_ELEMENTS = 2000;
  const standard = config.standard;

  // Nothing leaves the phone: a policy on the page first, then the ways round it stopped.
  try {
    const doc = win.document;
    const meta = doc?.createElement("meta");
    if (doc && meta) {
      meta.httpEquiv = "Content-Security-Policy";
      meta.content =
        "default-src file: data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'";
      (doc.head ?? doc.documentElement)?.appendChild(meta);
    }
  } catch {
    // The interceptions below still apply.
  }
  if (win.navigator) win.navigator.sendBeacon = () => false;
  const refuse = function Offline() {
    throw new Error("Offline");
  };
  win.WebSocket = refuse;
  win.EventSource = refuse;
  const resume = config.entry === "resume";

  const send = (message: Record<string, unknown>) => {
    const bridge = win.ReactNativeWebView;
    if (bridge) bridge.postMessage(JSON.stringify({ protocol: PROTOCOL, ...message }));
  };

  let initialised = false;
  let finished = false;
  let lastError = "0";
  const values = new Map<string, string>();
  const dirty = new Set<string>();

  if (standard === "scorm_1_2") {
    values.set("cmi.core.student_id", config.learnerId);
    values.set("cmi.core.student_name", config.learnerName);
    values.set("cmi.core.lesson_location", config.location ?? "");
    values.set("cmi.core.lesson_status", resume ? "incomplete" : "not attempted");
    values.set("cmi.core.entry", resume ? "resume" : "ab-initio");
    values.set("cmi.core.credit", "credit");
    values.set("cmi.core.lesson_mode", "normal");
    values.set("cmi.core.total_time", "0000:00:00");
    values.set("cmi.core.score.raw", "");
    values.set("cmi.launch_data", "");
    values.set("cmi.suspend_data", config.suspendData ?? "");
  } else if (standard === "scorm_2004") {
    values.set("cmi.learner_id", config.learnerId);
    values.set("cmi.learner_name", config.learnerName);
    values.set("cmi.location", config.location ?? "");
    values.set("cmi.completion_status", resume ? "incomplete" : "not attempted");
    values.set("cmi.success_status", "unknown");
    values.set("cmi.entry", resume ? "resume" : "ab-initio");
    values.set("cmi.credit", "credit");
    values.set("cmi.mode", "normal");
    values.set("cmi.total_time", "PT0S");
    values.set("cmi.suspend_data", config.suspendData ?? "");
  }

  // Each commit is saved on the phone at once: there is no server to spare here.
  const commit = (finishing: boolean) => {
    const kept = KEPT[standard] ?? {};
    const cmi: Record<string, string> = {};
    for (const key of dirty) {
      const max = kept[key];
      const value = values.get(key);
      if (max !== undefined && value !== undefined && value.length <= max) cmi[key] = value;
    }
    dirty.clear();
    if (Object.keys(cmi).length === 0 && !finishing) return;
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
  const initialise = () => {
    if (initialised) return "false";
    initialised = true;
    return "true";
  };
  const terminate = () => {
    if (!initialised || finished) return "false";
    commit(true);
    finished = true;
    return "true";
  };
  const save = () => {
    if (!initialised || finished) return "false";
    commit(false);
    return "true";
  };

  if (standard !== "xapi") {
    win.API = {
      LMSInitialize: initialise,
      LMSFinish: terminate,
      LMSGetValue: getValue,
      LMSSetValue: setValue,
      LMSCommit: save,
      LMSGetLastError: () => lastError,
      LMSGetErrorString: errorString,
      LMSGetDiagnostic: errorString,
    };
    win.API_1484_11 = {
      Initialize: initialise,
      Terminate: terminate,
      GetValue: getValue,
      SetValue: setValue,
      Commit: save,
      GetLastError: () => lastError,
      GetErrorString: errorString,
      GetDiagnostic: errorString,
    };
    return;
  }

  // xAPI: statements sent to the offline record store are kept for the app; anything else asked
  // of the store (state, profiles) has nothing here. Nothing ever leaves the phone from here.
  const isStore = (url: unknown) => typeof url === "string" && url.indexOf(LRS) === 0;
  const take = (method: string, url: string, body: unknown): { status: number; body: string } => {
    const path = url.slice(LRS.length).split("?")[0] ?? "";
    if (path !== "statements" || (method !== "POST" && method !== "PUT")) {
      return { status: 404, body: "" };
    }
    let parsed: unknown;
    try {
      parsed = typeof body === "string" ? JSON.parse(body) : null;
    } catch {
      return { status: 400, body: "" };
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const kept = list.filter((s) => typeof s === "object" && s !== null);
    if (kept.length === 0 || kept.length > 50) return { status: 400, body: "" };
    send({ type: "statements", statements: kept });
    const ids = kept.map((s) => String((s as { id?: unknown }).id ?? ""));
    return { status: 200, body: JSON.stringify(ids) };
  };

  const realFetch = win.fetch as ((input: unknown, init?: unknown) => Promise<unknown>) | undefined;
  win.fetch = (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = typeof input === "string" ? input : String((input as { url?: unknown })?.url ?? "");
    if (!isStore(url)) {
      // Only the package's own files on the phone: nothing from the network.
      if (/^https?:/i.test(url)) return Promise.reject(new TypeError("Offline"));
      return realFetch ? realFetch(input, init) : Promise.reject(new TypeError("Offline"));
    }
    const answer = take(String(init?.method ?? "GET").toUpperCase(), url, init?.body);
    return Promise.resolve({
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: () => Promise.resolve(answer.body ? JSON.parse(answer.body) : null),
      text: () => Promise.resolve(answer.body),
    });
  };

  const RealXhr = win.XMLHttpRequest as
    | (new () => {
        open(method: string, url: string): void;
        send(body?: unknown): void;
      })
    | undefined;
  win.XMLHttpRequest = function OfflineXhr(this: Record<string, unknown>) {
    const real = RealXhr ? new RealXhr() : null;
    let method = "GET";
    let url = "";
    this.readyState = 0;
    this.status = 0;
    this.responseText = "";
    this.open = (m: string, u: string) => {
      method = String(m).toUpperCase();
      url = String(u);
      this.readyState = 1;
      if (!isStore(url) && real) real.open(m, u);
    };
    this.setRequestHeader = () => undefined;
    this.getResponseHeader = () => null;
    this.getAllResponseHeaders = () => "";
    this.abort = () => undefined;
    this.send = (body?: unknown) => {
      if (!isStore(url)) {
        if (/^https?:/i.test(url) || !real) {
          this.readyState = 4;
          this.status = 0;
          if (typeof this.onerror === "function") (this.onerror as () => void)();
          return;
        }
        real.send(body);
        return;
      }
      const answer = take(method, url, body);
      this.readyState = 4;
      this.status = answer.status;
      this.responseText = answer.body;
      this.response = answer.body;
      if (typeof this.onreadystatechange === "function") {
        (this.onreadystatechange as () => void)();
      }
      if (typeof this.onload === "function") (this.onload as () => void)();
    };
  } as unknown;
}

/** The script injected before the launch page loads. */
export function offlineRuntimeSource(config: OfflineRuntimeConfig): string {
  return `(${offlineRuntimeMain.toString()})(window, ${JSON.stringify(config)}); true;`;
}

/** The launch page's query for the phone: an xAPI course is told the offline record store. */
export function offlineLaunchQuery(
  standard: OfflineRuntimeConfig["standard"],
  launchQuery: string,
  attemptId: string,
): string {
  if (standard !== "xapi") return launchQuery ? `?${launchQuery}` : "";
  const params = new URLSearchParams(launchQuery);
  params.set("endpoint", OFFLINE_LRS);
  params.set("auth", "Basic b2ZmbGluZTpwaG9uZQ==");
  // The actor names the attempt, never the person (as on the content origin).
  params.set(
    "actor",
    JSON.stringify({
      objectType: "Agent",
      account: { homePage: "https://harbour.offline.invalid", name: attemptId },
    }),
  );
  params.set("registration", attemptId);
  return `?${params.toString()}`;
}

/** Every data model element the API keeps, with its longest value (`CMI_ELEMENTS`). */
const KEPT_LENGTHS: Readonly<Record<string, number>> = {
  ...CMI_ELEMENTS.scorm_1_2,
  ...CMI_ELEMENTS.scorm_2004,
};

export type RuntimeMessage =
  | {
      readonly type: "commit";
      readonly cmi: Readonly<Record<string, string>>;
      readonly finished: boolean;
    }
  | { readonly type: "statements"; readonly statements: readonly Record<string, unknown>[] };

/** Reads a message from the WebView, or null when it is not one of the runtime's. */
export function parseRuntimeMessage(data: string): RuntimeMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof m !== "object" || m === null) return null;
  const msg = m as Record<string, unknown>;
  if (msg.protocol !== RUNTIME_PROTOCOL) return null;
  if (msg.type === "commit") {
    if (typeof msg.finished !== "boolean" || typeof msg.cmi !== "object" || msg.cmi === null) {
      return null;
    }
    // Only what the API keeps, within its lengths, whatever calls the bridge (review M2).
    const cmi: Record<string, string> = {};
    for (const [k, v] of Object.entries(msg.cmi as Record<string, unknown>)) {
      const max = KEPT_LENGTHS[k];
      if (typeof v !== "string" || max === undefined || v.length > max) return null;
      cmi[k] = v;
    }
    return { type: "commit", cmi, finished: msg.finished };
  }
  if (msg.type === "statements" && Array.isArray(msg.statements)) {
    const list = msg.statements.filter(
      (s): s is Record<string, unknown> => typeof s === "object" && s !== null && !Array.isArray(s),
    );
    if (list.length === 0 || list.length > 50 || list.length !== msg.statements.length) return null;
    // Each statement at most what the API keeps (16 KB), so none is queued only to be refused.
    if (
      list.some(
        (s) => new TextEncoder().encode(JSON.stringify(s)).length > XAPI_STATEMENT_MAX_BYTES,
      )
    ) {
      return null;
    }
    return { type: "statements", statements: list };
  }
  return null;
}

/**
 * A package's page as the phone keeps it: the offline policy (`OFFLINE_CSP`) written into its
 * `<head>` before anything else, at download, so it holds from the first byte the page loads,
 * whatever the platform does with injected script (security review of slice 72, M1).
 */
export function withOfflinePolicy(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${OFFLINE_CSP}">`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head)
    return (
      html.slice(0, head.index + head[0].length) + meta + html.slice(head.index + head[0].length)
    );
  const root = /<html(\s[^>]*)?>/i.exec(html);
  if (root) {
    const at = root.index + root[0].length;
    return `${html.slice(0, at)}<head>${meta}</head>${html.slice(at)}`;
  }
  return `<head>${meta}</head>${html}`;
}

/** Whether a package file is a page the policy is written into. */
export const isPage = (path: string) => /\.html?$/i.test(path);
