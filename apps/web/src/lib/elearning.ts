import {
  ELEARNING_PROTOCOL,
  type ElearningAppMessage,
  ElearningRuntimeMessage,
} from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import type { StatusChipStatus } from "@harbour/ui";
import { webOrigin } from "./invitations";

/**
 * E-learning (workforce.md section 14; ADR-0093; slice 43). Package content is untrusted: it runs
 * only on the content origin (`ELEARNING_ORIGIN`, another registrable domain from the app's), in an iframe,
 * inside Harbour's own runtime page, and reaches the app only through the postMessage protocol in
 * `@harbour/contracts`, which both sides parse and check (origin, source window, attempt). The
 * web tier serves the content origin from `/learn/{token}` and nothing else on that host.
 */

export const ELEARNING_PAGE = "/training/elearning";
export const ELEARNING_UPLOAD_PATH = "/api/elearning/upload";
export const TITLE_HEADER = "x-harbour-course-title";
export const TOPIC_HEADER = "x-harbour-course-topic";
export const TIER_HEADER = "x-harbour-course-tier";
export const TRAINING_MANAGE = "workforce.training.manage";
export const SELF_READ = "workforce.self.read";
/** The `elearning_package` category's limit. */
export const PACKAGE_MAX_BYTES = 100 * 1024 * 1024;

export function elearningShown(permissions: readonly string[]): boolean {
  return permissions.includes(SELF_READ) || permissions.includes(TRAINING_MANAGE);
}
export function elearningManaged(permissions: readonly string[]): boolean {
  return permissions.includes(TRAINING_MANAGE);
}

/** Second-level names under which each registrable domain has three labels (UK first). */
const THREE_LABEL_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "me.uk",
  "ltd.uk",
  "plc.uk",
  "net.uk",
  "sch.uk",
  "ac.uk",
  "gov.uk",
  "nhs.uk",
  "police.uk",
]);

/**
 * The site a host belongs to, as browsers draw the line for cookies and SameSite: an IP address
 * or a single label is its own site; otherwise the registrable domain (the last two labels, or
 * three under a UK second-level name such as co.uk). Conservative: a domain this cannot place is
 * read as broader, so it refuses more rather than less.
 */
export function siteOf(host: string): string {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (/^[0-9.]+$/.test(name) || name.includes(":") || !name.includes(".")) return name;
  const labels = name.split(".");
  const two = labels.slice(-2).join(".");
  return THREE_LABEL_SUFFIXES.has(two) ? labels.slice(-3).join(".") : two;
}

/**
 * The content origin from configuration, never from a request. In development the same server
 * answers on 127.0.0.1, a different site from localhost; in production it must be set, and must be
 * another site from the app's, not a subdomain of the app's own domain, or no course launches: a
 * package on the same site could set cookies the app would receive and count as same-site
 * (review H1).
 */
export function contentOrigin(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const raw =
    env.ELEARNING_ORIGIN ?? (env.NODE_ENV === "production" ? null : "http://127.0.0.1:3000");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const origin = url.origin;
    const app = webOrigin(env);
    if (app) {
      const appHost = new URL(app).hostname;
      if (siteOf(appHost) === siteOf(url.hostname)) return null;
      if (appHost.endsWith(`.${url.hostname}`) || url.hostname.endsWith(`.${appHost}`)) return null;
    }
    // Never weaker than the app: an app served over TLS frames content only over TLS.
    if (app?.startsWith("https://") && !origin.startsWith("https://")) return null;
    return origin;
  } catch {
    return null;
  }
}

/** Whether a request reached this server under the content origin's host name. */
export function isContentHost(host: string | null, origin: string | null): boolean {
  if (!host || !origin) return false;
  return host.toLowerCase() === new URL(origin).host.toLowerCase();
}

const TOKEN = /^[A-Za-z0-9_-]{10,400}\.[A-Za-z0-9_-]{20,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isLaunchToken(value: string): boolean {
  return TOKEN.test(value);
}

/**
 * The attempt a launch token names, read from its payload without checking the signature (the API
 * checks it on every request; the runtime page only needs to know which attempt to announce).
 */
export function attemptOfToken(token: string): string | null {
  if (!isLaunchToken(token)) return null;
  try {
    const [attemptId] = JSON.parse(
      Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8"),
    ) as unknown[];
    return typeof attemptId === "string" && UUID.test(attemptId) ? attemptId : null;
  } catch {
    return null;
  }
}

/**
 * The name a package is told (`cmi.core.student_name`, `cmi.learner_name`): the first name only,
 * so untrusted content never holds the member's full name (review M8).
 */
export function learnerNameOf(displayName: string): string {
  return displayName.trim().split(/\s+/)[0]?.slice(0, 60) ?? "";
}

export function launchUrl(origin: string, token: string): string {
  return `${origin}/learn/${token}`;
}

/** The package path a content request names, joined from its segments; null when unsafe. */
export function packagePathOf(segments: readonly string[]): string | null {
  if (segments.length === 0 || segments.length > 40) return null;
  const path = segments.join("/");
  if (path.length > 240) return null;
  for (const s of segments) {
    const control = [...s].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20);
    if (s === "" || s === "." || s === ".." || s.includes("\\") || control) {
      return null;
    }
  }
  return path;
}

const COMMON = [
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "worker-src 'none'",
  "manifest-src 'none'",
];

