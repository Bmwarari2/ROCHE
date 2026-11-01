import { describe, expect, it } from "vitest";
import {
  decideField,
  envelopeTransition,
  inAppSignRefusal,
  type OcrField,
  type OcrReadField,
  ocrEngineAllowed,
  releaseRefusal,
  scannedMedicineLines,
  unconfirmedFields,
} from "./esign-ocr";

const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);
const AT = new Date("2026-11-01T10:00:00Z");
let n = 0;
const newId = () => `f${++n}`;

describe("in-app signing (ADR-0095)", () => {
  const base = {
    provider: "in_app" as const,
    state: "requested" as const,
    signerId: "m1",
    memberId: "m1",
    stepUpFresh: true,
    requestSha256: HASH,
    currentSha256: HASH,
    sha256Seen: HASH,
  };
  it.each([
    ["the named signer, open, step-up fresh, same bytes", {}, null],
    ["someone else", { memberId: "m2" }, "not_the_signer"],
    ["a request already signed", { state: "signed" as const }, "not_open"],
    ["a cancelled request", { state: "cancelled" as const }, "not_open"],
    ["a document changed since the request", { currentSha256: OTHER }, "document_changed"],
    ["a signer who read another version", { sha256Seen: OTHER }, "document_changed"],
    ["no fresh second factor", { stepUpFresh: false }, "step_up_required"],
    ["a DocuSign request", { provider: "docusign" as const }, "wrong_provider"],
    ["hashes in upper case", { sha256Seen: HASH.toUpperCase() }, null],
  ])("%s", (_name, change, want) => {
    expect(inAppSignRefusal({ ...base, ...change })).toBe(want);
  });
});

describe("external envelope transitions", () => {
  it.each([
    ["sent", "sent", null, null],
    ["sent", "declined", null, "declined"],
    ["sent", "voided", null, "cancelled"],
    ["sent", "completed", "clean", "signed"],
    ["sent", "completed", "infected", null],
    ["sent", "completed", "unavailable", null],
    ["signed", "completed", "clean", null],
    ["cancelled", "declined", null, null],
  ] as const)("%s + %s (scan %s) -> %s", (state, status, scan, want) => {
    expect(envelopeTransition(state, status, scan)).toBe(want);
  });
});

describe("OCR engine allowlist (ADR-0095, ADR-0098)", () => {
  it.each([
    ["google_document_ai", "europe-west2", true],
    ["google_document_ai", "EUROPE-WEST2", true],
    ["google_document_ai", "us", false],
    ["google_document_ai", "eu", false],
    ["mock", "local", true],
    ["mock", "europe-west2", false],
    ["aws_textract", "eu-west-2", false],
    ["__proto__", "local", false],
  ])("%s in %s is %s", (engine, location, want) => {
    expect(ocrEngineAllowed(engine, location)).toBe(want);
  });
});

const read = (fields: Partial<OcrReadField>[]): OcrReadField[] =>
  fields.map((f) => ({ group: 0, label: "text", text: "x", confidence: 0.5, ...f }));

