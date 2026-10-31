import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  CONTENT_KEY_MAX,
  CONTENT_NOTES,
  contentFields,
  doneToShow,
  followUpDoneToShow,
  incidentManageView,
  judgedNeeded,
  manageDone,
  manageResult,
  NEEDED_REASON_MIN,
  notificationManageView,
  readPrepareForm,
  readReason,
  readSubmitForm,
} from "./incident-review";

const t = createTranslator("en-GB");
const RAISER = "0194d000-0000-7000-8000-00000000a001";
const MANAGER = "0194d000-0000-7000-8000-00000000a002";
const NOW = new Date("2026-10-16T09:30:00Z");
const MANAGE = ["safety.incident.read", "safety.incident.manage"];

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(entries)) data.append(name, value);
  return data;
}

type Status = "draft" | "ready" | "submitted" | "not_required";
const notification = (id: string, kind: string, status: Status) => ({ id, kind, status }) as never;

function incident(
  overrides: {
    status?: "open" | "under_review" | "closed";
    restricted?: boolean;
    openQuestionCount?: number;
    notifications?: readonly never[];
    outputs?: readonly string[];
    affected?: readonly string[];
  } = {},
) {
  return {
    status: overrides.status ?? "open",
    raisedBy: RAISER,
    restricted: overrides.restricted ?? false,
    openQuestionCount: overrides.openQuestionCount ?? 0,
    classifier: {
      notifications: overrides.notifications ?? [],
      outputs: (overrides.outputs ?? []).map((kind) => ({ kind })),
    } as never,
    people: (overrides.affected ?? []).map((personId) => ({
      kind: "service_user",
      role: "affected",
      personId,
    })) as never,
  };
}

const NO_CANDOUR = { noRecord: false, open: false, stillToTell: [], unknown: false };

describe("incidentManageView (safety.md rule 11, HZ-013)", () => {
  const manager = { tenantUserId: MANAGER, permissions: MANAGE };

  it.each([
    [
      "no manage permission",
      incident(),
      { tenantUserId: MANAGER, permissions: ["safety.incident.read"] },
    ],
    ["a closed incident", incident({ status: "closed" }), manager],
    ["an incident the reader cannot see whole", incident({ restricted: true }), manager],
  ])("offers nothing for %s", (_, item, viewer) => {
    expect(incidentManageView(item, viewer)).toBeNull();
  });

  it("offers starting the review and closing on an open incident", () => {
    expect(incidentManageView(incident(), manager)).toEqual({
      review: "under_review",
      close: { kind: "form" },
    });
  });

  it("offers sending it back to open while under review", () => {
    expect(incidentManageView(incident({ status: "under_review" }), manager)?.review).toBe("open");
  });

  it("hazard HZ-013 hazard HZ-091 never offers close to the manager who raised it", () => {
    const view = incidentManageView(incident(), { tenantUserId: RAISER, permissions: MANAGE });
    expect(view).toEqual({ review: "under_review", close: { kind: "raisedByYou" } });
  });

  it("hazard HZ-013 says what to do first while a notification is open or a question unanswered", () => {
    const view = incidentManageView(
      incident({
        openQuestionCount: 2,
        notifications: [
          notification("n1", "cqc_reg18_serious_injury", "draft"),
          notification("n2", "riddor_death", "ready"),
          notification("n3", "safeguarding_s42", "submitted"),
          notification("n4", "leder", "not_required"),
        ],
      }),
      manager,
    );
    expect(view?.close).toEqual({
      kind: "blocked",
      notifications: [
        { id: "n1", kind: "cqc_reg18_serious_injury" },
        { id: "n2", kind: "riddor_death" },
      ],
      questions: 2,
      candour: NO_CANDOUR,
    });
  });

  it.each([
    ["threshold_assessment", true],
    ["verbal_due", true],
    ["written_due", true],
    ["enquiries_open", true],
    ["not_notifiable", false],
    ["no_contact", false],
    ["closed", false],
  ])(
    "hazard HZ-013 hazard HZ-091 says the duty of candour record at %s must finish first: %s",
    (state, open) => {
      const view = incidentManageView(incident(), manager, {
        state: state as never,
        threshold: null,
        personId: null,
      });
      expect(view?.close).toEqual(
        open
          ? {
              kind: "blocked",
              notifications: [],
              questions: 0,
              candour: { ...NO_CANDOUR, open: true },
            }
          : { kind: "form" },
      );
    },
  );

  it("hazard HZ-013 hazard HZ-091 says a duty of candour Harbour found needs a record first (review H2)", () => {
    const view = incidentManageView(
      incident({ outputs: ["candour"], affected: ["ada"] }),
      manager,
      null,
    );
    expect(view?.close).toEqual({
      kind: "blocked",
      notifications: [],
      questions: 0,
      candour: { ...NO_CANDOUR, noRecord: true },
    });
    // A candour notification decided not required, with no output, needs nothing more.
    const decided = incidentManageView(
      incident({
        notifications: [notification("c", "candour", "not_required")],
        affected: ["ada"],
      }),
      manager,
      null,
    );
    expect(decided?.close).toEqual({ kind: "form" });
  });

  it("hazard HZ-013 hazard HZ-091 names who is still to be told when two people were harmed (review H1)", () => {
    const view = incidentManageView(
      incident({ outputs: ["candour"], affected: ["ada", "ben"] }),
      manager,
      { state: "closed", threshold: null, personId: "ada" },
    );
    expect(view?.close).toEqual({
      kind: "blocked",
      notifications: [],
      questions: 0,
      candour: { ...NO_CANDOUR, stillToTell: ["ben"] },
    });
  });

  it("hazard HZ-013 keeps close blocked while the candour record could not be read (review M3)", () => {
    const view = incidentManageView(incident(), manager, "unread");
    expect(view?.close).toEqual({
      kind: "blocked",
      notifications: [],
      questions: 0,
      candour: { ...NO_CANDOUR, unknown: true },
    });
  });

  it("offers close once every notification is submitted or decided", () => {
    const view = incidentManageView(
      incident({ notifications: [notification("n3", "safeguarding_s42", "submitted")] }),
      manager,
    );
    expect(view?.close).toEqual({ kind: "form" });
  });
});

