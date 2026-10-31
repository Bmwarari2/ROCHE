/**
 * Integration ports (`integrations` bounded context, section 15.3). A port is the interface a module
 * depends on; adapters (mock, SMTP, Expo, a UK SMS gateway, later GP Connect, payroll and so on)
 * implement it in the API. Every port has a mock, so a tenant without the partner still gets a
 * working product, and a contract test that every adapter must pass.
 *
 * Messages leaving Harbour through email, SMS or push carry no personal data: a generic title and a
 * link back into the app, where access control applies (section 9.1 notification centre).
 */

export const PORTS = ["comms.email", "comms.sms", "comms.push"] as const;
export type PortName = (typeof PORTS)[number];

export interface OutboundMessage {
  /** Opaque idempotency key: the delivery id. Adapters must not send twice for the same key. */
  readonly idempotencyKey: string;
  /** Generic title with no personal data, for example "A visit was missed". */
  readonly title: string;
  /** Deep link into Harbour, where the detail is shown after sign-in. */
  readonly link: string | null;
}

export interface EmailMessage extends OutboundMessage {
  readonly to: string;
  /**
   * Plain-text body, for an email that must say more than a title (an evidence pack code with its
   * guidance, a letter sent by email under ADR-0051). Without one the body is the title and the
   * link. Never logged.
   */
  readonly body?: string;
}

export interface SmsMessage extends OutboundMessage {
  /** E.164, for example +447700900123 (Ofcom drama range in fixtures). */
  readonly to: string;
}

export interface PushMessage extends OutboundMessage {
  /** Device push tokens registered for the recipient. */
  readonly to: readonly string[];
}

export type SendResult =
  | { readonly ok: true; readonly providerMessageId: string }
  | { readonly ok: false; readonly retryable: boolean; readonly error: string };

export interface HealthResult {
  readonly ok: boolean;
  readonly detail: string;
}

export interface EmailPort {
  readonly provider: string;
  send(message: EmailMessage): Promise<SendResult>;
  health(): Promise<HealthResult>;
}

export interface SmsPort {
  readonly provider: string;
  send(message: SmsMessage): Promise<SendResult>;
  health(): Promise<HealthResult>;
}

export interface PushPort {
  readonly provider: string;
  send(message: PushMessage): Promise<SendResult>;
  health(): Promise<HealthResult>;
}

export interface PortMap {
  readonly "comms.email": EmailPort;
  readonly "comms.sms": SmsPort;
  readonly "comms.push": PushPort;
}

/** The longest generic title we allow out of the building; longer titles are a smell of detail. */
export const MAX_OUTBOUND_TITLE_LENGTH = 80;

/**
 * Last-line check before anything leaves Harbour: refuses titles that look like they contain an NHS
 * number, a date of birth, an email address or a UK phone number.
 */
export function outboundTitleProblem(title: string): string | null {
  if (title.length === 0) return "Title is empty.";
  if (title.length > MAX_OUTBOUND_TITLE_LENGTH) return "Title is too long for a generic alert.";
  if (/\b\d{3}\s?\d{3}\s?\d{4}\b/.test(title)) return "Title looks like it contains an NHS number.";
  if (/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(title)) return "Title looks like it contains a date.";
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(title))
    return "Title looks like it contains an email address.";
  if (/(\+44\s?7\d{3}|\b07\d{3})\s?\d{3}\s?\d{3}\b/.test(title)) {
    return "Title looks like it contains a phone number.";
  }
  return null;
}

/** Why: a letter by email is a letter, not a book (`MAX_TEMPLATE_BODY_LENGTH` plus values). */
export const MAX_OUTBOUND_BODY_LENGTH = 40_000;

/**
 * Last-line check on an email body (#70 review): no link of any kind (a body carries what the
 * approved template says, and a link goes in `link` alone), and nothing shaped like an NHS number.
 */
