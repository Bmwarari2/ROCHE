import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import { fieldLabel, fieldValue, isHistoryTable, versionViews } from "./history";

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
    expect(fieldValue({ a: 1 }, t)).toBe('{"a":1}');
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
            data: { id: "x", tenant_id: "t", need: "Two carers", outcome: "Walk daily" },
          },
          {
            version: 1,
            validFrom: "2026-10-01T09:00:00Z",
            validTo: "2026-10-02T09:00:00Z",
            changedBy: null,
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
});