describe("hazard HZ-005 OCR values are never facts until a person decides each one", () => {
  it.each([[0], [0.5], [0.99], [1], [7], [Number.NaN]])(
    "a value read with confidence %s starts unconfirmed",
    (confidence) => {
      const [f] = unconfirmedFields(read([{ text: "Paracetamol", confidence }]), newId);
      expect(f).toMatchObject({ state: "unconfirmed", value: null, decidedBy: null });
      expect(f?.confidence).toBeGreaterThanOrEqual(0);
      expect(f?.confidence).toBeLessThanOrEqual(1);
    },
  );

  it("drops empty lines and tidies the text as read", () => {
    const fields = unconfirmedFields(read([{ text: "  " }, { text: " 500  mg " }]), newId);
    expect(fields.map((f) => f.text)).toEqual(["500 mg"]);
  });

  const field = (over: Partial<OcrField> = {}): OcrField => ({
    id: "f",
    group: 0,
    label: "dose",
    text: "1 tablet",
    confidence: 0.9,
    state: "unconfirmed",
    value: null,
    decidedBy: null,
    decidedAt: null,
    ...over,
  });

  it.each([
    ["confirm keeps the text as read", { action: "confirm" }, "confirmed", "1 tablet"],
    [
      "correct keeps the person's value",
      { action: "correct", value: "2 tablets" },
      "corrected",
      "2 tablets",
    ],
    ["reject keeps no value", { action: "reject" }, "rejected", null],
  ] as const)("%s", (_name, decision, state, value) => {
    const out = decideField(field(), decision, "m1", AT);
    expect(out).toMatchObject({
      ok: true,
      field: { state, value, decidedBy: "m1", decidedAt: AT },
    });
  });

  it.each([
    [
      "a decided field",
      field({ state: "confirmed", value: "1 tablet" }),
      { action: "confirm" },
      "already_decided",
    ],
    ["an empty correction", field(), { action: "correct", value: "  " }, "value_required"],
    [
      "a correction the same as read",
      field(),
      { action: "correct", value: " 1  tablet" },
      "unchanged",
    ],
    [
      "a correction too long",
      field(),
      { action: "correct", value: "x".repeat(501) },
      "value_required",
    ],
  ] as const)("refuses %s", (_name, f, decision, problem) => {
    expect(decideField(f, decision, "m1", AT)).toEqual({ ok: false, problem });
  });

  it.each([
    ["any field undecided", ["confirmed", "unconfirmed"], "undecided_fields"],
    ["every field rejected", ["rejected", "rejected"], "nothing_confirmed"],
    ["no fields at all", [], "nothing_confirmed"],
    ["all decided, one standing", ["rejected", "corrected"], null],
  ] as const)("release with %s", (_name, states, want) => {
    const fields = states.map((state) =>
      field({ state, value: state === "rejected" ? null : "v" }),
    );
    expect(releaseRefusal(fields)).toBe(want);
  });
});

describe("hazard HZ-005 scanned MAR lines arrive not yet checked, with a second check required", () => {
  const f = (
    group: number,
    label: OcrField["label"],
    state: OcrField["state"],
    value: string | null,
  ): OcrField => ({
    id: `${group}${label}`,
    group,
    label,
    text: value ?? "read",
    confidence: 0.95,
    state,
    value,
    decidedBy: state === "unconfirmed" ? null : "m1",
    decidedAt: state === "unconfirmed" ? null : AT,
  });

  it("gives confirmed and corrected values only, line by line", () => {
    const lines = scannedMedicineLines([
      f(1, "medicine", "confirmed", "Paracetamol"),
      f(1, "strength", "confirmed", "500 mg"),
      f(1, "dose", "corrected", "1 tablet"),
      f(1, "route", "rejected", null),
      f(0, "medicine", "corrected", "Amlodipine"),
      f(0, "directions", "confirmed", "Once a day"),
      f(2, "dose", "confirmed", "5 ml"),
    ]);
    expect(lines).toEqual([
      {
        line: 0,
        medicine: "Amlodipine",
        strength: null,
        dose: null,
        route: null,
        directions: "Once a day",
        prescriber: null,
        origin: "import",
        state: "not_yet_checked",
        secondCheckRequired: true,
      },
      {
        line: 1,
        medicine: "Paracetamol",
        strength: "500 mg",
        dose: "1 tablet",
        route: null,
        directions: null,
        prescriber: null,
        origin: "import",
        state: "not_yet_checked",
        secondCheckRequired: true,
      },
    ]);
  });

  it("gives nothing while any value is undecided", () => {
    expect(
      scannedMedicineLines([
        f(0, "medicine", "confirmed", "Paracetamol"),
        f(0, "dose", "unconfirmed", null),
      ]),
    ).toEqual([]);
  });

  it("never uses the text as read when a person corrected it", () => {
    const corrected: OcrField = {
      ...f(0, "medicine", "corrected", "Amlodipine"),
      text: "Amiodarone",
    };
    expect(scannedMedicineLines([corrected])[0]?.medicine).toBe("Amlodipine");
  });
});
