import type { HealthResult } from "./ports";

/**
 * E-signature and OCR ports (Phase 2 slice 79; INTG-013; ADR-0095; integrations.md section 11).
 * Pure rules: the ports' shapes, the OCR engine allowlist (europe-west2 only, ADR-0098) and the
 * rule that OCR text is never a fact until a person decides each value (HZ-005). Adapters live in
 * the API; each passes the contract tests in the API's integrations folder.
 */

// ---- E-signature ------------------------------------------------------------------------------

export const SIGNATURE_PORT = "documents.signature";
/** `in_app` is every organisation's default; `docusign` only when an organisation asks (H-540). */
export const SIGNATURE_PROVIDERS = ["in_app", "docusign"] as const;
export type SignatureProvider = (typeof SIGNATURE_PROVIDERS)[number];
export const DEFAULT_SIGNATURE_PROVIDER: SignatureProvider = "in_app";

export const SIGNATURE_REQUEST_STATES = [
  "requested",
  "sent",
  "signed",
  "declined",
  "cancelled",
  "failed",
] as const;
export type SignatureRequestState = (typeof SIGNATURE_REQUEST_STATES)[number];

/** What a provider is given to collect a signature: no more than it needs. */
export interface SignatureEnvelope {
  /** The request id: a provider must not open two envelopes for one key. */
  readonly idempotencyKey: string;
  /** A generic subject with no personal data, for example "A document to sign". */
  readonly subject: string;
  readonly document: { readonly bytes: Uint8Array; readonly contentType: string };
  readonly documentSha256: string;
  readonly signer: { readonly name: string; readonly email: string };
}

export type EnvelopeResult =
  | { readonly ok: true; readonly envelopeId: string }
  | { readonly ok: false; readonly retryable: boolean; readonly error: string };

export type EnvelopeStatus =
  | { readonly state: "sent" }
  | { readonly state: "declined" | "voided" }
  | {
      readonly state: "completed";
      readonly completedAt: Date;
      /** The signed document the provider returns, stored as a new version after a scan. */
      readonly signed: { readonly bytes: Uint8Array; readonly contentType: string };
    };

/** A provider that collects signatures outside Harbour. In-app signing needs no adapter. */
export interface ExternalSignaturePort {
  readonly provider: Exclude<SignatureProvider, "in_app">;
  send(envelope: SignatureEnvelope): Promise<EnvelopeResult>;
  status(envelopeId: string): Promise<EnvelopeStatus | null>;
  void(envelopeId: string, reason: string): Promise<void>;
  health(): Promise<HealthResult>;
}

export type SignRefusal =
  | "not_the_signer"
  | "not_open"
  | "step_up_required"
  | "document_changed"
  | "wrong_provider";

/**
 * Whether a member may sign an in-app request now: only the named signer, only while it is open,
 * only with a fresh second factor, and only the exact bytes the request names (ADR-0095).
 */
export function inAppSignRefusal(input: {
  readonly provider: SignatureProvider;
  readonly state: SignatureRequestState;
  readonly signerId: string;
  readonly memberId: string;
  readonly stepUpFresh: boolean;
  readonly requestSha256: string;
  readonly currentSha256: string;
  readonly sha256Seen: string;
}): SignRefusal | null {
  if (input.provider !== "in_app") return "wrong_provider";
  if (input.signerId !== input.memberId) return "not_the_signer";
  if (input.state !== "requested") return "not_open";
  const request = input.requestSha256.toLowerCase();
  if (request !== input.currentSha256.toLowerCase() || request !== input.sha256Seen.toLowerCase()) {
    return "document_changed";
  }
  if (!input.stepUpFresh) return "step_up_required";
  return null;
}

/** The request state an external envelope's status moves it to; null when nothing changes. */
export function envelopeTransition(
  state: SignatureRequestState,
  status: EnvelopeStatus["state"],
  returnedScan: "clean" | "infected" | "unavailable" | null,
): SignatureRequestState | null {
  if (state !== "sent") return null;
  if (status === "sent") return null;
  if (status === "declined") return "declined";
  if (status === "voided") return "cancelled";
  // Completed: only a returned document that scanned clean marks the request signed; anything
  // else leaves it sent (and the bytes quarantined) for someone to look at.
  return returnedScan === "clean" ? "signed" : null;
}

// ---- OCR --------------------------------------------------------------------------------------

export const OCR_PORT = "documents.ocr";

/**
 * The OCR engines allowed to receive images, with the only location each may run in (ADR-0095,
 * ADR-0098). Adding one is an ADR, a DPIA change and a sub-processor register entry.
 */
export const OCR_ENGINES = {
  google_document_ai: { location: "europe-west2" },
  mock: { location: "local" },
} as const;
export type OcrEngine = keyof typeof OCR_ENGINES;

export function ocrEngineAllowed(engine: string, location: string): engine is OcrEngine {
  return (
    Object.hasOwn(OCR_ENGINES, engine) &&
    OCR_ENGINES[engine as OcrEngine].location === location.toLowerCase()
  );
}

export const OCR_KINDS = ["mar", "general"] as const;
export type OcrKind = (typeof OCR_KINDS)[number];

/** Labels an engine's lines are sorted into; a MAR line's parts, or plain text. */
export const OCR_FIELD_LABELS = [
  "medicine",
  "strength",
  "dose",
  "route",
  "directions",
  "prescriber",
  "text",
] as const;
export type OcrFieldLabel = (typeof OCR_FIELD_LABELS)[number];

export interface OcrRequest {
  readonly idempotencyKey: string;
  readonly kind: OcrKind;
  readonly image: { readonly bytes: Uint8Array; readonly contentType: string };
}

