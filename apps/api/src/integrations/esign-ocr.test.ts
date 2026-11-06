import type { ExternalSignaturePort, OcrPort, SignatureEnvelope } from "@harbour/domain";
import { ocrEngineAllowed, unconfirmedFields } from "@harbour/domain";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { createEsignOcrServices, MockDocuSign, MockOcr } from "./esign-ocr";

/**
 * Contract tests every e-signature and OCR adapter must pass (ADR-0095; section 15.3: "a contract
 * test and a mock"). A real adapter is added beside the mocks below and runs the same contract.
 */

const encode = (text: string) => new TextEncoder().encode(text);

function ocrContract(name: string, make: () => OcrPort, image: Uint8Array) {
  describe(`OCR contract: ${name}`, () => {
    it("runs only where the allowlist lets it (europe-west2, or local for the mock)", () => {
      const port = make();
      expect(ocrEngineAllowed(port.engine, port.location)).toBe(true);
    });

    it("returns text with a confidence from 0 to 1 and a known label, never a decision", async () => {
      const result = await make().read({
        idempotencyKey: "00000000-0000-7000-8000-000000000001",
        kind: "mar",
        image: { bytes: image, contentType: "image/jpeg" },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.fields.length).toBeGreaterThan(0);
      for (const f of result.fields) {
        expect(typeof f.text).toBe("string");
        expect(f.confidence).toBeGreaterThanOrEqual(0);
        expect(f.confidence).toBeLessThanOrEqual(1);
        expect(Object.keys(f).sort()).toEqual(["confidence", "group", "label", "text"]);
      }
      // What Harbour keeps of it starts unconfirmed, every value (HZ-005).
      const kept = unconfirmedFields(result.fields, () => "id");
      expect(new Set(kept.map((f) => f.state))).toEqual(new Set(["unconfirmed"]));
    });

    it("reports its health", async () => {
      expect((await make().health()).ok).toBe(true);
    });
  });
}

const envelope = (key: string, email = "signer@example.invalid"): SignatureEnvelope => ({
  idempotencyKey: key,
  subject: "A document to sign",
  document: { bytes: encode("%PDF-1.7 policy"), contentType: "application/pdf" },
  documentSha256: "d".repeat(64),
  signer: { name: "Sam Signer", email },
});

function signatureContract(name: string, make: () => ExternalSignaturePort) {
  describe(`e-signature contract: ${name}`, () => {
    it("opens one envelope per request, however often it is asked", async () => {
      const port = make();
      const first = await port.send(envelope("00000000-0000-7000-8000-0000000000a1"));
      const again = await port.send(envelope("00000000-0000-7000-8000-0000000000a1"));
      expect(first.ok && again.ok).toBe(true);
      if (first.ok && again.ok) expect(again.envelopeId).toBe(first.envelopeId);
    });

    it("says sent until something happens, and nothing for an envelope it does not know", async () => {
      const port = make();
      const sent = await port.send(envelope("00000000-0000-7000-8000-0000000000a2"));
      if (!sent.ok) throw new Error("not sent");
      expect(await port.status(sent.envelopeId)).toEqual({ state: "sent" });
      expect(await port.status("no-such-envelope")).toBeNull();
    });

    it("voids an envelope that was sent", async () => {
      const port = make();
      const sent = await port.send(envelope("00000000-0000-7000-8000-0000000000a3"));
      if (!sent.ok) throw new Error("not sent");
      await port.void(sent.envelopeId, "Sent in error");
      expect(await port.status(sent.envelopeId)).toEqual({ state: "voided" });
    });

    it("refuses a signer without a usable email, without retrying", async () => {
      const result = await make().send(
        envelope("00000000-0000-7000-8000-0000000000a4", "not-an-email"),
      );
      expect(result).toMatchObject({ ok: false, retryable: false });
    });

    it("reports its health", async () => {
      expect((await make().health()).ok).toBe(true);
    });
  });
}

ocrContract(
  "mock",
  () => new MockOcr(),
  encode(
    `HARBOUR-OCR-MOCK:${JSON.stringify([{ group: 0, label: "medicine", text: "Amlodipine 5 mg tablets", confidence: 0.9 }])}\n`,
  ),
);
signatureContract("DocuSign mock", () => new MockDocuSign());

describe("the mocks' own test controls", () => {
  it("reads nothing from an image without test instructions: never an invented chart", async () => {
    const out = await new MockOcr().read({
      idempotencyKey: "k0",
      kind: "mar",
      image: { bytes: encode("a real chart"), contentType: "image/jpeg" },
    });
    expect(out).toEqual({ ok: true, fields: [] });
  });

  it("reads the fields an image's test instructions give, and fails on the failure marker", async () => {
    const ocr = new MockOcr();
    const fields = [{ group: 2, label: "dose", text: "5 ml", confidence: 0.4 }];
    const out = await ocr.read({
      idempotencyKey: "k1",
      kind: "mar",
      image: {
        bytes: encode(`x HARBOUR-OCR-MOCK:${JSON.stringify(fields)}\n`),
        contentType: "image/jpeg",
      },
    });
    expect(out).toEqual({ ok: true, fields });
    const failed = await ocr.read({
      idempotencyKey: "k2",
      kind: "mar",
      image: { bytes: encode("HARBOUR-OCR-FAIL"), contentType: "image/jpeg" },
    });
    expect(failed).toEqual({ ok: false, retryable: true, error: "engine_error" });
  });

  it("completes an envelope with the bytes the provider returns", async () => {
    const port = new MockDocuSign();
    const sent = await port.send(envelope("00000000-0000-7000-8000-0000000000b1"));
    if (!sent.ok) throw new Error("not sent");
    port.complete(sent.envelopeId, encode("%PDF-1.7 signed"));
    const status = await port.status(sent.envelopeId);
    expect(status?.state).toBe("completed");
    if (status?.state === "completed") {
      expect(new TextDecoder().decode(status.signed.bytes)).toBe("%PDF-1.7 signed");
    }
  });
});

describe("configuration (ADR-0095)", () => {
  const base = { NODE_ENV: "test", LOG_LEVEL: "silent" };
  it("has DocuSign and OCR off unless set, everywhere", () => {
    const services = createEsignOcrServices(loadConfig(base));
    expect(services.docusign).toBeNull();
    expect(services.ocr).toBeNull();
  });

  it("turns the mocks on only when asked", () => {
    const services = createEsignOcrServices(
      loadConfig({ ...base, OCR_ENGINE: "mock", DOCUSIGN: "mock" }),
    );
    expect(services.ocr?.engine).toBe("mock");
    expect(services.docusign?.provider).toBe("docusign");
  });
});
