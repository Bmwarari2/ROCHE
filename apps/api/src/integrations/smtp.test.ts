import type { EmailMessage } from "@harbour/domain";
import { createTransport } from "nodemailer";
import { describe, expect, it } from "vitest";
import { guarded, SmtpEmail, type SmtpTransport, smtpTransport } from "./adapters";

/**
 * The SMTP email adapter's contract (ADR-0098). nodemailer's stream transport builds the real
 * message without any network, so the test reads what the relay would receive; failures come from
 * a double that throws as nodemailer does.
 */

const FROM = "Harbour <no-reply@example.invalid>";
const DOMAINS = ["example.invalid"];
const MESSAGE: EmailMessage = {
  idempotencyKey: "invite-1",
  to: "ada.example@example.invalid",
  title: "You have been invited to Harbour",
  link: "https://app.harbour.example.invalid/invitations/abc",
};

function captured(): { transport: SmtpTransport; raw: () => Promise<string> } {
  const transport = createTransport({ streamTransport: true, buffer: true, newline: "unix" });
  let last: Promise<string> = Promise.resolve("");
  return {
    transport: {
      sendMail: (mail: Parameters<SmtpTransport["sendMail"]>[0]) => {
        const sent = transport.sendMail(mail);
        last = sent.then((info) => String((info as { message: Buffer }).message));
        return sent;
      },
      verify: async () => true,
    } as SmtpTransport,
    raw: () => last,
  };
}

function failing(error: Record<string, unknown>): SmtpTransport {
  return {
    sendMail: async () => {
      throw Object.assign(new Error(`550 5.1.1 <${MESSAGE.to}>: user unknown`), error);
    },
    verify: async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ESOCKET" });
    },
  } as unknown as SmtpTransport;
}

describe("SmtpEmail", () => {
  it("sends a plain-text message with the title and the link, and nothing else", async () => {
    const { transport, raw } = captured();
    const result = await new SmtpEmail(FROM, transport, DOMAINS).send(MESSAGE);
    expect(result).toMatchObject({ ok: true });
    const message = await raw();
    expect(message).toContain("Subject: You have been invited to Harbour");
    expect(message).toContain("To: ada.example@example.invalid");
    expect(message).toContain("Content-Type: text/plain; charset=utf-8");
    expect(message).toContain("Open Harbour to see the details:");
    expect(message).not.toContain("text/html");
    expect(message).not.toContain("Content-Disposition: attachment");
  });

  it("carries a message's own body when it has one", async () => {
    const { transport, raw } = captured();
    await new SmtpEmail(FROM, transport, DOMAINS).send({
      ...MESSAGE,
      body: "A manager will be in touch.",
    });
    expect(await raw()).toContain("A manager will be in touch.");
  });

  it.each([
    ["a permanent refusal", { responseCode: 550, code: "EENVELOPE" }, false, "SMTP 550"],
    ["a temporary refusal", { responseCode: 451 }, true, "SMTP 451"],
    ["a refused sign-in", { code: "EAUTH" }, false, "EAUTH"],
    ["a dropped connection", { code: "ECONNECTION" }, true, "ECONNECTION"],
  ])("reports %s by its code only", async (_label, error, retryable, code) => {
    const result = await new SmtpEmail(FROM, failing(error), DOMAINS).send(MESSAGE);
    expect(result).toEqual({ ok: false, retryable, error: code });
    // The relay's reply text quotes the address; it never reaches the result (or the logs).
    expect(JSON.stringify(result)).not.toContain(MESSAGE.to);
  });

  it("reports an unreachable relay by its code only", async () => {
    expect(await new SmtpEmail(FROM, failing({}), DOMAINS).health()).toEqual({
      ok: false,
      detail: "SMTP relay unreachable (ESOCKET).",
    });
  });

  it("is still refused a title shaped like an NHS number, by the guard", async () => {
    const { transport } = captured();
    const result = await guarded(new SmtpEmail(FROM, transport, DOMAINS)).send({
      ...MESSAGE,
      title: "Update about NHS 999 123 4567",
    });
    expect(result.ok).toBe(false);
  });
});

describe("SmtpEmail sender domains (#164 security review, L2)", () => {
  it.each([
    ["a domain not on the list", "Harbour <alerts@elsewhere.example>", DOMAINS],
    ["a subdomain of an allowed domain", "alerts@mail.example.invalid", DOMAINS],
    ["no domains configured", FROM, []],
    ["something that is not an address", "Harbour", DOMAINS],
  ])("sends nothing from %s", async (_label, from, domains) => {
    let sent = 0;
    const transport = {
      sendMail: async () => {
        sent += 1;
        return { messageId: "x" };
      },
      verify: async () => true,
    } as unknown as SmtpTransport;
    expect(await new SmtpEmail(from, transport, domains).send(MESSAGE)).toEqual({
      ok: false,
      retryable: false,
      error: "SenderNotAllowed",
    });
    expect(sent).toBe(0);
  });
});

describe("smtpTransport", () => {
  it.each([
    ["starttls", { secure: false, requireTLS: true, ignoreTLS: false }],
    ["implicit", { secure: true, requireTLS: false, ignoreTLS: false }],
    ["none", { secure: false, requireTLS: false, ignoreTLS: true }],
  ] as const)("configures %s with TLS 1.2 or later and verified certificates", (tls, expected) => {
    const transport = smtpTransport({
      host: "smtp.example.invalid",
      port: 587,
      tls,
      allowedFromDomains: [],
    }) as unknown as {
      options: Record<string, unknown>;
    };
    expect(transport.options).toMatchObject({
      ...expected,
      tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    });
  });
});
