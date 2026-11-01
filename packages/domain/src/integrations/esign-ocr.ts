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
  // The signer is checked first, so someone else learns nothing about the request (security L1).
  if (input.signerId !== input.memberId) return "not_the_signer";
  if (input.provider !== "in_app") return "wrong_provider";
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

/** The highest chart line an engine may give (lines are numbered from 0). */
export const MAX_OCR_LINE = 199;
/** The longest value a field may hold. A longer text read is kept cut and marked truncated. */
export const MAX_OCR_VALUE_LENGTH = 500;
/**
 * Below this, a value read is flagged "check carefully" on screen. The engine's number itself is
 * never shown to the person deciding (automation bias), and never decides anything (HZ-005).
 */
export const OCR_LOW_CONFIDENCE = 0.8;

export interface OcrField extends OcrReadField {
  readonly id: string;
  readonly state: OcrFieldState;
  /** The value a person decided: the text as read, or their correction. Null until then. */
  readonly value: string | null;
  /** The chart line and the part a person decided it belongs to (the engine's are a proposal). */
  readonly decidedLine: number | null;
  readonly decidedLabel: OcrFieldLabel | null;
  /** The text read was longer than a field holds and was cut: it can be corrected, not confirmed. */
  readonly truncated: boolean;
  /** Typed by a person for something the scan missed, never read by the engine. */
  readonly addedByPerson: boolean;
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
}

/**
 * Whether what an engine returned can be kept at all: every line a whole number from 0 to
 * `MAX_OCR_LINE` and every label one Harbour knows. Anything else is refused whole, never coerced
 * into another line or label (clinical review finding 10).
 */
export function readFieldsProblem(read: readonly OcrReadField[]): "unreadable" | null {
  const ok = read.every(
    (f) =>
      Number.isInteger(f.group) &&
      f.group >= 0 &&
      f.group <= MAX_OCR_LINE &&
      (OCR_FIELD_LABELS as readonly string[]).includes(f.label) &&
      typeof f.text === "string",
  );
  return ok ? null : "unreadable";
}

/**
 * Fields as read: every one unconfirmed, whatever the engine's confidence (HZ-005). Text is
 * tidied; a text longer than a field holds is cut and marked truncated; empty lines are dropped.
 * Call `readFieldsProblem` first.
 */
export function unconfirmedFields(read: readonly OcrReadField[], newId: () => string): OcrField[] {
  return read
    .map((f) => ({ ...f, text: f.text.replace(/\s+/g, " ").trim() }))
    .filter((f) => f.text.length > 0)
    .map((f) => ({
      ...f,
      text: f.text.slice(0, MAX_OCR_VALUE_LENGTH),
      truncated: f.text.length > MAX_OCR_VALUE_LENGTH,
      confidence: Math.min(1, Math.max(0, Number.isFinite(f.confidence) ? f.confidence : 0)),
      id: newId(),
      state: "unconfirmed" as const,
      value: null,
      decidedLine: null,
      decidedLabel: null,
      addedByPerson: false,
      decidedBy: null,
      decidedAt: null,
    }));
}

/** Where a person says a value belongs, when it is not where the engine put it. */
export interface OcrPlacement {
  readonly line?: number;
  readonly label?: OcrFieldLabel;
}

export type OcrDecision =
  | ({ readonly action: "confirm" } & OcrPlacement)
  | ({ readonly action: "correct"; readonly value: string } & OcrPlacement)
  | { readonly action: "reject" };

export type OcrDecisionProblem =
  | "already_decided"
  | "value_required"
  | "unchanged"
  | "truncated"
  | "bad_line";

export type OcrDecisionResult =
  | { readonly ok: true; readonly field: OcrField }
  | { readonly ok: false; readonly problem: OcrDecisionProblem };

const tidy = (value: string) => value.replace(/\s+/g, " ").trim();
const lineOk = (line: number) => Number.isInteger(line) && line >= 0 && line <= MAX_OCR_LINE;

/**
 * A person's decision on one value: confirm it as read, correct it, or reject it. Confirming or
 * correcting also decides its chart line and part, the engine's unless the person moves it
 * (clinical review finding 1). A truncated text cannot be confirmed as read.
 */