export function outboundBodyProblem(body: string): string | null {
  if (body.length > MAX_OUTBOUND_BODY_LENGTH) return "Body is too long.";
  const lower = body.toLowerCase();
  if (
    lower.includes("http://") ||
    lower.includes("https://") ||
    lower.includes("www.") ||
    lower.includes("mailto:")
  ) {
    return "Body contains a link.";
  }
  // The NHS number's own grouping (3, 3, 4 digits), as the title check reads it; a telephone
  // number, which a letter may carry, is not refused.
  if (/\b\d{3}[\s-]?\d{3}[\s-]?\d{4}\b/.test(body)) {
    return "Body looks like it contains an NHS number.";
  }
  return null;
}

export type DeliveryOutcome =
  | { readonly status: "sent"; readonly providerMessageId: string }
  | { readonly status: "pending"; readonly retryInSeconds: number; readonly error: string }
  | { readonly status: "failed"; readonly error: string };

/** Retry with exponential backoff up to `maxAttempts`, then give up and surface the failure. */
export function deliveryOutcome(
  result: SendResult,
  attempts: number,
  maxAttempts = 5,
): DeliveryOutcome {
  if (result.ok) return { status: "sent", providerMessageId: result.providerMessageId };
  if (!result.retryable || attempts >= maxAttempts)
    return { status: "failed", error: result.error };
  return {
    status: "pending",
    retryInSeconds: Math.min(3600, 30 * 2 ** (attempts - 1)),
    error: result.error,
  };
}

export interface InboundProblem {
  readonly path: string;
  readonly message: string;
}

export type InboundDecision =
  | { readonly status: "accepted" }
  | { readonly status: "quarantined"; readonly problems: readonly InboundProblem[] };

/** Inbound data that fails validation is quarantined with its problems, never dropped. */
export function classifyInbound(problems: readonly InboundProblem[]): InboundDecision {
  return problems.length === 0 ? { status: "accepted" } : { status: "quarantined", problems };
}

/**
 * Document storage (section 9.1): objects are addressed by opaque keys that never contain personal
 * data. `destroy` removes every stored version, for destruction past retention (section 5.1).
 */
export interface DocumentStoragePort {
  readonly provider: string;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  destroy(key: string): Promise<void>;
  health(): Promise<HealthResult>;
  /** Writes an object from a stream of unknown length without holding it in memory (the export). */
  putStream(key: string, source: AsyncIterable<Uint8Array>, contentType: string): Promise<void>;
  /** Reads an object as a stream; null when there is none. */
  getStream(key: string): Promise<AsyncIterable<Uint8Array> | null>;
}

/**
 * An organisation's key encryption key (ADR-0109): wraps the per-object data keys of one
 * organisation, and destroys every version of itself to shred that organisation. Also signs
 * destruction certificates with Harbour's certificate key. Cloud KMS in production; a local
 * provider in development and tests.
 */
export interface TenantKeyPort {
  readonly provider: string;
  /** Wraps a data key with the organisation's key (the organisation id is authenticated). */
  wrap(tenantId: string, dataKey: Uint8Array): Promise<Uint8Array>;
  /** Unwraps a data key; throws once the organisation's keys are shredded. */
  unwrap(tenantId: string, wrapped: Uint8Array): Promise<Uint8Array>;
  /** Schedules every version of the organisation's key for destruction. */
  shred(
    tenantId: string,
  ): Promise<readonly { readonly name: string; readonly destroyAt: string }[]>;
  /** Signs a message (a certificate's canonical body) with Harbour's certificate key. */
  sign(
    message: Uint8Array,
  ): Promise<{ readonly signature: string; readonly key: string; readonly algorithm: string }>;
  /** Checks a signature made by `sign`. */
  verify(message: Uint8Array, signature: string, key: string): Promise<boolean>;
  health(): Promise<HealthResult>;
}

/** `unavailable` keeps the upload quarantined: a document is never served unscanned in production. */
export type MalwareVerdict = "clean" | "infected" | "unavailable";

export interface MalwareScanPort {
  readonly provider: string;
  scan(bytes: Uint8Array): Promise<MalwareVerdict>;
}

/** Opaque storage key for a document: tenant and document ids only. */
export function documentStorageKey(tenantId: string, documentId: string): string {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(tenantId) || !uuid.test(documentId)) throw new Error("Storage keys take ids only");
  return `tenants/${tenantId.toLowerCase()}/documents/${documentId.toLowerCase()}`;
}
