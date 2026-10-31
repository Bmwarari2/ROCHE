import { describe, expect, it } from "vitest";
import {
  bundleBlocker,
  clockView,
  decisionChip,
  dsarProblem,
  fieldText,
  partName,
  splitHighlights,
} from "./dsar";
import { t } from "./i18n";

const clock = (state: string, extra: Record<string, unknown> = {}) =>
  ({
    state,
    startedOn: "2026-10-01",
    dueOn: "2026-11-01",
    originalDueOn: "2026-11-01",
    pausedDays: 0,
    extended: false,
    late: null,
    ...extra,
  }) as never;

describe("PLAT-022 the DSAR clock in words, never colour alone", () => {
  it.each([
    [
      "awaiting_identity",
      "info",
      "Clock not started",
      "The clock starts when you confirm who is asking.",
    ],
    ["running", "due", "Running", "Respond by 01/11/2026."],
    ["due_soon", "due", "Due soon", "Respond by 01/11/2026. This is soon."],
    ["overdue", "overdue", "Overdue", "Overdue: the response was due on 01/11/2026. Respond now."],
    ["paused", "neutral", "Paused", "Paused while you wait"],
  ])("%s", (state, status, label, words) => {
    const view = clockView(clock(state), null, t);
    expect(view.status).toBe(status);
    expect(view.label).toBe(label);
    expect(view.words).toContain(words);
  });

  it("a closed case says when it was answered, and a late one stays marked overdue", () => {
    expect(clockView(clock("closed", { late: false }), "2026-10-20", t)).toEqual({
      status: "done",
      label: "Responded",
      words: "Responded on 20/10/2026.",
    });
    expect(clockView(clock("closed", { late: true }), "2026-11-05", t).status).toBe("overdue");
  });

  it("a clock the API could not work out says so", () => {
    const view = clockView(null, null, t);
    expect(view.status).toBe("notRecorded");
    expect(view.words).toBe("Harbour could not work out the clock. Check the dates.");
  });
});

describe("PLAT-022 the steps of a request", () => {
  const base = {
    identityRequired: true,
    identityVerifiedOn: "2026-10-02",
    collectedAt: "2026-10-03T10:00:00Z",
    items: { total: 3, pending: 0, disclosed: 2, withheld: 1 },
  };
  it.each([
    [{ ...base, identityVerifiedOn: null }, "identity"],
    [{ ...base, identityRequired: false, identityVerifiedOn: null }, null],
    [{ ...base, collectedAt: null }, "collect"],
    [{ ...base, items: { ...base.items, total: 0 } }, "collect"],
    [{ ...base, items: { ...base.items, pending: 1 } }, "pending"],
    [base, null],
  ])("%o -> %s", (c, blocker) => {
    expect(bundleBlocker(c)).toBe(blocker);
  });
});

describe("PLAT-022 decisions, parts and values", () => {
  it.each([
    ["pending", "due", "To review"],
    ["disclose", "done", "Send"],
    ["redact", "info", "Send with parts taken out"],
    ["withhold", "neutral", "Hold back"],
  ])("decision %s", (decision, status, label) => {
    expect(decisionChip(decision, t)).toEqual({ status, label });
  });

  it("names parts of the record in words", () => {
    expect(partName("care_note")).toBe("Care note");
    expect(partName("public.body_map_mark")).toBe("Body map mark");
  });

  it("shows values as text", () => {
    expect(fieldText(null)).toBeNull();
    expect(fieldText("")).toBeNull();
    expect(fieldText(3)).toBe("3");
    expect(fieldText(false)).toBe("false");
    expect(fieldText({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("splits text at other people's names, ignoring offsets that do not fit", () => {
    expect(
      splitHighlights("Seen by Ada Example and Bo Example.", [
        { start: 24, end: 34 },
        { start: 8, end: 19 },
        { start: 10, end: 12 },
        { start: 30, end: 99 },
      ]),
    ).toEqual([
      { text: "Seen by ", name: false },
      { text: "Ada Example", name: true },
      { text: " and ", name: false },
      { text: "Bo Example", name: true },
      { text: ".", name: false },
    ]);
  });
});

describe("PLAT-022 the API's refusals in plain words", () => {
  it.each([
    [{ code: "dsar_identity_not_verified" }, "Confirm who is asking before you respond."],
    [{ code: "dsar_record_changed" }, "This record changed after you opened it."],
    [{ code: "invalid", detail: "request_shape_refused" }, "Some details do not fit together."],
    [{ code: "invalid", detail: "A pause is already open." }, "A pause is already open."],
    [{ code: "version_conflict" }, ""],
  ])("%o", (error, words) => {
    expect(dsarProblem(error, t).message).toContain(words);
  });

  it("ties a coded refusal to its field", () => {
    expect(dsarProblem({ code: "invalid", detail: "outcome_reason_required" }, t).fields).toEqual({
      outcomeReason: "Give the reason for sending it in part or refusing it.",
    });
  });
});
