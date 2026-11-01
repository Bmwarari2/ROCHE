import { describe, expect, it } from "vitest";
import { t } from "./i18n";
import {
  entryChip,
  historyNewestFirst,
  type MedicineEntry,
  mayCheck,
  mayStop,
  medicinesShown,
  type ProductHit,
  readCheck,
  readCompletion,
  readDraft,
  readEntryDecision,
  readItemDecision,
  readQuantity,
  readReconciliationItem,
  readReconciliationSource,
  readStop,
  readTranscription,
} from "./medicines";

/** The medicines record screens (MEDS-001, MEDS-006; medicines.md section 13). */

const NOW = new Date("2026-11-01T12:00:00Z");
const PARACETAMOL: ProductHit = {
  vmpId: "90000011000001104",
  name: "Paracetamol 500mg tablets",
  permittedRoutes: [{ code: "26643006", name: "Oral" }],
  permittedDoseUnits: [
    { code: "428673006", name: "tablet" },
    { code: "258684004", name: "mg" },
  ],
};
const ME = "0194d000-0000-7000-8000-0000000000a1";
const OTHER = "0194d000-0000-7000-8000-0000000000a2";
const LINE = "0194d000-0000-7000-8000-0000000000c1";

const form = (values: Record<string, string | string[]>) => ({
  get: (name: string) => {
    const v = values[name];
    return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
  },
  getAll: (name: string) => {
    const v = values[name];
    return Array.isArray(v) ? v : v === undefined ? [] : [v];
  },
});
const when = (name: string, d: string, m: string, y: string, h = "08", min = "00") => ({
  [`${name}-day`]: d,
  [`${name}-month`]: m,
  [`${name}-year`]: y,
  [`${name}-hour`]: h,
  [`${name}-minute`]: min,
});
const regular = {
  route: "26643006",
  unit: "428673006",
  doseKind: "amount",
  directionsKind: "regular",
  pattern: "every_day",
  "time-1": "08:00",
  "slot-1-quantity": "2",
  "time-2": "20:00",
  "slot-2-quantity": "1.5",
  prescriber: "Dr A Example",
  ...when("startsAt", "02", "11", "2026"),
};

describe("states, each as an icon and a word", () => {
  it.each([
    ["not_yet_checked", "Not yet checked", "due"],
    ["checked", "Checked", "done"],
    ["difference_found", "Difference found", "overdue"],
    ["stopped", "Stopped", "notApplicable"],
    ["replaced", "Replaced", "notApplicable"],
    ["withdrawn", "Withdrawn", "notApplicable"],
  ] as const)("shows %s as %s", (state, word, status) => {
    const chip = entryChip(state, t);
    expect(chip).toMatchObject({ label: word, status });
    expect(chip.icon).toBeTruthy();
  });

  it("opens the tab to any of the API's three readers", () => {
    for (const p of ["medicines.record.manage", "medicines.emar.administer", "care.plan.read"]) {
      expect(medicinesShown([p])).toBe(true);
    }
    expect(medicinesShown(["care.note.read"])).toBe(false);
  });

  it("offers the second check only to someone other than the transcriber, while not yet checked", () => {
    const entry = { state: "not_yet_checked" as const, transcribed: { id: ME, at: "" } };
    const writer = ["medicines.record.manage"];
    expect(mayCheck(entry, ME, writer)).toBe(false);
    expect(mayCheck(entry, OTHER, writer)).toBe(true);
    expect(mayCheck({ ...entry, state: "checked" }, OTHER, writer)).toBe(false);
    expect(mayCheck(entry, OTHER, ["care.plan.read"])).toBe(false);
    expect(mayStop({ state: "withdrawn" }, writer)).toBe(false);
    expect(mayStop({ state: "not_yet_checked" }, writer)).toBe(true);
  });

  it("lists versions newest first", () => {
    const v = (version: number) => ({ version }) as MedicineEntry;
    expect(historyNewestFirst([v(1), v(3), v(2)]).map((e) => e.version)).toEqual([3, 2, 1]);
  });
});