export interface OcrReadField {
  /** For a MAR, which medicine line on the chart (0 first); 0 for plain text. */
  readonly group: number;
  readonly label: OcrFieldLabel;
  readonly text: string;
  /** The engine's own confidence, 0 to 1: shown for information, never used to decide. */
  readonly confidence: number;
}

export type OcrResult =
  | { readonly ok: true; readonly fields: readonly OcrReadField[] }
  | { readonly ok: false; readonly retryable: boolean; readonly error: string };

export interface OcrPort {
  readonly engine: OcrEngine;
  readonly location: string;
  read(request: OcrRequest): Promise<OcrResult>;
  health(): Promise<HealthResult>;
}

export const OCR_FIELD_STATES = ["unconfirmed", "confirmed", "corrected", "rejected"] as const;
export type OcrFieldState = (typeof OCR_FIELD_STATES)[number];

export interface OcrField extends OcrReadField {
  readonly id: string;
  readonly state: OcrFieldState;
  /** The value a person decided: the text as read, or their correction. Null until then. */
  readonly value: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
}

/** The longest value a person may type for one field. */
export const MAX_OCR_VALUE_LENGTH = 500;

/**
 * Fields as read: every one unconfirmed, whatever the engine's confidence (HZ-005). Text is
 * trimmed and cut to the longest value a field may hold; empty lines are dropped.
 */
export function unconfirmedFields(read: readonly OcrReadField[], newId: () => string): OcrField[] {
  return read
    .map((f) => ({ ...f, text: f.text.replace(/\s+/g, " ").trim().slice(0, MAX_OCR_VALUE_LENGTH) }))
    .filter((f) => f.text.length > 0)
    .map((f) => ({
      ...f,
      confidence: Math.min(1, Math.max(0, Number.isFinite(f.confidence) ? f.confidence : 0)),
      id: newId(),
      state: "unconfirmed" as const,
      value: null,
      decidedBy: null,
      decidedAt: null,
    }));
}

export type OcrDecision =
  | { readonly action: "confirm" }
  | { readonly action: "correct"; readonly value: string }
  | { readonly action: "reject" };

export type OcrDecisionResult =
  | { readonly ok: true; readonly field: OcrField }
  | { readonly ok: false; readonly problem: "already_decided" | "value_required" | "unchanged" };

/** A person's decision on one value: confirm it as read, correct it, or reject it. */
export function decideField(
  field: OcrField,
  decision: OcrDecision,
  by: string,
  at: Date,
): OcrDecisionResult {
  if (field.state !== "unconfirmed") return { ok: false, problem: "already_decided" };
  if (decision.action === "confirm") {
    return {
      ok: true,
      field: { ...field, state: "confirmed", value: field.text, decidedBy: by, decidedAt: at },
    };
  }
  if (decision.action === "reject") {
    return {
      ok: true,
      field: { ...field, state: "rejected", value: null, decidedBy: by, decidedAt: at },
    };
  }
  const value = decision.value.replace(/\s+/g, " ").trim();
  if (value.length === 0 || value.length > MAX_OCR_VALUE_LENGTH) {
    return { ok: false, problem: "value_required" };
  }
  if (value === field.text) return { ok: false, problem: "unchanged" };
  return { ok: true, field: { ...field, state: "corrected", value, decidedBy: by, decidedAt: at } };
}

export type ReleaseRefusal = "undecided_fields" | "nothing_confirmed";

/** An extraction is released only when a person has decided every field, and one value stands. */
export function releaseRefusal(fields: readonly OcrField[]): ReleaseRefusal | null {
  if (fields.some((f) => f.state === "unconfirmed")) return "undecided_fields";
  if (!fields.some((f) => f.state === "confirmed" || f.state === "corrected")) {
    return "nothing_confirmed";
  }
  return null;
}

/** A medicine line from a released MAR scan, for the medicines module (slice 51). */
export interface ScannedMedicineLine {
  readonly line: number;
  /** Only the values a person confirmed or corrected; a rejected or absent part is null. */
  readonly medicine: string | null;
  readonly strength: string | null;
  readonly dose: string | null;
  readonly route: string | null;
  readonly directions: string | null;
  readonly prescriber: string | null;
  /** Always: OCR is a transcription that a second competent member checks (HZ-005, H-548). */
  readonly origin: "import";
  readonly state: "not_yet_checked";
  readonly secondCheckRequired: true;
}

/**
 * The medicine lines of a released MAR scan: confirmed or corrected values only, one line per
 * chart line that kept a medicine name. Never a dm+d product, a dose unit or a schedule: the
 * transcriber still chooses the product from dm+d and enters the dose in slice 51.
 */
export function scannedMedicineLines(fields: readonly OcrField[]): ScannedMedicineLine[] {
  if (releaseRefusal(fields) !== null) return [];
  const groups = new Map<number, Map<OcrFieldLabel, string>>();
  for (const f of fields) {
    if (f.state !== "confirmed" && f.state !== "corrected") continue;
    if (f.value === null) continue;
    const group = groups.get(f.group) ?? new Map<OcrFieldLabel, string>();
    const before = group.get(f.label);
    group.set(f.label, before ? `${before} ${f.value}` : f.value);
    groups.set(f.group, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, parts]) => parts.has("medicine"))
    .map(([line, parts]) => ({
      line,
      medicine: parts.get("medicine") ?? null,
      strength: parts.get("strength") ?? null,
      dose: parts.get("dose") ?? null,
      route: parts.get("route") ?? null,
      directions: parts.get("directions") ?? null,
      prescriber: parts.get("prescriber") ?? null,
      origin: "import",
      state: "not_yet_checked",
      secondCheckRequired: true,
    }));
}
