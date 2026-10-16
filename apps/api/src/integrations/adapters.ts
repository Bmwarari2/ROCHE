import { createHash } from "node:crypto";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import {
  type EmailMessage,
  type EmailPort,
  type HealthResult,
  type OutboundMessage,
  outboundTitleProblem,
  type PortMap,
  type PortName,
  type PushMessage,
  type PushPort,
  type SendResult,
  type SmsMessage,
  type SmsPort,
} from "@harbour/domain";

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
 * The plain-text body SES sends: the message's own body when it has one, otherwise the title and
 * the link into Harbour (H-225).
 */
export function emailTextBody(message: EmailMessage): string {
  if (message.body !== undefined)
    return message.body.endsWith("\n") ? message.body : `${message.body}\n`;
  return `${message.title}\n\n${message.link ? `Open Harbour to see the details: ${message.link}` : "Open Harbour to see the details."}\n`;
}

/** Amazon SES in eu-west-2 (London). Plain text only: a title, and a body or a link. */
export class SesEmail implements EmailPort {
  readonly provider = "ses";
  private readonly client: SESv2Client;
  constructor(
    private readonly from: string,
    region = "eu-west-2",
  ) {
    this.client = new SESv2Client({ region });
  }
  async send(message: EmailMessage): Promise<SendResult> {
    try {
      const result = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: this.from,
          Destination: { ToAddresses: [message.to] },
          Content: {
            Simple: {
              Subject: { Data: message.title, Charset: "UTF-8" },
              Body: {
                Text: {
                  Data: emailTextBody(message),
                  Charset: "UTF-8",
                },
              },
            },
          },
        }),
      );
      return { ok: true, providerMessageId: result.MessageId ?? "unknown" };
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error";
      return {
        ok: false,
        retryable: !/MessageRejected|AccountSuspended|MailFromDomainNotVerified/.test(name),
        error: name,
      };
    }
  }
  async health(): Promise<HealthResult> {
    return { ok: true, detail: "SES client configured for eu-west-2." };
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
      const problem = outboundTitleProblem(message.title);
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
  } else if (port === "comms.email" && provider === "ses") {
    adapter = new SesEmail(String(connection?.settings.from ?? ""));
  } else if (port === "comms.push" && provider === "expo") {
    adapter = new ExpoPush();
  } else {
    adapter = new Unconfigured(port);
  }
  return guarded(adapter as never) as PortMap[K];
}

/** Providers each port accepts in `integration_connection`. */
export const KNOWN_PROVIDERS: Record<PortName, readonly string[]> = {
  "comms.email": ["mock", "ses"],
  "comms.sms": ["mock"],
  "comms.push": ["mock", "expo"],
};
