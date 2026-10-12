import { ConsentDecisionKind, DolsStatus } from "@harbour/contracts";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import { consentChip, dolsChip, dolsClock, dolsCqcLine, dolsReminders } from "./mca";

const t = createTranslator("en-GB");

describe("consent by decision (care.md rule 9)", () => {
  it("names every decision the API lists", () => {
    for (const decision of ConsentDecisionKind.options) {
      expect(t("care.mca.decision", { decision })).not.toBe("Other decision");
    }
  });

  it.each([
    ["valid", [], "done", "Consent in place"],
    ["refused", [], "info", "Refused"],
    ["none", ["no_record"], "notRecorded", "Not recorded"],
    ["none", ["withdrawn"], "overdue", "No valid consent"],
    ["none", ["expired"], "overdue", "No valid consent"],
    ["none", ["person_has_capacity_now"], "overdue", "No valid consent"],
  ] as const)("hazard HZ-026 shows %s %j as %s, in words", (status, problems, chip, label) => {
    expect(consentChip({ status, problems: [...problems] }, t)).toMatchObject({
      status: chip,
      label,
    });
  });

  it("hazard HZ-026 never shows an unknown status as consent in place", () => {
    const status = "maybe" as "none";
    expect(consentChip({ status, problems: [] }, t).status).toBe("overdue");
  });
});

describe("DoLS register (care.md rule 11)", () => {
  it("hazard HZ-020 gives every status the API returns an icon and a word, and warns on an unknown one", () => {
    for (const status of DolsStatus.options) {
      const chip = dolsChip(status, t);
      expect(chip.label).not.toBe("Status could not be read");
      expect(chip.icon).toBeTruthy();
    }
    expect(dolsChip("expired", t)).toMatchObject({ status: "overdue", label: "Expired" });
    expect(dolsChip("expiring", t)).toMatchObject({ status: "due", label: "Ending soon" });
    expect(dolsChip("lapsed", t)).toMatchObject({
      status: "overdue",
      label: "Status could not be read",
    });
  });

  const granted = { grantedFrom: "2026-10-05T09:00:00Z", endsAt: "2026-10-12T09:00:00Z" };

  it.each([
    [
      "an urgent authorisation ending soon",
      { ...granted, status: "expiring" as const, daysLeft: 3 },
      ["Started 05/10/2026 10:00", "Ends 12/10/2026 10:00", "3 days left"],
    ],
    [
      "its last day",
      { ...granted, status: "expiring" as const, daysLeft: 0 },
      ["Started 05/10/2026 10:00", "Ends 12/10/2026 10:00", "Last day in force"],
    ],
    [
      "one that has expired",
      { ...granted, status: "expired" as const, daysLeft: null },
      ["Started 05/10/2026 10:00", "Expired 12/10/2026 10:00"],
    ],
    [
      "one that ended early",
      { ...granted, status: "ended" as const, daysLeft: null },
      ["Started 05/10/2026 10:00", "Ended 12/10/2026 10:00"],
    ],
    [
      "one that starts later",
      { ...granted, status: "not_started" as const, daysLeft: 9 },
      ["Starts 05/10/2026 10:00", "Ends 12/10/2026 10:00"],
    ],
    [
      "a court order with no end date",
      { ...granted, endsAt: null, status: "active" as const, daysLeft: null },
      ["Started 05/10/2026 10:00", "No end date"],
    ],
    [
      "a request awaiting its outcome",
      { grantedFrom: null, endsAt: null, status: "requested" as const, daysLeft: null },
      [],
    ],
  ])("hazard HZ-020 shows the clock of %s in words and UK dates", (_name, item, lines) => {
    expect(dolsClock(item, t)).toEqual(lines);
  });

  it("hazard HZ-020 lists the expiry reminders while the authorisation is still to end", () => {
    const reminders = [
      { key: "first" as const, daysBefore: 28, dueAt: "2026-10-05T09:00:00Z" },
      { key: "second" as const, daysBefore: 7, dueAt: "2026-11-01T10:00:00Z" },
    ];
    expect(dolsReminders({ status: "active", reminders }, t)).toEqual([
      "Expiry reminder to the Registered Manager: 05/10/2026 10:00",
      "Expiry reminder to the Registered Manager: 01/11/2026 10:00",
    ]);
    expect(dolsReminders({ status: "expired", reminders }, t)).toEqual([]);
    expect(dolsReminders({ status: "ended", reminders }, t)).toEqual([]);
  });

  it("hazard HZ-020 says where the CQC notification stands, or why there is none", () => {
    const cqc = (over: object) => ({
      cqcNotification: {
        required: true,
        reason: "The outcome is known.",
        notificationId: null,
        status: null,
        dueAt: "2026-10-12T09:00:00Z",
        ...over,
      },
    });
    expect(dolsCqcLine(cqc({ status: "draft" }), t)).toBe(
      "CQC notification drafted. Due 12/10/2026 10:00.",
    );
    expect(dolsCqcLine(cqc({ status: "submitted" }), t)).toBe("CQC notification submitted.");
    expect(dolsCqcLine(cqc({}), t)).toBe(
      "CQC notification needed but not drafted. Tell the Registered Manager.",
    );
    expect(dolsCqcLine(cqc({ required: false, reason: "Not yet." }), t)).toBe("Not yet.");
  });
});