export function decideField(
  field: OcrField,
  decision: OcrDecision,
  by: string,
  at: Date,
): OcrDecisionResult {
  if (field.state !== "unconfirmed") return { ok: false, problem: "already_decided" };
  if (decision.action === "reject") {
    return {
      ok: true,
      field: { ...field, state: "rejected", value: null, decidedBy: by, decidedAt: at },
    };
  }
  const line = decision.line ?? field.group;
  if (!lineOk(line)) return { ok: false, problem: "bad_line" };
  const placed = { decidedLine: line, decidedLabel: decision.label ?? field.label };
  if (decision.action === "confirm") {
    if (field.truncated) return { ok: false, problem: "truncated" };
    return {
      ok: true,
      field: {
        ...field,
        ...placed,
        state: "confirmed",
        value: field.text,
        decidedBy: by,
        decidedAt: at,
      },
    };
  }
  const value = tidy(decision.value);
  if (value.length === 0 || value.length > MAX_OCR_VALUE_LENGTH) {
    return { ok: false, problem: "value_required" };
  }
  const moved = placed.decidedLine !== field.group || placed.decidedLabel !== field.label;
  if (value === field.text && !moved && !field.truncated)
    return { ok: false, problem: "unchanged" };
  return {
    ok: true,
    field: { ...field, ...placed, state: "corrected", value, decidedBy: by, decidedAt: at },
  };
}

/**
 * A value the scan missed, typed by a person from the chart: decided as they typed it, never read
 * by the engine (clinical review finding 4).
 */
export function addedField(
  input: { readonly line: number; readonly label: OcrFieldLabel; readonly value: string },
  id: string,
  by: string,
  at: Date,
): OcrDecisionResult {
  if (!lineOk(input.line)) return { ok: false, problem: "bad_line" };
  const value = tidy(input.value);
  if (value.length === 0 || value.length > MAX_OCR_VALUE_LENGTH) {
    return { ok: false, problem: "value_required" };
  }
  return {
    ok: true,
    field: {
      id,
      group: input.line,
      label: input.label,
      text: value,
      confidence: 0,
      state: "corrected",
      value,
      decidedLine: input.line,
      decidedLabel: input.label,
      truncated: false,
      addedByPerson: true,
      decidedBy: by,
      decidedAt: at,
    },
  };
}

/** What a person says about each medicine line on the paper chart. */
export const OCR_LINE_STATUSES = ["active", "stopped", "cannot_tell"] as const;
export type OcrLineStatus = (typeof OCR_LINE_STATUSES)[number];

/** What a person confirms about the chart as a whole before it is released. */
export interface OcrReleaseInput {
  /** The medicine lines they count on the paper chart, typed, never prefilled. */
  readonly linesCounted: number;
  /** For every medicine line: still in force on this chart, stopped or crossed out, or unclear. */
  readonly lineStatuses: ReadonlyMap<number, OcrLineStatus>;
  /** The name and date of birth on the chart match the person it is filed for (HZ-130). */
  readonly personConfirmed: boolean;
  /** The period the chart covers, as YYYY-MM-DD, and that it is the current chart. */
  readonly chartFrom: string;
  readonly chartTo: string;
  readonly currentChart: boolean;
}

export type ReleaseRefusal =
  | "undecided_fields"
  | "duplicate_part"
  | "orphan_parts"
  | "no_medicine_lines"
  | "line_count_differs"
  | "line_status_missing"
  | "line_status_unclear"
  | "person_not_confirmed"
  | "chart_period"
  | "not_current_chart";

const standing = (f: OcrField) =>
  (f.state === "confirmed" || f.state === "corrected") &&
  f.value !== null &&
  f.decidedLine !== null &&
  f.decidedLabel !== null;

/** Standing values by the line a person decided, each part listed (more than one is refused). */
function partsByLine(fields: readonly OcrField[]) {
  const lines = new Map<number, Map<OcrFieldLabel, OcrField[]>>();
  for (const f of fields.filter(standing)) {
    const line = lines.get(f.decidedLine as number) ?? new Map<OcrFieldLabel, OcrField[]>();
    const label = f.decidedLabel as OcrFieldLabel;
    line.set(label, [...(line.get(label) ?? []), f]);
    lines.set(f.decidedLine as number, line);
  }
  return lines;
}

const isoDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

/**
 * Whether a scan may be released (HZ-005, HZ-130; clinical review findings 2 to 5 and 8): every
 * value decided; no part twice on one line (never joined); no line's parts without its medicine
 * (never dropped); at least one medicine line; the person's own count of medicine lines on the
 * paper chart matches; every medicine line marked in force or stopped, none unclear; the person on
 * the chart confirmed; the chart's period given and it is the current chart.
 */