describe("notificationManageView (ADR-0071)", () => {
  const both = ["safety.incident.manage", "safety.notification.submit"];

  it.each<[string, Status, readonly string[], readonly string[] | null, object]>([
    [
      "a draft, both held",
      "draft",
      both,
      null,
      { prepare: true, submit: false, notRequired: true },
    ],
    [
      "a ready one, both held",
      "ready",
      both,
      null,
      { prepare: true, submit: true, notRequired: true },
    ],
    [
      "a submitted one",
      "submitted",
      both,
      null,
      { prepare: false, submit: false, notRequired: false },
    ],
    [
      "a decided one",
      "not_required",
      both,
      null,
      { prepare: false, submit: false, notRequired: false },
    ],
    [
      "manage only",
      "ready",
      ["safety.incident.manage"],
      null,
      { prepare: true, submit: false, notRequired: false },
    ],
    [
      "submit held but not reaching the person",
      "ready",
      both,
      ["safety.incident.manage"],
      { prepare: true, submit: false, notRequired: false },
    ],
    [
      "a person the reader cannot open",
      "ready",
      both,
      [],
      { prepare: false, submit: false, notRequired: false },
    ],
    [
      "reaching but not held",
      "ready",
      ["safety.incident.manage"],
      both,
      { prepare: true, submit: false, notRequired: false },
    ],
  ])("%s", (_, status, permissions, reaching, expected) => {
    expect(notificationManageView({ status }, permissions, reaching)).toEqual(expected);
  });
});

describe("readReason", () => {
  it.each(["", "ok", "x".repeat(1001)])("refuses %j with words for its purpose", (reason) => {
    expect(readReason(form({ reason }), t, "close")).toEqual({
      ok: false,
      errors: {
        reason: "Say why the incident can close, in at least 3 characters and at most 1,000",
      },
    });
  });

  it("takes a trimmed reason", () => {
    expect(readReason(form({ reason: "  Repaired.  " }), t, "notRequired")).toEqual({
      ok: true,
      reason: "Repaired.",
    });
  });
});

