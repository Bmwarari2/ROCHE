import { describe, expect, it } from "vitest";
import { availableTransitions } from "../platform/workflow";
import {
  checkPersonRecordWrite,
  checkPersonStatusChange,
  isPersonStatus,
  LIVE_PERSON_STATUSES,
  PERSON_LIFECYCLE,
  PERSON_RECORD_KINDS,
  PERSON_STATUS_RULES,
  PERSON_STATUSES,
  type PersonLifecycleView,
  type PersonRecordKind,
  type PersonStatus,
  type PersonStatusChangeRequest,
  POST_EVENT_RECORD_KINDS,
  personStatusAllows,
} from "./lifecycle";

const NOW = new Date("2026-10-11T10:00:00Z");
const EARLIER = new Date("2026-10-11T08:00:00Z");
const ADMITTED = new Date("2026-09-01T11:00:00Z");

const manager = new Set([
  "people.enquiry.manage",
  "people.admission.manage",
  "people.movement.record",
]);
const nightSenior = new Set(["people.movement.record"]);

function person(
  status: PersonStatus,
  extra: Partial<PersonLifecycleView> = {},
): PersonLifecycleView {
  return { status, createdBy: "admin-1", statusChangedAt: ADMITTED, deceasedAt: null, ...extra };
}

function change(
  to: PersonStatus,
  extra: Partial<PersonStatusChangeRequest> = {},
): PersonStatusChangeRequest {
  return {
    to,
    actorId: "manager-1",
    permissions: manager,
    stepUpFresh: false,
    effectiveAt: EARLIER,
    now: NOW,
    ...extra,
  };
}

describe("person statuses", () => {
  it("knows every status and what it allows", () => {
    for (const status of PERSON_STATUSES) {
      expect(isPersonStatus(status)).toBe(true);
      expect(PERSON_STATUS_RULES[status].summary.length).toBeGreaterThan(10);
    }
    expect(isPersonStatus("alive")).toBe(false);
    expect(LIVE_PERSON_STATUSES).toEqual(["active", "on_leave", "in_hospital"]);
  });

  it.each<[PersonStatus, string, boolean]>([
    ["active", "point_of_care_rounds", true],
    ["on_leave", "point_of_care_rounds", false],
    ["in_hospital", "point_of_care_rounds", false],
    ["in_hospital", "care_observations", false],
    ["in_hospital", "care_notes", true],
    ["in_hospital", "hospital_transfer_pack", true],
    ["pre_admission", "pre_admission_assessment", true],
    ["pre_admission", "care_notes", false],
    ["enquiry", "about_me_authoring", false],
    ["discharged", "post_event_records", true],
    ["discharged", "care_notes", false],
    ["deceased", "family_and_professional_sharing", false],
    ["archived", "post_event_records", false],
  ])("%s allows %s: %s", (status, capability, expected) => {
    expect(personStatusAllows(status, capability as never)).toBe(expected);
  });

  it("marks only closed statuses read-only (care.md rule 12)", () => {
    const readOnly = PERSON_STATUSES.filter((s) => PERSON_STATUS_RULES[s].readOnly);
    expect(readOnly).toEqual(["discharged", "deceased", "archived", "not_admitted"]);
  });
});

