import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  CONTENT_KEY_MAX,
  CONTENT_NOTES,
  contentFields,
  incidentManageView,
  manageDone,
  manageResult,
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
  } = {},
) {
  return {
    status: overrides.status ?? "open",
    raisedBy: RAISER,
    restricted: overrides.restricted ?? false,
    openQuestionCount: overrides.openQuestionCount ?? 0,
    classifier: { notifications: overrides.notifications ?? [] } as never,
  };
}

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

  it("hazard HZ-013 never offers close to the manager who raised it", () => {
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

describe("readSubmitForm (HZ-090: no time assumed)", () => {
  it("asks when it was submitted and the reference, with nothing chosen", () => {
    expect(readSubmitForm(form({}), NOW, t)).toEqual({
      ok: false,
      errors: {
        submittedAt: "Say when it was submitted: just now, or earlier with the date and time",
        externalReference: "Enter the regulator's reference in at most 120 characters",
      },
    });
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

  it("never says someone else changed it after a conflict, which may be your own retry", () => {
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
  });
});