export function releaseRefusal(
  fields: readonly OcrField[],
  input: OcrReleaseInput,
): ReleaseRefusal | null {
  if (fields.some((f) => f.state === "unconfirmed")) return "undecided_fields";
  const lines = partsByLine(fields);
  for (const parts of lines.values()) {
    for (const [label, values] of parts) {
      if (label !== "text" && values.length > 1) return "duplicate_part";
    }
    const others = [...parts.keys()].filter((l) => l !== "medicine" && l !== "text");
    if (!parts.has("medicine") && others.length > 0) return "orphan_parts";
  }
  const medicineLines = [...lines.entries()].filter(([, parts]) => parts.has("medicine"));
  if (medicineLines.length === 0) return "no_medicine_lines";
  if (input.linesCounted !== medicineLines.length) return "line_count_differs";
  for (const [line] of medicineLines) {
    const status = input.lineStatuses.get(line);
    if (status === undefined) return "line_status_missing";
    if (status === "cannot_tell") return "line_status_unclear";
  }
  if (!input.personConfirmed) return "person_not_confirmed";
  if (!isoDay(input.chartFrom) || !isoDay(input.chartTo) || input.chartTo < input.chartFrom) {
    return "chart_period";
  }
  if (!input.currentChart) return "not_current_chart";
  return null;
}

/** One part of a released line: what a person decided, and how. */
export interface ScannedPart {
  readonly value: string;
  readonly state: "confirmed" | "corrected";
  /** Typed by a person for something the scan missed. */
  readonly addedByPerson: boolean;
}

/** A medicine line from a released MAR scan, for the medicines module (slice 51). */
export interface ScannedMedicineLine {
  readonly line: number;
  readonly medicine: ScannedPart;
  /** Null when no value stands for the part: not on the chart, or rejected by the person. */
  readonly strength: ScannedPart | null;
  readonly dose: ScannedPart | null;
  readonly route: ScannedPart | null;
  readonly directions: ScannedPart | null;
  readonly prescriber: ScannedPart | null;
  /** Other text a person kept from this line (for example "see INR chart"), never dropped. */
  readonly notes: readonly string[];
  /** Always: OCR is a transcription that a second competent member checks (HZ-005, H-548). */
  readonly origin: "import";
  readonly state: "not_yet_checked";
  readonly secondCheckRequired: true;
}

export interface ScannedChart {
  /** Lines still in force on the chart; stopped ones are listed by number, never released. */
  readonly lines: readonly ScannedMedicineLine[];
  readonly stoppedLines: readonly number[];
  /** Text a person kept that belongs to no medicine line (for example an allergy note). */
  readonly chartNotes: readonly string[];
  /**
   * Everyone who decided a value: none of them may be the second checker of these lines
   * (clinical review finding 7; enforced in slice 51).
   */
  readonly decidedBy: readonly string[];
}

const part = (values: readonly OcrField[] | undefined): ScannedPart | null => {
  const f = values?.[0];
  return f && f.value !== null
    ? { value: f.value, state: f.state as ScannedPart["state"], addedByPerson: f.addedByPerson }
    : null;
};

/**
 * The lines of a scan a person released: confirmed or corrected values only, on the lines and
 * parts a person decided. Never a dm+d product, a dose unit or a schedule: the transcriber still
 * chooses the product from dm+d and enters the dose in slice 51. Empty unless releasable.
 */
export function scannedChart(fields: readonly OcrField[], input: OcrReleaseInput): ScannedChart {
  const empty = { lines: [], stoppedLines: [], chartNotes: [], decidedBy: [] };
  if (releaseRefusal(fields, input) !== null) return empty;
  const lines = partsByLine(fields);
  const chartNotes: string[] = [];
  const out: ScannedMedicineLine[] = [];
  const stoppedLines: number[] = [];
  for (const [line, parts] of [...lines.entries()].sort(([a], [b]) => a - b)) {
    const notes = (parts.get("text") ?? []).map((f) => f.value as string);
    const medicine = part(parts.get("medicine"));
    if (!medicine) {
      chartNotes.push(...notes);
      continue;
    }
    if (input.lineStatuses.get(line) !== "active") {
      stoppedLines.push(line);
      continue;
    }
    out.push({
      line,
      medicine,
      strength: part(parts.get("strength")),
      dose: part(parts.get("dose")),
      route: part(parts.get("route")),
      directions: part(parts.get("directions")),
      prescriber: part(parts.get("prescriber")),
      notes,
      origin: "import",
      state: "not_yet_checked",
      secondCheckRequired: true,
    });
  }
  const decidedBy = [...new Set(fields.map((f) => f.decidedBy).filter((b): b is string => !!b))];
  return { lines: out, stoppedLines, chartNotes, decidedBy };
}
