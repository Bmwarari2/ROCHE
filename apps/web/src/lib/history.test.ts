import { RISK_TEMPLATE_VERSION } from "@harbour/domain";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  CURRENT_RECORD_TAB,
  fieldLabel,
  fieldValue,
  isHistoryTable,
  recordFieldLabel,
  recordFieldValue,
  versionViews,
} from "./history";

const t = createTranslator("en-GB");

describe("record history", () => {
  it("names fields in words from either spelling", () => {
    expect(fieldLabel("review_due_on")).toBe("Review due on");
    expect(fieldLabel("reviewDueOn")).toBe("Review due on");
    expect(fieldLabel("need")).toBe("Need");
  });

  it("shows stored values in words, with UK dates", () => {
    expect(fieldValue(null, t)).toBe("Not recorded");
    expect(fieldValue("", t)).toBe("Not recorded");
    expect(fieldValue(true, t)).toBe("Yes");
    expect(fieldValue(false, t)).toBe("No");
    expect(fieldValue(3, t)).toBe("3");
    expect(fieldValue("2026-11-11", t)).toBe("11/11/2026");
    expect(fieldValue("2026-07-01T13:05:00.000Z", t)).toBe("01/07/2026 14:05");
    expect(fieldValue(["Low bed", "Rail bumpers"], t)).toBe("Low bed; Rail bumpers");
    expect(fieldValue([], t)).toBe("Not recorded");
    expect(fieldValue({ a: 1, walks_alone: true }, t)).toBe("A: 1; Walks alone: Yes");
    expect(fieldValue({}, t)).toBe("Not recorded");
    expect(fieldValue("Walks with a frame", t)).toBe("Walks with a frame");
  });

  it("lists versions newest first, hides bookkeeping and marks what the next version changed", () => {
    const views = versionViews(
      {
        versions: [
          {
            version: 2,
            validFrom: "2026-10-02T09:00:00Z",
            validTo: "2026-10-03T09:00:00Z",
            changedBy: "u1",
            changedByStaff: null,
            data: { id: "x", tenant_id: "t", need: "Two carers", outcome: "Walk daily" },
          },
          {
            version: 1,
            validFrom: "2026-10-01T09:00:00Z",
            validTo: "2026-10-02T09:00:00Z",
            changedBy: null,
            changedByStaff: null,
            data: { id: "x", tenant_id: "t", need: "One carer", outcome: "Walk daily" },
          },
        ],
      },
      t,
    );
    expect(views.map((v) => v.version)).toEqual([2, 1]);
    expect(views.map((v) => v.comparedWith)).toEqual([null, "next"]);
    expect(views[1]?.fields).toEqual([
      { key: "need", label: "Need", value: "One carer", changed: true },
      { key: "outcome", label: "Outcome", value: "Walk daily", changed: false },
    ]);
    expect(views[0]?.fields.every((field) => !field.changed)).toBe(true);
    expect(isHistoryTable("risk_assessment")).toBe(true);
    expect(isHistoryTable("person")).toBe(false);
    expect(CURRENT_RECORD_TAB.risk_assessment).toBe("risk-assessments");
  });

  it("hazard HZ-024 marks what the latest review changed, from the keys the API names", () => {
    const version = (n: number, controls: string[]) => ({
      version: n,
      validFrom: "2026-10-01T09:00:00Z",
      validTo: "2026-10-02T09:00:00Z",
      changedBy: null,
      changedByStaff: null,
      data: { id: "x", version: n, controls, answers: { b: true, a: false }, hazard: "Choking" },
    });
    const views = versionViews(
      {
        table: "risk_assessment",
        versions: [version(1, ["Sit up"]), version(2, ["Supervise"])],
        latestChanged: ["controls", "updated_at", "version"],
      },
      t,
    );
    const changed = (n: number) =>
      views
        .find((v) => v.version === n)
        ?.fields.filter((f) => f.changed)
        .map((f) => f.key);
    // The newest is compared with the record as it is now; the older with the version after it.
    expect(views.map((v) => v.comparedWith)).toEqual(["now", "next"]);
    expect(changed(2)).toEqual(["controls"]);
    expect(changed(1)).toEqual(["controls"]);
    // Nothing changed since, so nothing is marked; key order in stored objects does not count.
    const unchanged = versionViews(
      { versions: [version(1, ["Sit up"]), version(2, ["Sit up"])], latestChanged: [] },
      t,
    );
    expect(unchanged.flatMap((v) => v.fields.filter((f) => f.changed))).toEqual([]);
    // When the API could not compare (saved again while read), the newest version marks nothing.
    for (const latestChanged of [null, undefined]) {
      const unknown = versionViews({ versions: [version(1, ["Sit up"])], latestChanged }, t);
      expect(unknown[0]?.comparedWith).toBeNull();
      expect(unknown[0]?.fields.some((f) => f.changed)).toBe(false);
    }
    // A field the next version no longer has (a dropped column) is not marked as changed.
    const dropped = versionViews(
      {
        versions: [
          { ...version(1, ["Sit up"]), data: { id: "x", hazard: "Choking", legacy: "a" } },
          { ...version(2, ["Sit up"]), data: { id: "x", hazard: "Choking" } },
        ],
        latestChanged: [],
      },
      t,
    );
    expect(dropped[1]?.fields.find((f) => f.key === "legacy")?.changed).toBe(false);
  });

  it("hazard HZ-024 labels a status as the status at the time, never as in use now", () => {
    expect(recordFieldLabel("risk_assessment", "status", t)).toBe("Status at the time");
    expect(recordFieldLabel("person", "status", t)).toBe("Status at the time");
  });

  it.each([
    ["risk_assessment", "active", "In use"],
    ["risk_assessment", "closed", "Closed"],
    ["care_plan", "superseded", "Superseded, not in use"],
    ["advance_care_record", "withdrawn", "Withdrawn"],
    ["person", "on_leave", "On leave"],
  ])("hazard HZ-024 shows the %s status %s as %s", (table, status, words) => {
    expect(recordFieldValue(table, "status", { status }, t)).toBe(words);
  });

  it("hazard HZ-024 shows risk answers as the template's questions, one line each", () => {
    expect(
      recordFieldValue(
        "risk_assessment",
        "answers",
        {
          template_key: "choking",
          template_version: RISK_TEMPLATE_VERSION,
          answers: { needs_supervision: true, unknown_key: false },
        },
        t,
      ),
    ).toEqual([
      "Does the person need someone with them when eating? Yes",
      `Unknown key (asked in template version ${RISK_TEMPLATE_VERSION}): No`,
    ]);
    expect(
      recordFieldValue(
        "risk_assessment",
        "answers",
        { template_key: "nope", answers: { a: 1 } },
        t,
      ),
    ).toEqual(["A: 1"]);
    expect(
      recordFieldValue(
        "risk_assessment",
        "answers",
        {
          template_key: "bed_rails",
          template_version: RISK_TEMPLATE_VERSION,
          answers: { gap_between_bars_mm: 110 },
        },
        t,
      ),
    ).toEqual(["Gap between the bars of the rail: 110 mm"]);
    expect(recordFieldValue("care_plan", "meta", { meta: { reason: "Review" } }, t)).toEqual([
      "Reason: Review",
    ]);
  });

  it("hazard HZ-024 never shows today's question against an answer given under another version", () => {
    const data = {
      template_key: "choking",
      template_version: "harbour-2025-01",
      answers: { needs_supervision: true },
      findings: [
        {
          questionKey: "gap_between_bars_mm",
          valueMm: 110,
          limitMm: 120,
          rule: "under",
          withinLimit: false,
        },
      ],
    };
    expect(recordFieldValue("risk_assessment", "answers", data, t)).toEqual([
      "Needs supervision (asked in template version harbour-2025-01): Yes",
    ]);
    expect(recordFieldValue("risk_assessment", "findings", data, t)).toEqual([
      "Outside the figure: Gap between bars mm (asked in template version harbour-2025-01): 110 mm. It should be under 120 mm.",
    ]);
  });

  it("hazard HZ-024 shows a risk assessment's template, bands and MHRA findings in words", () => {
    const data = {
      template_key: "bed_rails",
      template_version: RISK_TEMPLATE_VERSION,
      risk_rating: 6,
      risk_band: "moderate",
      residual_rating: 3,
      residual_band: "low",
      findings: [
        {
          questionKey: "gap_between_bars_mm",
          valueMm: 110,
          rateKey: "bed_rail.gap_max_mm.between_bars",
          limitMm: 120,
          rule: "under",
          withinLimit: true,
        },
      ],
    };
    expect(recordFieldLabel("risk_assessment", "template_key", t)).toBe("Template");
    expect(recordFieldValue("risk_assessment", "template_key", data, t)).toBe("Bed rails");
    expect(recordFieldValue("risk_assessment", "risk_band", data, t)).toBe(
      "Rating 6: moderate risk",
    );
    expect(recordFieldValue("risk_assessment", "residual_band", data, t)).toBe(
      "After the controls, rating 3: low risk",
    );
    expect(recordFieldValue("risk_assessment", "findings", data, t)).toEqual([
      "Within the figure: Gap between the bars of the rail: 110 mm. It should be under 120 mm.",
    ]);
    expect(recordFieldValue("risk_assessment", "findings", { findings: [] }, t)).toBe(
      "Not recorded",
    );
  });
});
