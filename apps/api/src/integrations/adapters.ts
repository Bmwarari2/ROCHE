import { createHash } from "node:crypto";
import {
  type EmailMessage,
  type EmailPort,
  type HealthResult,
  type OutboundMessage,
  outboundBodyProblem,
  outboundTitleProblem,
  type PortMap,
  type PortName,
  type PushMessage,
  type PushPort,
  type SendResult,
  type SmsMessage,
  type SmsPort,
} from "@harbour/domain";
import { createTransport, type Transporter } from "nodemailer";
import type { SmtpConfig } from "../config";
import { senderAllowed } from "./secret-ref";

/**
 * Adapters for the communication ports (section 15.3). Each port has a mock, used in development,
 * tests and by tenants without the partner; real adapters are chosen per tenant through
 * `integration_connection`. Every adapter is wrapped by `guarded`, which refuses titles that look
 * like personal data and makes sends idempotent per key.
 */

/** In-memory mock: records what would have been sent. Never touches the network. */
class MockOutbox<M extends OutboundMessage> {
  readonly sent: M[] = [];
  readonly provider = "mock";
  async send(message: M): Promise<SendResult> {
    this.sent.push(message);
    return {
      ok: true,
      providerMessageId: `mock-${createHash("sha256").update(message.idempotencyKey).digest("hex").slice(0, 16)}`,
    };
  }
  async health(): Promise<HealthResult> {
    return { ok: true, detail: "Mock adapter: messages are recorded, not sent." };
  }
}

export class MockEmail extends MockOutbox<EmailMessage> implements EmailPort {}
export class MockSms extends MockOutbox<SmsMessage> implements SmsPort {}
export class MockPush extends MockOutbox<PushMessage> implements PushPort {}

/** Used in production when a tenant has not configured a channel: fails clearly, never silently. */
class Unconfigured<M extends OutboundMessage> {
  readonly provider = "unconfigured";
  constructor(private readonly port: PortName) {}
  async send(_message: M): Promise<SendResult> {
    return { ok: false, retryable: false, error: `No provider is configured for ${this.port}.` };
  }
  async health(): Promise<HealthResult> {
    return { ok: false, detail: `No provider is configured for ${this.port}.` };
  }
}

/**
 * The plain-text body an email carries: the message's own body when it has one, otherwise the title and
 * the link into Harbour (H-225).
 */
export function emailTextBody(message: EmailMessage): string {
  if (message.body !== undefined)
    return message.body.endsWith("\n") ? message.body : `${message.body}\n`;
  return `${message.title}\n\n${message.link ? `Open Harbour to see the details: ${message.link}` : "Open Harbour to see the details."}\n`;
}

/** What the SMTP adapter uses of a nodemailer transport (a double in tests). */
export type SmtpTransport = Pick<Transporter, "sendMail" | "verify">;