describe("not required on a notification Harbour found needed", () => {
  it("hazard HZ-013 is judged needed only when neither provisional nor no longer indicated", () => {
    expect(judgedNeeded({ provisional: false, noLongerIndicated: false })).toBe(true);
    expect(judgedNeeded({ provisional: true, noLongerIndicated: false })).toBe(false);
    expect(judgedNeeded({ provisional: false, noLongerIndicated: true })).toBe(false);
  });

  it("hazard HZ-013 hazard HZ-091 needs a longer reason and the confirmation ticked", () => {
    const options = { min: NEEDED_REASON_MIN, confirm: true };
    expect(readReason(form({ reason: "Not needed." }), t, "notRequiredNeeded", options)).toEqual({
      ok: false,
      errors: {
        reason:
          "Harbour found this notification is needed: say which facts mean the law does not need it, in at least 20 characters and at most 1,000",
        confirm: t("safety.manage.confirmError"),
      },
    });
    const reason = "The police attended for a visitor, not the person.";
    expect(readReason(form({ reason }), t, "notRequiredNeeded", options)).toMatchObject({
      ok: false,
      errors: { confirm: t("safety.manage.confirmError") },
    });
    expect(readReason(form({ reason, confirm: "yes" }), t, "notRequiredNeeded", options)).toEqual({
      ok: true,
      reason,
    });
  });

  it("keeps the short reason for a provisional draft", () => {
    expect(readReason(form({ reason: "Not needed." }), t, "notRequired")).toEqual({
      ok: true,
      reason: "Not needed.",
    });
  });
});

describe("doneToShow", () => {
  it("hazard HZ-091 announces what was done only while the status still matches", () => {
    expect(doneToShow("closed", "closed")).toBe("closed");
    expect(doneToShow("closed", "open")).toBeNull();
    expect(doneToShow("submitted", "submitted")).toBe("submitted");
    expect(doneToShow("submitted", "ready")).toBeNull();
    expect(doneToShow("saved", "ready")).toBe("saved");
    expect(doneToShow(null, "open")).toBeNull();
    // A candour or investigation form's done is never said against the incident's status.
    expect(doneToShow("candourSaved", "open")).toBeNull();
  });

  it("hazard HZ-091 announces a candour or investigation form only while what it did holds", () => {
    expect(followUpDoneToShow("candourSaved", "threshold_assessment", null)).toBe("candourSaved");
    expect(followUpDoneToShow("candourSaved", null, null)).toBeNull();
    expect(followUpDoneToShow("candourMoved", "verbal_due", null)).toBe("candourMoved");
    expect(followUpDoneToShow("candourMoved", "threshold_assessment", null)).toBeNull();
    expect(followUpDoneToShow("investigationSaved", null, "open")).toBe("investigationSaved");
    expect(followUpDoneToShow("investigationCompleted", null, "completed")).toBe(
      "investigationCompleted",
    );
    expect(followUpDoneToShow("investigationCompleted", null, "open")).toBeNull();
    expect(followUpDoneToShow("investigationReopened", null, "open")).toBe("investigationReopened");
    expect(followUpDoneToShow("closed", "closed", "completed")).toBeNull();
  });
});

describe("the prepared form", () => {
  const lines = [
    "A description of the circumstances of the death (reg 16(3))",
    "A description of the circumstances of the death (reg 16(3))",
    "y".repeat(100),
  ];

  it("asks each line once, keyed by its words cut to 80 characters, then a free field", () => {
    const fields = contentFields(lines);
    expect(fields.map((f) => f.key)).toEqual([
      lines[0],
      "y".repeat(CONTENT_KEY_MAX),
      CONTENT_NOTES,
    ]);
    expect(fields.at(-1)?.line).toBeNull();
  });

  it("hazard HZ-013 needs every line before it is marked ready, not to save a draft", () => {
    const fields = contentFields(lines);
    const values = form({ "content-0": "Found at 06:10.", "content-notes": "" });
    expect(readPrepareForm(values, fields, false, t)).toEqual({
      ok: true,
      content: { [lines[0] as string]: "Found at 06:10." },
    });
    expect(readPrepareForm(values, fields, true, t)).toEqual({
      ok: false,
      errors: { "content-1": "Answer this before marking it ready, or save it as a draft" },
    });
  });

  it("refuses an answer over 8,000 characters", () => {
    const read = readPrepareForm(
      form({ "content-notes": "z".repeat(8001) }),
      contentFields([]),
      false,
      t,
    );
    expect(read).toEqual({
      ok: false,
      errors: { "content-notes": "Write this in at most 8,000 characters" },
    });
  });
});