describe("rule 12: discharged and deceased people are read-only except post-event records", () => {
  const died = new Date("2026-10-10T03:00:00Z");
  const deceased = { status: "deceased" as const, statusChangedAt: died };
  const discharged = { status: "discharged" as const, statusChangedAt: died };

  it("lists the post-event records", () => {
    expect(POST_EVENT_RECORD_KINDS).toEqual([
      "after_death_care",
      "medical_examiner_pack",
      "statutory_notification",
      "exit_checklist_item",
      "property_return",
      "money_return",
      "key_return",
      "post_event_note",
      "document",
      "correspondence",
    ]);
  });

  it.each(POST_EVENT_RECORD_KINDS)("accepts %s after a death", (kind) => {
    expect(checkPersonRecordWrite(deceased, { kind })).toEqual({
      ok: true,
      recordedAfterStatusChange: false,
    });
  });

  it.each<[string, PersonRecordKind, "deceased" | "discharged", string | null, string | null]>([
    [
      "a new chart entry after the death",
      "observation",
      "deceased",
      "2026-10-10T04:00:00Z",
      "occurred_after_status_change",
    ],
    ["a care plan change", "care_plan", "deceased", null, "not_allowed_in_status"],
    ["a room move", "room_move", "discharged", null, "not_allowed_in_status"],
    ["new property in", "property_item", "discharged", null, "not_allowed_in_status"],
    ["a sharing decision", "sharing_decision", "discharged", null, "not_allowed_in_status"],
    [
      "after-death care for a discharged person",
      "after_death_care",
      "discharged",
      null,
      "death_only",
    ],
    [
      "a medical examiner pack for a discharged person",
      "medical_examiner_pack",
      "discharged",
      null,
      "death_only",
    ],
    [
      "a care event with no event time",
      "care_note",
      "discharged",
      null,
      "occurred_after_status_change",
    ],
  ])("refuses %s", (_label, kind, status, occurredAt, problem) => {
    const context = status === "deceased" ? deceased : discharged;
    expect(
      checkPersonRecordWrite(context, {
        kind,
        occurredAt: occurredAt ? new Date(occurredAt) : null,
      }),
    ).toMatchObject({ ok: false, problem });
  });

  it.each<[PersonRecordKind, string]>([
    ["observation", "2026-10-10T02:00:00Z"],
    ["care_note", "2026-10-10T03:00:00Z"],
    ["body_map_mark", "2026-10-09T22:00:00Z"],
    ["incident", "2026-10-10T02:55:00Z"],
  ])(
    "hazard HZ-006 accepts an offline %s that happened before the death, flagged as recorded after it",
    (kind, occurredAt) => {
      expect(checkPersonRecordWrite(deceased, { kind, occurredAt: new Date(occurredAt) })).toEqual({
        ok: true,
        recordedAfterStatusChange: true,
      });
    },
  );

  it.each(["active", "on_leave", "in_hospital", "discharged", "deceased"] as const)(
    "accepts a key or property return while the person is %s (rule 7)",
    (status) => {
      for (const kind of ["key_return", "property_return"] as const) {
        expect(checkPersonRecordWrite({ status, statusChangedAt: died }, { kind })).toEqual({
          ok: true,
          recordedAfterStatusChange: false,
        });
      }
    },
  );

  it.each<[string, string, boolean, boolean]>([
    ["at the death", "2026-10-10T03:00:00Z", true, false],
    ["two minutes after (a fast phone clock)", "2026-10-10T03:02:00Z", true, true],
    ["exactly at the tolerance", "2026-10-10T03:05:00Z", true, true],
    ["a minute beyond the tolerance", "2026-10-10T03:06:00Z", false, false],
  ])(
    "hazard HZ-006 an observation timed %s is accepted within the clock tolerance: %s",
    (_label, occurredAt, accepted, tolerated) => {
      const result = checkPersonRecordWrite(
        { ...deceased, clockToleranceMinutes: 5 },
        { kind: "observation", occurredAt: new Date(occurredAt) },
      );
      if (!accepted) {
        expect(result).toMatchObject({
          ok: false,
          problem: "occurred_after_status_change",
          careEventAfterChange: true,
        });
      } else if (tolerated) {
        expect(result).toEqual({
          ok: true,
          recordedAfterStatusChange: true,
          withinClockTolerance: true,
        });
      } else {
        expect(result).toEqual({ ok: true, recordedAfterStatusChange: true });
      }
    },
  );

  it("refuses everything for archived and not-admitted records", () => {
    for (const kind of Object.keys(PERSON_RECORD_KINDS) as PersonRecordKind[]) {
      for (const status of ["archived", "not_admitted"] as const) {
        expect(checkPersonRecordWrite({ status, statusChangedAt: died }, { kind })).toMatchObject({
          ok: false,
          problem: "record_closed",
        });
      }
    }
  });

  it.each<["on_leave" | "in_hospital", PersonRecordKind, string, boolean]>([
    ["in_hospital", "observation", "2026-09-30T23:00:00Z", true],
    ["in_hospital", "body_map_mark", "2026-10-01T00:00:00Z", true],
    ["on_leave", "assessment", "2026-09-30T08:00:00Z", true],
    ["in_hospital", "observation", "2026-10-01T00:30:00Z", false],
    ["on_leave", "body_map_mark", "2026-10-02T10:00:00Z", false],
  ])(
    "hazard HZ-006 a person who went %s: an offline %s at %s is accepted: %s",
    (status, kind, occurredAt, accepted) => {
      const result = checkPersonRecordWrite(
        { status, statusChangedAt: new Date("2026-10-01T00:00:00Z") },
        { kind, occurredAt: new Date(occurredAt) },
      );
      if (accepted) expect(result).toEqual({ ok: true, recordedAfterStatusChange: true });
      else expect(result).toMatchObject({ ok: false, problem: "not_allowed_in_status" });
    },
  );

  it("lets live records take care events at any time", () => {
    expect(
      checkPersonRecordWrite(
        { status: "active", statusChangedAt: ADMITTED },
        { kind: "observation" },
      ),
    ).toEqual({ ok: true, recordedAfterStatusChange: false });
    expect(
      checkPersonRecordWrite(
        { status: "in_hospital", statusChangedAt: ADMITTED },
        { kind: "observation" },
      ),
    ).toMatchObject({ ok: false, problem: "not_allowed_in_status" });
  });
});

