/**
 * Integration ports (`integrations` bounded context, section 15.3). A port is the interface a module
 * depends on; adapters (mock, SES, Expo, a UK SMS gateway, later GP Connect, payroll and so on)
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
