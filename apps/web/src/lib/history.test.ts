import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import { fieldLabel, fieldValue, isHistoryTable, recordFieldValue, versionViews } from "./history";

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
    expect(fieldValue({ a: 1, walks_alone: true }, t)).toBe("A: 1\nWalks alone: Yes");
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
    expect(views[1]?.fields).toEqual([
      { key: "need", label: "Need", value: "One carer", changedNext: true },
      { key: "outcome", label: "Outcome", value: "Walk daily", changedNext: false },
    ]);
    expect(views[0]?.fields.every((field) => !field.changedNext)).toBe(true);
    expect(isHistoryTable("risk_assessment")).toBe(true);
    expect(isHistoryTable("person")).toBe(false);
  });

  it("hazard HZ-024 marks what the latest review changed, against the record as it is now", () => {
    const version = (n: number, controls: string[]) => ({
      version: n,
      validFrom: "2026-10-01T09:00:00Z",
      validTo: "2026-10-02T09:00:00Z",
      changedBy: null,
      changedByStaff: null,
      data: { id: "x", version: n, controls, answers: { b: true, a: false }, hazard: "Choking" },
    });
    const current = {
      id: "x",
      version: 3,
      controls: ["Supervise", "First aid"],
      answers: { a: false, b: true },
      hazard: "Choking",
    };
    const views = versionViews(
      {
        table: "risk_assessment",
        versions: [version(1, ["Sit up"]), version(2, ["Supervise"])],
        current,
      },
      t,
    );
    const changed = (n: number) =>
      views
        .find((v) => v.version === n)
        ?.fields.filter((f) => f.changedNext)
        .map((f) => f.key);
    expect(changed(2)).toEqual(["controls"]);
    expect(changed(1)).toEqual(["controls"]);
    // Without the current row (an older API), the newest version marks nothing.
    const older = versionViews({ versions: [version(1, ["Sit up"])] }, t);
    expect(older[0]?.fields.some((f) => f.changedNext)).toBe(false);
  });

  it.each([
    ["risk_assessment", "active", "In use"],
    ["risk_assessment", "closed", "Closed"],
    ["care_plan", "superseded", "Superseded, not in use"],
    ["advance_care_record", "withdrawn", "Withdrawn"],
    ["dols_authorisation", "not_granted", "Not granted"],
    ["person", "on_leave", "On leave"],
    ["consent_record", "valid", "valid"],
  ])("shows a %s status of %s as %s", (table, status, words) => {
    expect(recordFieldValue(table, "status", { status }, t)).toBe(words);
  });

  it("shows risk answers against the template's questions", () => {
    expect(
      recordFieldValue(
        "risk_assessment",
        "answers",
        { template_key: "choking", answers: { needs_supervision: true, unknown_key: false } },
        t,
      ),
    ).toMatch(/^.+\? Yes\nUnknown key: No$/);
    expect(
      recordFieldValue(
        "risk_assessment",
        "answers",
        { template_key: "nope", answers: { a: 1 } },
        t,
      ),
    ).toBe("A: 1");
  });
});