describe("hazard HZ-005 a dose is sent exactly as typed", () => {
  it.each([
    ["2", 2],
    ["0.5", 0.5],
    ["1.125", 1.125],
  ] as const)("keeps %s as %s", (raw, value) => {
    expect(readQuantity(raw)).toBe(value);
  });
  it.each(["0", "1.2345", "-1", "two", "1,5", ""])("refuses %j", (raw) => {
    expect(readQuantity(raw)).toBeNull();
  });

  it("reads regular directions with each time's dose, the unit and route only from dm+d", () => {
    const read = readDraft(form(regular), t, PARACETAMOL, NOW);
    expect(read).toMatchObject({
      ok: true,
      body: {
        product: { vmpId: PARACETAMOL.vmpId, ampId: null, name: "Paracetamol 500mg tablets" },
        route: { code: "26643006", name: "Oral" },
        directions: {
          kind: "regular",
          schedule: {
            pattern: { kind: "every_day" },
            times: [
              { time: "08:00", dose: { kind: "amount", quantity: 2 } },
              { time: "20:00", dose: { kind: "amount", quantity: 1.5 } },
            ],
          },
        },
        prescriber: "Dr A Example",
        stopsAt: null,
        reviewOn: null,
      },
    });
  });

  it("refuses a route or unit dm+d does not permit, and no product at all", () => {
    expect(readDraft(form({ ...regular, route: "34206005" }), t, PARACETAMOL, NOW)).toMatchObject({
      ok: false,
      errors: { route: expect.any(String) },
    });
    expect(readDraft(form({ ...regular, unit: "258773002" }), t, PARACETAMOL, NOW)).toMatchObject({
      ok: false,
      errors: { unit: expect.any(String) },
    });
    expect(readDraft(form(regular), t, null, NOW)).toMatchObject({
      ok: false,
      errors: { product: expect.any(String) },
    });
  });

  it("reads a when-required range and weekly days, and refuses a repeated time", () => {
    const prn = readDraft(
      form({
        ...regular,
        directionsKind: "when_required",
        doseKind: "range",
        "prn-from": "1",
        "prn-to": "2",
      }),
      t,
      PARACETAMOL,
      NOW,
    );
    expect(prn).toMatchObject({
      ok: true,
      body: { directions: { kind: "when_required", dose: { kind: "range", from: 1, to: 2 } } },
    });
    const weekly = readDraft(
      form({
        ...regular,
        pattern: "weekly",
        weekdays: ["mon", "thu", "funday"],
        intervalWeeks: "1",
        "anchorOn-day": "02",
        "anchorOn-month": "11",
        "anchorOn-year": "2026",
      }),
      t,
      PARACETAMOL,
      NOW,
    );
    expect(weekly).toMatchObject({
      ok: true,
      body: {
        directions: {
          schedule: {
            pattern: { kind: "weekly", weekdays: ["mon", "thu"], anchorOn: "2026-11-02" },
          },
        },
      },
    });
    expect(readDraft(form({ ...regular, "time-2": "08:00" }), t, PARACETAMOL, NOW)).toMatchObject({
      ok: false,
      errors: { "time-1": expect.any(String) },
    });
  });

  it("needs the source's kind and reference to transcribe", () => {
    expect(readTranscription(form(regular), t, PARACETAMOL, NOW)).toMatchObject({
      ok: false,
      errors: { sourceKind: expect.any(String), sourceReference: expect.any(String) },
    });
    expect(
      readTranscription(
        form({ ...regular, sourceKind: "prescription", sourceReference: "FP10 01/11/2026" }),
        t,
        PARACETAMOL,
        NOW,
      ),
    ).toMatchObject({
      ok: true,
      body: { source: { kind: "prescription", reference: "FP10 01/11/2026", documentId: null } },
    });
  });
});