/** The runtime page's policy: only its own script and the package frame; framed only by the app. */
export function runtimeCsp(appOrigin: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'unsafe-inline'",
    "frame-src 'self'",
    "img-src 'none'",
    "connect-src 'none'",
    `frame-ancestors ${appOrigin}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/**
 * A package file's policy. SCORM content commonly needs inline script and eval, so it gets them,
 * but only on the content origin, framed only by Harbour's runtime page on that origin, with no
 * plugins, workers or connections beyond the content origin (where only its token's files and
 * statements are served).
 */
export function contentCsp(appOrigin: string): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    // Every ancestor is checked: the runtime page (self) and the app above it.
    `frame-ancestors 'self' ${appOrigin}`,
    ...COMMON,
  ].join("; ");
}

/** Headers on everything the content origin serves. */
export function contentHeaders(csp: string): Record<string, string> {
  return {
    "content-security-policy": csp,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(), publickey-credentials-create=()",
    "cache-control": "private, no-store",
  };
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

/** Harbour's runtime page on the content origin: the SCORM API and the package frame. */
export function runtimePage(input: {
  readonly appOrigin: string;
  readonly attemptId: string;
  readonly title: string;
  /** `/learn/{token}`: every path the page uses is absolute under it. */
  readonly base: string;
}): string {
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>${escapeHtml(input.title)}</title>
<style>html,body{margin:0;height:100%;background:#fff}iframe{border:0;width:100%;height:100%;display:block}</style>
</head><body><iframe id="content" title="${escapeHtml(input.title)}"></iframe>
<script src="${escapeHtml(input.base)}/_harbour/runtime.js" data-app="${escapeHtml(input.appOrigin)}" data-attempt="${escapeHtml(input.attemptId)}" data-base="${escapeHtml(input.base)}"></script>
</body></html>`;
}

/**
 * Reads a message from the runtime, as the app's player receives it: only from the content
 * origin, only from the player's own frame, only in the protocol's shape, only for this attempt.
 * Anything else is null and dropped.
 */
export function readRuntimeMessage(
  event: { readonly origin: string; readonly source: unknown; readonly data: unknown },
  expected: { readonly origin: string; readonly frame: unknown; readonly attemptId: string },
): ElearningRuntimeMessage | null {
  if (event.origin !== expected.origin || event.source !== expected.frame || !expected.frame) {
    return null;
  }
  const parsed = ElearningRuntimeMessage.safeParse(event.data);
  if (!parsed.success || parsed.data.attemptId !== expected.attemptId) return null;
  return parsed.data;
}

export function startMessage(
  input: Omit<Extract<ElearningAppMessage, { type: "start" }>, "protocol" | "type">,
) {
  return { protocol: ELEARNING_PROTOCOL, type: "start" as const, ...input };
}

/** An attempt's status as an icon and a word. */
export function attemptChip(
  status: "in_progress" | "completed" | "passed" | "failed" | null,
  t: Translator,
): {
  readonly status: StatusChipStatus;
  readonly icon: "circle-check" | "clock" | "circle-alert" | "circle-minus";
  readonly label: string;
} {
  const look = {
    passed: { status: "done", icon: "circle-check" },
    completed: { status: "done", icon: "circle-check" },
    in_progress: { status: "due", icon: "clock" },
    failed: { status: "overdue", icon: "circle-alert" },
    none: { status: "notApplicable", icon: "circle-minus" },
  } as const;
  const key = status ?? "none";
  return { ...look[key], label: t("elearning.attempt.status", { status: key }) };
}

export type UploadCheck =
  | {
      readonly ok: true;
      readonly title: string;
      readonly topic: string;
      readonly tier: number | null;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };

/**
 * Whether a package upload may be read: posted from this site only (by configuration, never
 * request headers), a zip, with a given length within the limit, a title and a topic.
 */
export function checkPackageUpload(
  input: {
    readonly origin: string | null;
    readonly contentType: string | null;
    readonly contentLength: string | null;
    readonly title: string | null;
    readonly topic: string | null;
    readonly tier: string | null;
  },
  site: string | null,
  topics: readonly string[],
  t: Translator,
): UploadCheck {
  const refuse = (status: number, code: string, message: string) =>
    ({ ok: false, status, code, message }) as const;
  if (!input.origin || !site || new URL(site).origin !== safeOrigin(input.origin)) {
    return refuse(403, "forbidden", t("errors.forbidden"));
  }
  const type = (input.contentType ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/zip" && type !== "application/x-zip-compressed") {
    return refuse(415, "type", t("elearning.upload.zipOnly"));
  }
  const length = Number(input.contentLength);
  if (!input.contentLength || !Number.isInteger(length) || length <= 0) {
    return refuse(411, "length", t("elearning.upload.fileRequired"));
  }
  if (length > PACKAGE_MAX_BYTES) return refuse(413, "too_large", t("elearning.upload.tooLarge"));
  const title = (input.title ?? "").trim();
  if (title.length < 2 || title.length > 160)
    return refuse(422, "title", t("elearning.upload.titleRequired"));
  const topic = input.topic ?? "";
  if (!topics.includes(topic)) return refuse(422, "topic", t("elearning.upload.topicRequired"));
  const tier = input.tier ? Number(input.tier) : null;
  if ((topic === "oliver_mcgowan") !== (tier === 1 || tier === 2)) {
    return refuse(422, "tier", t("elearning.upload.tierRequired"));
  }
  return { ok: true, title, topic, tier };
}

function safeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
