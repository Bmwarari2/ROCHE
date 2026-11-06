import type {
  EnvelopeResult,
  EnvelopeStatus,
  ExternalSignaturePort,
  HealthResult,
  OcrEngine,
  OcrPort,
  OcrReadField,
  OcrRequest,
  OcrResult,
  SignatureEnvelope,
} from "@harbour/domain";
import { ocrEngineAllowed } from "@harbour/domain";
import type { Config } from "../config";

/**
 * E-signature and OCR adapters (Phase 2 slice 79; ADR-0095). Only mocks are built: a DocuSign
 * mock that keeps envelopes in memory and makes no network call (a real client waits for H-540),
 * and an OCR mock for development and tests (the Document AI adapter, in europe-west2, waits for
 * H-1262). Production refuses both mocks at start (config.ts); with none configured, signing is
 * in Harbour only and OCR is unavailable.
 */

const MOCK_MARKER = "HARBOUR-OCR-MOCK:";
const FAIL_MARKER = "HARBOUR-OCR-FAIL";

/**
 * Reads nothing: returns the fields an image's test instructions give (the marker followed by a
 * JSON array), as given, so the API's own checks see whatever an engine might send; an image
 * without instructions reads as nothing, never an invented chart (clinical review finding 12). An
 * image carrying the failure marker fails, retryably.
 */
export class MockOcr implements OcrPort {
  readonly engine: OcrEngine = "mock";
  readonly location = "local";
  readonly requests: string[] = [];

  async read(request: OcrRequest): Promise<OcrResult> {
    this.requests.push(request.idempotencyKey);
    const text = new TextDecoder().decode(request.image.bytes);
    if (text.includes(FAIL_MARKER)) return { ok: false, retryable: true, error: "engine_error" };
    const at = text.indexOf(MOCK_MARKER);
    if (at < 0) return { ok: true, fields: [] };
    const end = text.indexOf("\n", at);
    const json = text.slice(at + MOCK_MARKER.length, end < 0 ? undefined : end);
    try {
      const parsed = JSON.parse(json) as unknown;
      if (!Array.isArray(parsed)) throw new Error("not a list");
      const fields = parsed.map((f) => {
        const r = f as Partial<OcrReadField>;
        return {
          group: r.group as number,
          label: r.label as OcrReadField["label"],
          text: String(r.text ?? ""),
          confidence: typeof r.confidence === "number" ? r.confidence : 0.5,
        };
      });
      return { ok: true, fields };
    } catch {
      return { ok: false, retryable: false, error: "unreadable" };
    }
  }

  async health(): Promise<HealthResult> {
    return { ok: true, detail: "mock OCR (local)" };
  }
}

interface MockEnvelope {
  readonly id: string;
  readonly envelope: SignatureEnvelope;
  state: "sent" | "declined" | "voided" | "completed";
  completedAt: Date | null;
}

/**
 * DocuSign stand-in: envelopes in memory, never a network call. Tests move an envelope on with
 * `complete`, `decline` and `returnBytes`; the API only uses the port.
 */
export class MockDocuSign implements ExternalSignaturePort {
  readonly provider = "docusign" as const;
  private readonly envelopes = new Map<string, MockEnvelope>();
  private readonly byKey = new Map<string, string>();
  private readonly returned = new Map<string, Uint8Array>();
  /** What each envelope was given (tests check nothing more than needed left Harbour). */
  readonly sent: SignatureEnvelope[] = [];

  async send(envelope: SignatureEnvelope): Promise<EnvelopeResult> {
    const existing = this.byKey.get(envelope.idempotencyKey);
    if (existing) return { ok: true, envelopeId: existing };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(envelope.signer.email)) {
      return { ok: false, retryable: false, error: "invalid_signer" };
    }
    const id = `mock-envelope-${this.envelopes.size + 1}`;
    this.envelopes.set(id, { id, envelope, state: "sent", completedAt: null });
    this.byKey.set(envelope.idempotencyKey, id);
    this.sent.push(envelope);
    return { ok: true, envelopeId: id };
  }

  async status(envelopeId: string): Promise<EnvelopeStatus | null> {
    const e = this.envelopes.get(envelopeId);
    if (!e) return null;
    if (e.state !== "completed") return { state: e.state };
    const bytes = this.returned.get(envelopeId) ?? e.envelope.document.bytes;
    return {
      state: "completed",
      completedAt: e.completedAt ?? new Date(),
      signed: { bytes, contentType: e.envelope.document.contentType },
    };
  }

  async void(envelopeId: string): Promise<void> {
    const e = this.envelopes.get(envelopeId);
    if (e && e.state === "sent") e.state = "voided";
  }

  async health(): Promise<HealthResult> {
    return { ok: true, detail: "mock DocuSign (no network)" };
  }

  /** Test control: the signer signed; the provider returns these bytes (default: the original). */
  complete(envelopeId: string, bytes?: Uint8Array): void {
    const e = this.envelopes.get(envelopeId);
    if (!e) throw new Error("no such envelope");
    e.state = "completed";
    e.completedAt = new Date();
    if (bytes) this.returned.set(envelopeId, bytes);
  }

  /** Test control: the signer declined. */
  decline(envelopeId: string): void {
    const e = this.envelopes.get(envelopeId);
    if (!e) throw new Error("no such envelope");
    e.state = "declined";
  }
}

export interface EsignOcrServices {
  /** The OCR engine, or null when none is configured (OCR is then unavailable). */
  readonly ocr: OcrPort | null;
  /** The DocuSign adapter, or null when off (signing is then in Harbour only). */
  readonly docusign: ExternalSignaturePort | null;
}

export function createEsignOcrServices(config: Config): EsignOcrServices {
  const ocr = config.OCR_ENGINE === "mock" ? new MockOcr() : null;
  if (ocr && !ocrEngineAllowed(ocr.engine, ocr.location)) {
    throw new Error("OCR engine is not on the allowlist (ADR-0095)");
  }
  return { ocr, docusign: config.DOCUSIGN === "mock" ? new MockDocuSign() : null };
}