describe("the second check and stopping", () => {
  it("needs the source compared and an outcome; a difference in words", () => {
    expect(readCheck(form({ outcome: "matches_source" }), t)).toMatchObject({
      ok: false,
      errors: { comparedWithSource: expect.any(String) },
    });
    expect(
      readCheck(form({ comparedWithSource: "yes", outcome: "differs_from_source" }), t),
    ).toMatchObject({ ok: false, errors: { difference: expect.any(String) } });
    expect(readCheck(form({ comparedWithSource: "yes", outcome: "matches_source" }), t)).toEqual({
      ok: true,
      body: { outcome: "matches_source", difference: null, comparedWithSource: true },
    });
  });

  it("stops with when, why and the instruction's source, at the version read", () => {
    expect(
      readStop(
        form({
          ...when("effectiveAt", "01", "11", "2026", "12", "00"),
          reason: "Stopped by the GP",
          sourceKind: "prescriber_instruction",
          sourceReference: "Phone call 01/11/2026",
        }),
        t,
        3,
        NOW,
      ),
    ).toMatchObject({ ok: true, body: { reason: "Stopped by the GP", expectedVersion: 3 } });
    expect(readStop(form({}), t, 3, NOW)).toMatchObject({
      ok: false,
      errors: { effectiveAt: expect.any(String), reason: expect.any(String) },
    });
  });
});

describe("reconciliation: a person decides every entry and line", () => {
  it("reads a source and a line as written", () => {
    expect(
      readReconciliationSource(
        form({
          sourceKind: "discharge_letter",
          sourceReference: "Ward 7 letter",
          ...when("receivedAt", "01", "11", "2026", "09", "00"),
        }),
        t,
        NOW,
      ),
    ).toMatchObject({ ok: true, body: { kind: "discharge_letter", currentBecause: null } });
    const sources = new Set(["0194d000-0000-7000-8000-0000000000b1"]);
    expect(
      readReconciliationItem(
        form({
          sourceId: "0194d000-0000-7000-8000-0000000000b1",
          asWritten: "Paracetamol 1g QDS",
          says: "stop",
        }),
        t,
        sources,
        null,
      ),
    ).toMatchObject({ ok: true, body: { says: "stop", product: null } });
  });

  it("never decides for the person: no choice is refused", () => {
    expect(readEntryDecision(form({}), t, ME, new Set(), null, NOW)).toMatchObject({
      ok: false,
      errors: { decision: expect.any(String) },
    });
    expect(readItemDecision(form({}), t, LINE, null, NOW)).toMatchObject({
      ok: false,
      errors: { decision: expect.any(String) },
    });
  });

  it("reads each decision with only the offered lines, and a stop needs a reason", () => {
    expect(
      readEntryDecision(
        form({ decision: "continue", itemIds: [LINE, "not-offered"] }),
        t,
        ME,
        new Set([LINE]),
        null,
        NOW,
      ),
    ).toMatchObject({ ok: true, body: { kind: "continue", entryId: ME, itemIds: [LINE] } });
    expect(
      readEntryDecision(form({ decision: "stop" }), t, ME, new Set(), null, NOW),
    ).toMatchObject({ ok: false, errors: { reason: expect.any(String) } });
    expect(
      readItemDecision(
        form({ decision: "not_started", reason: "GP says not needed" }),
        t,
        LINE,
        null,
        NOW,
      ),
    ).toEqual({
      ok: true,
      body: { kind: "not_started", itemId: LINE, reason: "GP says not needed" },
    });
  });

  it("completes only with allergies compared and the person's involvement", () => {
    expect(readCompletion(form({}), t, 4)).toMatchObject({
      ok: false,
      errors: { allergiesCompared: expect.any(String), involved: expect.any(String) },
    });
    expect(readCompletion(form({ allergiesCompared: "yes", involved: "no" }), t, 4)).toMatchObject({
      ok: false,
      errors: { notInvolvedReason: expect.any(String) },
    });
    expect(readCompletion(form({ allergiesCompared: "yes", involved: "yes" }), t, 4)).toEqual({
      ok: true,
      body: {
        expectedVersion: 4,
        allergiesCompared: true,
        personInvolvement: { involved: true },
        noDischargeLetterReason: null,
      },
    });
  });
});