describe("status changes", () => {
  it.each<[string, PersonStatus, PersonStatus, Partial<PersonStatusChangeRequest>, string | null]>([
    ["start a pre-admission assessment", "enquiry", "pre_admission", {}, null],
    ["admit when ready", "pre_admission", "active", { admissionReady: true }, null],
    [
      "admit before the decision and bed are ready",
      "pre_admission",
      "active",
      {},
      "admission_not_ready",
    ],
    ["close an enquiry without a reason", "enquiry", "not_admitted", {}, "reason_required"],
    [
      "close an enquiry with a reason",
      "enquiry",
      "not_admitted",
      { reason: "Chose another home" },
      null,
    ],
    [
      "re-refer a closed enquiry",
      "not_admitted",
      "enquiry",
      { reason: "Referred again by the council" },
      null,
    ],
    [
      "record a hospital transfer at night",
      "active",
      "in_hospital",
      { permissions: nightSenior },
      null,
    ],
    [
      "record a return from hospital at night",
      "in_hospital",
      "active",
      { permissions: nightSenior },
      null,
    ],
    ["record a death at night", "in_hospital", "deceased", { permissions: nightSenior }, null],
    [
      "discharge without the permission",
      "active",
      "discharged",
      { permissions: nightSenior, reason: "Moved home", exitKind: "discharge" },
      "missing_permission",
    ],
    [
      "discharge without a reason",
      "active",
      "discharged",
      { exitKind: "discharge" },
      "reason_required",
    ],
    [
      "discharge without saying where to",
      "active",
      "discharged",
      { reason: "Moving nearer family" },
      "exit_kind_required",
    ],
    [
      "discharge to another provider",
      "on_leave",
      "discharged",
      { reason: "Moving nearer family", exitKind: "transfer" },
      null,
    ],
    [
      "admit straight from an enquiry",
      "enquiry",
      "active",
      { admissionReady: true },
      "no_such_transition",
    ],
    ["die before admission", "pre_admission", "deceased", {}, "no_such_transition"],
    ["move to the status the person already has", "active", "active", {}, "same_status"],
    [
      "date a change in the future",
      "active",
      "in_hospital",
      { effectiveAt: new Date("2026-10-11T11:00:00Z") },
      "effective_in_future",
    ],
    [
      "date a change before the current status",
      "active",
      "in_hospital",
      { effectiveAt: new Date("2026-08-01T10:00:00Z") },
      "effective_before_current_status",
    ],
    ["archive before the exit checklist is closed", "deceased", "archived", {}, "exit_not_closed"],
    [
      "archive once the exit checklist is closed",
      "deceased",
      "archived",
      { exitWorkflowClosed: true },
      null,
    ],
    ["archive a closed enquiry", "not_admitted", "archived", {}, null],
    [
      "re-admit a discharged person",
      "discharged",
      "pre_admission",
      { reason: "Respite again" },
      null,
    ],
    ["add to an archived record", "archived", "active", {}, "no_such_transition"],
  ])("%s", (_label, from, to, extra, problem) => {
    const result = checkPersonStatusChange(person(from), change(to, extra));
    if (problem === null) expect(result.ok).toBe(true);
    else expect(result).toMatchObject({ ok: false, problem });
  });

  it("accepts a device clock slightly ahead of the server", () => {
    const result = checkPersonStatusChange(
      person("active"),
      change("in_hospital", { effectiveAt: new Date("2026-10-11T10:03:00Z") }),
    );
    expect(result.ok).toBe(true);
    const strict = checkPersonStatusChange(
      person("active"),
      change("in_hospital", {
        effectiveAt: new Date("2026-10-11T10:03:00Z"),
        futureToleranceMinutes: 1,
      }),
    );
    expect(strict).toMatchObject({ ok: false, problem: "effective_in_future" });
  });

  it("hazard HZ-001 a death recorded in error is corrected only with a reason and a fresh sign-in", () => {
    const deceased = person("deceased", { deceasedAt: EARLIER, statusChangedAt: EARLIER });
    expect(checkPersonStatusChange(deceased, change("active", { effectiveAt: NOW }))).toMatchObject(
      {
        ok: false,
        problem: "reason_required",
      },
    );
    expect(
      checkPersonStatusChange(
        deceased,
        change("active", { effectiveAt: NOW, reason: "Wrong person selected" }),
      ),
    ).toMatchObject({ ok: false, problem: "step_up_required" });
    const corrected = checkPersonStatusChange(
      deceased,
      change("active", { effectiveAt: NOW, reason: "Wrong person selected", stepUpFresh: true }),
    );
    expect(corrected).toMatchObject({
      ok: true,
      correction: true,
      event: "people.person.status_corrected",
      effects: ["cancel_exit_workflow", "reopen_record", "resume_rounds"],
    });
  });

  it("never re-admits a person who has died", () => {
    const archived = person("archived", { deceasedAt: EARLIER });
    expect(
      checkPersonStatusChange(archived, change("pre_admission", { reason: "Mistaken referral" })),
    ).toMatchObject({ ok: false, problem: "deceased_cannot_be_readmitted" });
    expect(
      checkPersonStatusChange(
        person("archived"),
        change("pre_admission", { reason: "Back for respite" }),
      ),
    ).toMatchObject({ ok: true, event: "people.person.assessment_started" });
  });

  it.each<
    [
      PersonStatus,
      PersonStatus,
      Partial<PersonStatusChangeRequest>,
      string,
      readonly string[],
      string | null,
    ]
  >([
    [
      "enquiry",
      "pre_admission",
      {},
      "people.person.assessment_started",
      ["start_pre_admission_assessment"],
      null,
    ],
    [
      "pre_admission",
      "active",
      { admissionReady: true },
      "people.person.admitted",
      ["open_placement_and_bed", "start_welcome_checklist", "schedule_first_care_plan"],
      null,
    ],
    [
      "enquiry",
      "not_admitted",
      { reason: "Needs cannot be met" },
      "people.person.not_admitted",
      ["close_enquiry"],
      null,
    ],
    ["not_admitted", "enquiry", { reason: "New referral" }, "people.person.re_referred", [], null],
    ["active", "on_leave", {}, "people.person.went_on_leave", ["pause_rounds"], null],
    ["on_leave", "active", {}, "people.person.returned", ["resume_rounds"], null],
    [
      "active",
      "in_hospital",
      {},
      "people.person.went_to_hospital",
      ["pause_rounds", "offer_hospital_transfer_pack"],
      null,
    ],
    [
      "in_hospital",
      "active",
      {},
      "people.person.returned",
      ["resume_rounds", "start_return_from_hospital_checks", "raise_care_plan_review_on_change"],
      null,
    ],
    [
      "active",
      "discharged",
      { reason: "Moved home", exitKind: "discharge" },
      "people.person.discharged",
      ["start_exit_workflow", "cancel_future_tasks", "close_sharing", "release_bed"],
      "discharge",
    ],
    [
      "active",
      "deceased",
      {},
      "people.person.died",
      ["start_exit_workflow", "cancel_future_tasks", "close_sharing", "hold_room_for_clearance"],
      "death",
    ],
    [
      "discharged",
      "archived",
      { exitWorkflowClosed: true },
      "people.person.archived",
      ["start_retention_clock"],
      null,
    ],
    [
      "discharged",
      "active",
      { reason: "Discharge recorded for the wrong person" },
      "people.person.status_corrected",
      ["cancel_exit_workflow", "reopen_record", "resume_rounds"],
      null,
    ],
  ])("%s to %s raises its event and effects", (from, to, extra, event, effects, exitKind) => {
    const result = checkPersonStatusChange(person(from), change(to, extra));
    expect(result).toMatchObject({ ok: true, event, effects, exitKind });
  });

  it("offers night staff only the moves they may record", () => {
    expect(
      availableTransitions(
        PERSON_LIFECYCLE,
        { state: "active", createdBy: "x" },
        "senior",
        nightSenior,
      ),
    ).toEqual(["on_leave", "in_hospital", "deceased"]);
    expect(
      availableTransitions(
        PERSON_LIFECYCLE,
        { state: "deceased", createdBy: "x" },
        "senior",
        nightSenior,
      ),
    ).toEqual([]);
  });
});