describe("hazard HZ-091 readSubmitForm (HZ-090: no time assumed)", () => {
  it("asks when it was submitted and the reference, with nothing chosen", () => {
    expect(readSubmitForm(form({}), NOW, t)).toEqual({
      ok: false,
      errors: {
        submittedAt: "Say when it was submitted: just now, or earlier with the date and time",
        externalReference: "Enter the regulator's reference in at most 120 characters",
      },
    });
  });

  it("hazard HZ-091 asks no regulator's reference for a duty of candour notification (review H2)", () => {
    expect(
      readSubmitForm(form({ "submittedAt-mode": "now" }), NOW, t, { reference: false }),
    ).toEqual({ ok: true, submittedAt: null, externalReference: "" });
  });

  it("leaves just now to the server", () => {
    expect(
      readSubmitForm(form({ "submittedAt-mode": "now", externalReference: " CQC-123 " }), NOW, t),
    ).toEqual({ ok: true, submittedAt: null, externalReference: "CQC-123" });
  });

  it("reads an earlier time in UK time, 24-hour", () => {
    const read = readSubmitForm(
      form({
        "submittedAt-mode": "earlier",
        "submittedAt-day": "16",
        "submittedAt-month": "10",
        "submittedAt-year": "2026",
        "submittedAt-hour": "08",
        "submittedAt-minute": "05",
        externalReference: "CQC-123",
      }),
      NOW,
      t,
    );
    expect(read).toEqual({
      ok: true,
      submittedAt: "2026-10-16T07:05:00.000Z",
      externalReference: "CQC-123",
    });
  });

  const at = (day: string, month: string, hour: string, minute: string, extra = {}) =>
    form({
      "submittedAt-mode": "earlier",
      "submittedAt-day": day,
      "submittedAt-month": month,
      "submittedAt-year": "2026",
      "submittedAt-hour": hour,
      "submittedAt-minute": minute,
      externalReference: "CQC-123",
      ...extra,
    });

  it("hazard HZ-091 allows no time after now, as the API allows none", () => {
    // 10:31 UK time is one minute after NOW (09:30Z is 10:30 BST).
    expect(readSubmitForm(at("16", "10", "10", "31"), NOW, t).ok).toBe(false);
    expect(readSubmitForm(at("16", "10", "10", "30"), NOW, t).ok).toBe(true);
  });

  it("hazard HZ-091 refuses a time skipped when the clocks went forward in March", () => {
    const read = readSubmitForm(at("29", "03", "01", "30"), NOW, t);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.parts?.submittedAt).toEqual(["hour", "minute"]);
  });

  it("hazard HZ-091 asks which time in the hour the clocks went back in October", () => {
    const later = new Date("2026-11-01T12:00:00Z");
    const read = readSubmitForm(at("25", "10", "01", "30"), later, t);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.parts?.submittedAt).toEqual(["fold"]);
    expect(
      readSubmitForm(at("25", "10", "01", "30", { "submittedAt-fold": "first" }), later, t),
    ).toMatchObject({ ok: true, submittedAt: "2026-10-25T00:30:00.000Z" });
    expect(
      readSubmitForm(at("25", "10", "01", "30", { "submittedAt-fold": "second" }), later, t),
    ).toMatchObject({ ok: true, submittedAt: "2026-10-25T01:30:00.000Z" });
  });

  it("refuses a time in the future, at its boxes", () => {
    const read = readSubmitForm(
      form({
        "submittedAt-mode": "earlier",
        "submittedAt-day": "17",
        "submittedAt-month": "10",
        "submittedAt-year": "2026",
        "submittedAt-hour": "08",
        "submittedAt-minute": "05",
        externalReference: "CQC-123",
      }),
      NOW,
      t,
    );
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.errors.submittedAt).toMatch(/^The time it was submitted is later than now/);
      expect(read.parts?.submittedAt).toBeDefined();
    }
  });
});

describe("manageDone and manageResult", () => {
  it("knows only its own values", () => {
    expect(manageDone("closed")).toBe("closed");
    expect(manageDone("deleted")).toBeNull();
    expect(manageDone(["closed"])).toBeNull();
    expect(manageDone(undefined)).toBeNull();
  });

  it("hazard HZ-091 never says someone else changed it after a conflict, which may be your own retry", () => {
    const result = manageResult(
      { ok: false, code: "version_conflict", message: t("care.errors.conflict") },
      t,
    );
    expect(result).toMatchObject({ ok: false, message: t("safety.manage.conflict") });
    expect(t("safety.manage.conflict")).not.toMatch(/someone else/i);
  });

  it("says each thing done in words", () => {
    for (const done of ["reviewing", "closed", "submitted", "notRequired"] as const) {
      expect(t("safety.manage.done", { done })).not.toBe("Saved");
    }
    for (const done of [
      "candourSaved",
      "investigationSaved",
      "investigationCompleted",
      "investigationReopened",
    ] as const) {
      expect(t("safety.followUp.done", { done, state: "none" })).not.toBe("Saved");
    }
    expect(t("safety.followUp.done", { done: "candourMoved", state: "verbal_due" })).toBe(
      "Duty of candour: tell the person in person next",
    );
  });
});
