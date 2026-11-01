import type { EmailPort, PushPort, SmsPort } from "@harbour/domain";
import { describe, expect, it } from "vitest";
import {
  createAdapter,
  emailTextBody,
  guarded,
  MockEmail,
  MockPush,
  MockSms,
} from "../src/integrations/adapters";

/**
 * Port contract (section 15.3): every adapter, mock or real, must pass these. Real adapters run them
 * against partner sandboxes when credentials are present in CI; mocks always run.
 */
function portContract<P extends EmailPort | SmsPort | PushPort>(
  name: string,
  make: () => P,
  to: () => never,
) {
  describe(`${name} contract`, () => {
    it("sends and returns a provider message id", async () => {
      const adapter = guarded(make() as never) as P;
      const result = await adapter.send({
        idempotencyKey: "k1",
        title: "A visit was missed",
        link: "/visits/1",
        to: to(),
      } as never);
      expect(result).toMatchObject({ ok: true, providerMessageId: expect.any(String) });
    });

    it("sends once per idempotency key", async () => {
      const raw = make();
      const adapter = guarded(raw as never) as P;
      const message = {
        idempotencyKey: "k2",
        title: "A visit was missed",
        link: null,
        to: to(),
      } as never;
      const first = await adapter.send(message);
      const second = await adapter.send(message);
      expect(second).toEqual(first);
      expect((raw as unknown as { sent: unknown[] }).sent).toHaveLength(1);
    });

    it("refuses a title that looks like personal data", async () => {
      const adapter = guarded(make() as never) as P;
      const result = await adapter.send({
        idempotencyKey: "k3",
        title: "Ada 999 000 0018 fell",
        link: null,
        to: to(),
      } as never);
      expect(result).toMatchObject({ ok: false, retryable: false });
    });

    it("reports health", async () => {
      expect((await make().health()).ok).toBe(true);
    });
  });
}

portContract(
  "mock email",
  () => new MockEmail(),
  () => "manager@example.invalid" as never,
);
portContract(
  "mock SMS",
  () => new MockSms(),
  () => "+447700900123" as never,
);
portContract(
  "mock push",
  () => new MockPush(),
  () => ["ExponentPushToken[fixture]"] as never,
);

describe("adapter selection", () => {
  it("uses the mock outside production when nothing is configured", () => {
    expect(createAdapter("comms.email", null, { production: false }).provider).toBe("mock");
  });

  it("fails clearly in production when nothing is configured", async () => {
    const adapter = createAdapter("comms.sms", null, { production: true });
    expect(adapter.provider).toBe("unconfigured");
    expect(
      await adapter.send({ idempotencyKey: "x", title: "Hello", link: null, to: "+447700900123" }),
    ).toEqual({
      ok: false,
      retryable: false,
      error: "No provider is configured for comms.sms.",
    });
  });

  it("chooses the configured provider", () => {
    expect(
      createAdapter(
        "comms.email",
        { provider: "smtp", settings: { from: "a@example.invalid" } },
        {
          production: true,
          smtp: {
            host: "smtp.example.invalid",
            port: 587,
            tls: "starttls",
            allowedFromDomains: ["example.invalid"],
          },
          smtpTransport: () => ({ sendMail: async () => ({}), verify: async () => true }) as never,
        },
      ).provider,
    ).toBe("smtp");
    // Production email stays off until a relay is configured (ADR-0098).
    expect(
      createAdapter(
        "comms.email",
        { provider: "smtp", settings: { from: "a@example.invalid" } },
        { production: true, smtp: null },
      ).provider,
    ).toBe("unconfigured");
    expect(
      createAdapter("comms.push", { provider: "expo", settings: {} }, { production: true })
        .provider,
    ).toBe("expo");
  });
});

describe("the email body (H-225)", () => {
  const base = { idempotencyKey: "k", title: "A visit was missed", to: "x@example.invalid" };
  it("sends the message's own body when it has one, never the link line", () => {
    expect(emailTextBody({ ...base, link: null, body: "Your code is 123456." })).toBe(
      "Your code is 123456.\n",
    );
  });
  it("otherwise sends the title and the link into Harbour", () => {
    expect(emailTextBody({ ...base, link: "https://app.example.invalid/x" })).toBe(
      "A visit was missed\n\nOpen Harbour to see the details: https://app.example.invalid/x\n",
    );
  });
});