/** A nodemailer transport for the relay: TLS 1.2 or later, certificates verified, never pooled. */
export function smtpTransport(smtp: SmtpConfig): SmtpTransport {
  return createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.tls === "implicit",
    requireTLS: smtp.tls === "starttls",
    ignoreTLS: smtp.tls === "none",
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    ...(smtp.user && smtp.password ? { auth: { user: smtp.user, pass: smtp.password } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
}

/** SMTP errors that will not succeed on a retry: a permanent (5xx) reply, or a refused address. */
function permanentSmtpFailure(error: { responseCode?: unknown; code?: unknown }): boolean {
  const reply = typeof error.responseCode === "number" ? error.responseCode : 0;
  return (reply >= 500 && reply < 600) || error.code === "EENVELOPE" || error.code === "EAUTH";
}

/**
 * Email through an SMTP relay (ADR-0098). Plain text only: a title, and a body or a link. The
 * result carries the relay's reply code or nodemailer's error code, never the reply text, which
 * can quote the address.
 */
export class SmtpEmail implements EmailPort {
  readonly provider = "smtp";
  constructor(
    private readonly from: string,
    private readonly transport: SmtpTransport,
    /** Domains the sender may use (`SMTP_ALLOWED_FROM_DOMAINS`); none allows no sender. */
    private readonly allowedFromDomains: readonly string[] = [],
  ) {}
  async send(message: EmailMessage): Promise<SendResult> {
    // Checked again at send, not only when the connection is saved: a row written before the
    // rule, or a domain since removed from the list, sends nothing (#164 security review, L2).
    if (!senderAllowed(this.from, this.allowedFromDomains)) {
      return { ok: false, retryable: false, error: "SenderNotAllowed" };
    }
    try {
      const result = await this.transport.sendMail({
        from: this.from,
        to: message.to,
        subject: message.title,
        text: emailTextBody(message),
        textEncoding: "quoted-printable",
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      return { ok: true, providerMessageId: String(result.messageId ?? "unknown") };
    } catch (error) {
      const failure = (error ?? {}) as { responseCode?: unknown; code?: unknown };
      const code =
        typeof failure.responseCode === "number"
          ? `SMTP ${failure.responseCode}`
          : typeof failure.code === "string"
            ? failure.code
            : "SmtpError";
      return { ok: false, retryable: !permanentSmtpFailure(failure), error: code };
    }
  }
  async health(): Promise<HealthResult> {
    try {
      await this.transport.verify();
      return { ok: true, detail: "SMTP relay reachable." };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      return {
        ok: false,
        detail: `SMTP relay unreachable (${typeof code === "string" ? code : "error"}).`,
      };
    }
  }
}

/** Expo push service (APNs and FCM). The notification shows only the generic title. */
export class ExpoPush implements PushPort {
  readonly provider = "expo";
  constructor(
    private readonly accessToken?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async send(message: PushMessage): Promise<SendResult> {
    const response = await this.fetchImpl("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
      },
      body: JSON.stringify(
        message.to.map((to) => ({
          to,
          title: message.title,
          data: { link: message.link },
          sound: "default",
        })),
      ),
    }).catch((error: unknown) => ({ ok: false, status: 0, error }) as const);
    if (!("json" in response)) return { ok: false, retryable: true, error: "NetworkError" };
    if (!response.ok)
      return { ok: false, retryable: response.status >= 500, error: `HTTP ${response.status}` };
    const body = (await response.json()) as { data?: { id?: string; status?: string }[] };
    const first = body.data?.[0];
    if (first?.status !== "ok") return { ok: false, retryable: false, error: "PushRejected" };
    return { ok: true, providerMessageId: first.id ?? "unknown" };
  }
  async health(): Promise<HealthResult> {
    return { ok: true, detail: "Expo push configured." };
  }
}

/** Refuses outbound titles that look like personal data, and never sends twice for one key. */
export function guarded<
  M extends OutboundMessage,
  P extends { provider: string; send(m: M): Promise<SendResult>; health(): Promise<HealthResult> },
>(adapter: P): P {
  const seen = new Map<string, SendResult>();
  return {
    ...adapter,
    provider: adapter.provider,
    health: () => adapter.health(),
    send: async (message: M) => {
      const problem =
        outboundTitleProblem(message.title) ??
        ("body" in message && typeof message.body === "string"
          ? outboundBodyProblem(message.body)
          : null);
      if (problem) return { ok: false, retryable: false, error: `Refused: ${problem}` };
      const previous = seen.get(message.idempotencyKey);
      if (previous?.ok) return previous;
      const result = await adapter.send(message);
      if (result.ok) seen.set(message.idempotencyKey, result);
      return result;
    },
  } as P;
}

export interface ConnectionChoice {
  readonly provider: string;
  readonly settings: Record<string, unknown>;
}

export interface AdapterFactoryOptions {
  readonly production: boolean;
  /** Shared mocks so tests can inspect what was sent. */
  readonly mocks?: { email: MockEmail; sms: MockSms; push: MockPush };
  /** The SMTP relay (config `smtp`); without one the `smtp` provider is not configured. */
  readonly smtp?: SmtpConfig | null;
  /** Builds the transport for the relay; tests pass a double. */
  readonly smtpTransport?: (smtp: SmtpConfig) => SmtpTransport;
}

/** Chooses the adapter for a tenant's port: its configured provider, otherwise the mock (or, in production, a clear "not configured"). */
export function createAdapter<K extends PortName>(
  port: K,
  connection: ConnectionChoice | null,
  options: AdapterFactoryOptions,
): PortMap[K] {
  const mocks = options.mocks ?? {
    email: new MockEmail(),
    sms: new MockSms(),
    push: new MockPush(),
  };
  const provider = connection?.provider ?? (options.production ? "unconfigured" : "mock");
  let adapter: EmailPort | SmsPort | PushPort;
  // The mock never runs in production, even when a connection names it (#53 review L3): it would
  // report sent and keep what it was handed (an invitation's link) in the API's memory.
  if (provider === "mock" && options.production) {
    adapter = new Unconfigured(port);
  } else if (provider === "mock") {
    adapter = port === "comms.email" ? mocks.email : port === "comms.sms" ? mocks.sms : mocks.push;
  } else if (port === "comms.email" && provider === "smtp" && options.smtp) {
    adapter = new SmtpEmail(
      String(connection?.settings.from ?? ""),
      (options.smtpTransport ?? smtpTransport)(options.smtp),
      options.smtp.allowedFromDomains,
    );
  } else if (port === "comms.push" && provider === "expo") {
    adapter = new ExpoPush();
  } else {
    adapter = new Unconfigured(port);
  }
  return guarded(adapter as never) as PortMap[K];
}

/** Providers each port accepts in `integration_connection`. */
export const KNOWN_PROVIDERS: Record<PortName, readonly string[]> = {
  "comms.email": ["mock", "smtp"],
  "comms.sms": ["mock"],
  "comms.push": ["mock", "expo"],
};
