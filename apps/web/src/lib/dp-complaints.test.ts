import { describe, expect, it } from "vitest";
import { acknowledgementWords, type Complaint, complaintForms, updateWords } from "./dp-complaints";
import { t } from "./i18n";

type Clock = Complaint["clock"];

const clock = (overrides: Partial<Clock> = {}): Clock => ({
  acknowledgeDueOn: "2026-11-30",
  acknowledgeTargetOn: "2026-11-06",
  acknowledgement: "due",
  nextUpdateDueOn: "2026-12-31",
  update: "due",
  ...overrides,
});

describe("PLAT-022 data protection complaints: the acknowledgement clock in words", () => {
  it.each([
    ["due", clock(), null, "due", "Acknowledge by 30/11/2026"],
    [
      "overdue, from the day after it was due",
      clock({ acknowledgement: "overdue" }),
      null,
      "overdue",
      "Acknowledgement overdue since 01/12/2026",
    ],
    [
      "acknowledged",
      clock({ acknowledgement: "done" }),
      "2026-11-02",
      "done",
      "Acknowledged on 02/11/2026",
    ],
    [
      "acknowledged late",
      clock({ acknowledgement: "done_late" }),
      "2026-12-03",
      "done",
      "Acknowledged late, on 03/12/2026",
    ],
    [
      "received before the duty began: the organisation's target",
      clock({ acknowledgement: "not_applicable", acknowledgeDueOn: null }),
      null,
      "due",
      "Acknowledge by 06/11/2026, your organisation's target",
    ],
    [
      "a state the screen does not know",
      clock({ acknowledgement: "paused" as unknown as Clock["acknowledgement"] }),
      null,
      "overdue",
      "Check the clock with Harbour support",
    ],
  ] as const)("%s", (_name, c, acknowledgedOn, status, label) => {
    const got = acknowledgementWords({ clock: c, acknowledgedOn }, t);
    expect(got).toMatchObject({ status, label });
    // Late is done with an alert icon, the same in every register.
    expect(got.late === true).toBe(label.startsWith("Acknowledged late"));
  });
});

describe("PLAT-022 data protection complaints: the next update in words", () => {
  it.each([
    ["due", clock(), null, "due", "Next update due by 31/12/2026"],
    [
      "overdue",
      clock({ update: "overdue" }),
      null,
      "overdue",
      "Update overdue: it was due by 31/12/2026",
    ],
    [
      "closed",
      clock({ update: "closed", nextUpdateDueOn: null }),
      "2026-11-20",
      "done",
      "Closed on 20/11/2026",
    ],
  ] as const)("%s", (_name, c, closedOn, status, label) => {
    expect(updateWords({ clock: c, closedOn }, t)).toEqual({ status, label });
  });
});

describe("PLAT-022 data protection complaints: the forms offered", () => {
  it.each([
    ["open, not acknowledged", "open", null, { acknowledge: true, contact: true, close: false }],
    [
      "open, acknowledged",
      "open",
      "2026-11-02",
      { acknowledge: false, contact: true, close: true },
    ],
    ["closed", "closed", "2026-11-02", { acknowledge: false, contact: false, close: false }],
  ] as const)("%s", (_name, status, acknowledgedOn, forms) => {
    expect(complaintForms({ status, acknowledgedOn })).toEqual(forms);
  });
});
