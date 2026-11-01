import { describe, expect, it } from "vitest";
import {
  addedField,
  decideField,
  envelopeTransition,
  inAppSignRefusal,
  type OcrField,
  type OcrLineStatus,
  type OcrReadField,
  type OcrReleaseInput,
  ocrEngineAllowed,
  readFieldsProblem,
  releaseRefusal,
  scannedChart,
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
    [
      "someone else's DocuSign request (they learn nothing about it)",
      { provider: "docusign" as const, memberId: "m2" },
      "not_the_signer",
    ],
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

const field = (over: Partial<OcrField> = {}): OcrField => ({
  id: "f",
  group: 0,
  label: "dose",
  text: "1 tablet",
  confidence: 0.9,
  state: "unconfirmed",
  value: null,
  decidedLine: null,
  decidedLabel: null,
  truncated: false,
  addedByPerson: false,
  decidedBy: null,
  decidedAt: null,
  ...over,
});

/** A value a person kept, on the line and part they decided. */
const kept = (
  line: number,
  label: OcrField["label"],
  value: string,
  state: "confirmed" | "corrected" = "confirmed",
  by = "m1",
): OcrField =>
  field({
    id: `${line}-${label}-${value}`,
    group: line,
    label,
    text: value,
    state,
    value,
    decidedLine: line,
    decidedLabel: label,
    decidedBy: by,
    decidedAt: AT,
  });
const rejected = (line: number, label: OcrField["label"]): OcrField =>
  field({
    id: `${line}-${label}-x`,
    group: line,
    label,
    state: "rejected",
    decidedBy: "m1",
    decidedAt: AT,
  });

const release = (
  over: Partial<OcrReleaseInput> = {},
  statuses: [number, OcrLineStatus][] = [[0, "active"]],
) => ({
  linesCounted: 1,
  lineStatuses: new Map(statuses),
  personConfirmed: true,
  chartFrom: "2026-10-05",
  chartTo: "2026-11-01",
  currentChart: true,
  ...over,
});

describe("hazard HZ-005 OCR values are never facts until a person decides each one", () => {
  it.each([[0], [0.5], [0.99], [1], [7], [Number.NaN]])(
    "a value read with confidence %s starts unconfirmed",
    (confidence) => {
      const [f] = unconfirmedFields(read([{ text: "Paracetamol", confidence }]), newId);
      expect(f).toMatchObject({
        state: "unconfirmed",
        value: null,
        decidedBy: null,
        decidedLine: null,
      });
      expect(f?.confidence).toBeGreaterThanOrEqual(0);
      expect(f?.confidence).toBeLessThanOrEqual(1);
    },
  );

  it("drops empty lines, tidies the text, and marks a text cut short as truncated", () => {
    const fields = unconfirmedFields(
      read([{ text: "  " }, { text: " 500  mg " }, { text: "y".repeat(600) }]),
      newId,
    );
    expect(fields.map((f) => [f.text.length, f.truncated])).toEqual([
      [6, false],
      [500, true],
    ]);
  });

  it.each([
    ["a line below 0", { group: -1 }],
    ["a line that is not whole", { group: 1.5 }],
    ["a line past the last", { group: 200 }],
    ["a label Harbour does not know", { label: "frequency" as OcrField["label"] }],
  ])("hazard HZ-005 refuses a read with %s, never coercing it", (_name, change) => {
    expect(readFieldsProblem(read([{ ...change }]))).toBe("unreadable");
  });

  it.each([
    [
      "confirm keeps the text and the engine's place",
      { action: "confirm" },
      "confirmed",
      "1 tablet",
      0,
      "dose",
    ],
    [
      "correct keeps the person's value",
      { action: "correct", value: "2 tablets" },
      "corrected",
      "2 tablets",
      0,
      "dose",
    ],
    [
      "confirm can move it to the line it is on",
      { action: "confirm", line: 2 },
      "confirmed",
      "1 tablet",
      2,
      "dose",
    ],
    [
      "correct can say what part it is",
      { action: "correct", value: "500 mg", label: "strength" },
      "corrected",
      "500 mg",
      0,
      "strength",
    ],
    [
      "a move alone counts as a correction",
      { action: "correct", value: "1 tablet", line: 1 },
      "corrected",
      "1 tablet",
      1,
      "dose",
    ],
    ["reject keeps no value and no place", { action: "reject" }, "rejected", null, null, null],
  ] as const)(
    "hazard HZ-005 a value's line and part are a person's decision: %s",
    (_n, decision, state, value, line, label) => {
      const out = decideField(field(), decision, "m1", AT);
      expect(out).toMatchObject({
        ok: true,
        field: {
          state,
          value,
          decidedLine: line,
          decidedLabel: label,
          decidedBy: "m1",
          decidedAt: AT,
        },
      });
    },
  );

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
    ["confirming a truncated text", field({ truncated: true }), { action: "confirm" }, "truncated"],
    ["a line past the last", field(), { action: "confirm", line: 999 }, "bad_line"],
  ] as const)("refuses %s", (_name, f, decision, problem) => {
    expect(decideField(f, decision, "m1", AT)).toEqual({ ok: false, problem });
  });

  it("lets a person add a value the scan missed, marked as typed by them", () => {
    expect(
      addedField({ line: 3, label: "medicine", value: " Senna  7.5 mg " }, "n1", "m1", AT),
    ).toMatchObject({
      ok: true,
      field: {
        state: "corrected",
        value: "Senna 7.5 mg",
        decidedLine: 3,
        addedByPerson: true,
        confidence: 0,
      },
    });
    expect(addedField({ line: 3, label: "medicine", value: " " }, "n1", "m1", AT)).toEqual({
      ok: false,
      problem: "value_required",
    });
  });
});

describe("hazard HZ-005 hazard HZ-130 a scan is released only when the chart is fully accounted for", () => {
  const line0 = [kept(0, "medicine", "Paracetamol 500 mg tablets"), kept(0, "dose", "1 tablet")];
  it.each([
    [
      "any value undecided",
      [...line0, field({ group: 1 })],
      {},
      [[0, "active"]],
      "undecided_fields",
    ],
    [
      "two values for one part on a line (never joined)",
      [...line0, kept(0, "dose", "2 tablets")],
      {},
      [[0, "active"]],
      "duplicate_part",
    ],
    [
      "a line's dose with its medicine rejected (never dropped)",
      [...line0, rejected(1, "medicine"), kept(1, "dose", "5 ml")],
      { linesCounted: 1 },
      [[0, "active"]],
      "orphan_parts",
    ],
    [
      "no medicine line at all",
      [kept(0, "text", "Allergies: none known")],
      {},
      [],
      "no_medicine_lines",
    ],
    [
      "a count of lines on the paper that differs",
      line0,
      { linesCounted: 2 },
      [[0, "active"]],
      "line_count_differs",
    ],
    ["a line not marked in force or stopped", line0, {}, [], "line_status_missing"],
    ["a line whose status is unclear", line0, {}, [[0, "cannot_tell"]], "line_status_unclear"],
    [
      "the person on the chart not confirmed",
      line0,
      { personConfirmed: false },
      [[0, "active"]],
      "person_not_confirmed",
    ],
    ["no chart period", line0, { chartFrom: "" }, [[0, "active"]], "chart_period"],
    [
      "a period that ends before it starts",
      line0,
      { chartTo: "2026-10-01" },
      [[0, "active"]],
      "chart_period",
    ],
    [
      "a chart that is not the current one",
      line0,
      { currentChart: false },
      [[0, "active"]],
      "not_current_chart",
    ],
    ["everything accounted for", [...line0, rejected(0, "route")], {}, [[0, "active"]], null],
  ] as const)("%s", (_name, fields, over, statuses, want) => {
    expect(
      releaseRefusal(fields, release(over, statuses as unknown as [number, OcrLineStatus][])),
    ).toBe(want);
  });
});

describe("hazard HZ-005 scanned MAR lines arrive not yet checked, with a second check required", () => {
  it("gives the lines in force, with each part as a person decided it, and keeps notes", () => {
    const chart = scannedChart(
      [
        kept(1, "medicine", "Paracetamol 500 mg tablets"),
        kept(1, "dose", "2 tablets", "corrected", "m2"),
        rejected(1, "route"),
        kept(1, "text", "See PRN protocol"),
        kept(0, "medicine", "Amlodipine 5 mg tablets"),
        kept(2, "medicine", "Simvastatin 40 mg tablets"),
        kept(5, "text", "Allergies: penicillin"),
      ],
      release({ linesCounted: 3 }, [
        [0, "active"],
        [1, "active"],
        [2, "stopped"],
      ]),
    );
    expect(chart.stoppedLines).toEqual([2]);
    expect(chart.chartNotes).toEqual(["Allergies: penicillin"]);
    expect([...chart.decidedBy].sort()).toEqual(["m1", "m2"]);
    expect(chart.lines.map((l) => [l.line, l.medicine.value])).toEqual([
      [0, "Amlodipine 5 mg tablets"],
      [1, "Paracetamol 500 mg tablets"],
    ]);
    expect(chart.lines[1]).toMatchObject({
      dose: { value: "2 tablets", state: "corrected", addedByPerson: false },
      route: null,
      notes: ["See PRN protocol"],
      origin: "import",
      state: "not_yet_checked",
      secondCheckRequired: true,
    });
  });

  it("gives nothing while the scan is not releasable", () => {
    expect(
      scannedChart([kept(0, "medicine", "Paracetamol"), field({ group: 0 })], release()).lines,
    ).toEqual([]);
  });

  it("never uses the text as read when a person corrected it, or the engine's line when they moved it", () => {
    const moved: OcrField = {
      ...kept(1, "dose", "1 tablet", "corrected"),
      group: 0,
      text: "7 tablets",
    };
    const chart = scannedChart(
      [kept(0, "medicine", "Amlodipine"), kept(1, "medicine", "Paracetamol"), moved],
      release({ linesCounted: 2 }, [
        [0, "active"],
        [1, "active"],
      ]),
    );
    expect(chart.lines.map((l) => [l.medicine.value, l.dose?.value ?? null])).toEqual([
      ["Amlodipine", null],
      ["Paracetamol", "1 tablet"],
    ]);
  });
});
