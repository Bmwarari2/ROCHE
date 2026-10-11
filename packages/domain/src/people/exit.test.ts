import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { resolveRate } from "../platform/rates";
import { checkWorkflowTransition, slaDueAt } from "../platform/workflow";
import { addUkDays } from "../shared/time";
import {
  checkExitWorkflowMove,
  DEATH_WORKFLOW,
  DISCHARGE_WORKFLOW,
  EXIT_WORKFLOWS,
  type ExitContext,
  type ExitItemState,
  type ExitReturns,
  exitChecklist,
  exitChecklistStatus,
  exitNotifications,
  exitReturnDeadlines,
  TRANSFER_WORKFLOW,
} from "./exit";
import { resolvePeopleRates } from "./rates";

const rows = readRateTable();
const rates = resolvePeopleRates(rows, "england", "2026-10-11", null);
const manager = new Set(["people.admission.manage"]);
const AT = new Date("2026-10-11T09:00:00Z");

function context(overrides: Partial<ExitContext> = {}): ExitContext {
  return {
    kind: "death",
    regulator: "cqc",
    funding: { localAuthority: false, nhs: false },
    placeOfDeath: "care_home",
    deathExpected: true,
    learningDisabilityOrAutism: false,
    dolsInPlace: false,
    homeIsDwpAppointee: false,
    holdsResidentsMoney: false,
    holdsDeposit: false,
    hasLoanEquipment: false,
    ...overrides,
  };
}

const keys = (overrides: Partial<ExitContext>) =>
  exitChecklist(context(overrides)).map((i) => i.key);

describe("exit workflows", () => {
  it("are registered for each kind", () => {
    expect(EXIT_WORKFLOWS).toEqual({
      discharge: DISCHARGE_WORKFLOW,
      transfer: TRANSFER_WORKFLOW,
      death: DEATH_WORKFLOW,
    });
    expect(DISCHARGE_WORKFLOW.key).toBe("people.discharge");
    expect(TRANSFER_WORKFLOW.key).toBe("people.transfer");
  });

  it.each<
    [
      string,
      "planned" | "left" | "awaiting_return",
      string,
      Partial<{ reason: string; stepUpFresh: boolean }>,
      string | null,
    ]
  >([
    ["the person leaves as planned", "planned", "left", {}, null],
    [
      "a planned discharge is cancelled with a reason",
      "planned",
      "cancelled",
      { reason: "Staying after all" },
      null,
    ],
    ["a cancellation needs a reason", "planned", "cancelled", {}, "reason_required"],
    ["returns are awaited", "left", "awaiting_return", {}, null],
    ["the workflow closes", "awaiting_return", "closed", {}, null],
    [
      "a discharge cannot be cancelled after the person left",
      "left",
      "cancelled",
      { reason: "Mistake" },
      "no_such_transition",
    ],
  ])("discharge: %s", (_label, from, to, extra, problem) => {
    const result = checkWorkflowTransition(
      DISCHARGE_WORKFLOW,
      { state: from, createdBy: "manager-1" },
      { to: to as never, actorId: "manager-2", permissions: manager, stepUpFresh: false, ...extra },
    );
    if (problem === null) expect(result.ok).toBe(true);
    else expect(result).toMatchObject({ ok: false, problem });
  });

  it("hazard HZ-001 cancels a death recorded in error only with a reason and step-up", () => {
    const view = { state: "recorded" as const, createdBy: "nurse-1" };
    const base = { to: "cancelled" as const, actorId: "manager-1", permissions: manager };
    expect(
      checkWorkflowTransition(DEATH_WORKFLOW, view, { ...base, stepUpFresh: true }),
    ).toMatchObject({
      ok: false,
      problem: "reason_required",
    });
    expect(
      checkWorkflowTransition(DEATH_WORKFLOW, view, {
        ...base,
        reason: "Wrong person",
        stepUpFresh: false,
      }),
    ).toMatchObject({ ok: false, problem: "step_up_required" });
    expect(
      checkWorkflowTransition(DEATH_WORKFLOW, view, {
        ...base,
        reason: "Wrong person",
        stepUpFresh: true,
      }).ok,
    ).toBe(true);
  });

  it("escalates returns not made within the rate-table service level", () => {
    const due = slaDueAt(
      DEATH_WORKFLOW,
      "awaiting_return",
      AT,
      (key) => resolveRate(rows, key, "england", "2026-10-11", null).value,
    );
    expect(due).toEqual(addUkDays(AT, rates.exitReturnDays));
    expect(slaDueAt(DEATH_WORKFLOW, "recorded", AT, () => 1)).toBeNull();
  });
});

describe("death checklist", () => {
  it("covers verification, after-death care, the regulator, the medical examiner and returns", () => {
    expect(keys({})).toEqual([
      "death_verified",
      "next_of_kin_informed",
      "after_death_care_recorded",
      "regulator_death_notification",
      "gp_informed",
      "medical_examiner_information",
      "pharmacy_informed",
      "medicines_handled",
      "funeral_director_collection",
      "property_returned",
      "keys_returned",
    ]);
  });

  it.each<[string, Partial<ExitContext>, string, boolean]>([
    [
      "a death in hospital leaves the medical examiner to the hospital",
      { placeOfDeath: "hospital" },
      "medical_examiner_information",
      false,
    ],
    [
      "an unexpected death records the coroner referral",
      { deathExpected: false },
      "coroner_referral_recorded",
      true,
    ],
    [
      "a person with a learning disability or autism prompts LeDeR",
      { learningDisabilityOrAutism: true },
      "leder_notification",
      true,
    ],
    [
      "hazard HZ-020 a DoLS authorisation is closed with the supervisory body",
      { dolsInPlace: true },
      "dols_supervisory_body_informed",
      true,
    ],
    [
      "council funding tells the council",
      { funding: { localAuthority: true, nhs: false } },
      "local_authority_informed",
      true,
    ],
    [
      "NHS funding tells the integrated care board",
      { funding: { localAuthority: false, nhs: true } },
      "icb_informed",
      true,
    ],
    ["an appointee home tells DWP", { homeIsDwpAppointee: true }, "dwp_informed", true],
    ["money held is returned", { holdsResidentsMoney: true }, "residents_money_returned", true],
    ["a deposit is returned", { holdsDeposit: true }, "deposit_returned", true],
    ["loan equipment goes back", { hasLoanEquipment: true }, "loan_equipment_returned", true],
  ])("%s", (_label, overrides, key, present) => {
    expect(keys(overrides).includes(key)).toBe(present);
  });

  it("hazard HZ-013 lists the statutory notifications first", () => {
    const notifications = exitNotifications(context({ learningDisabilityOrAutism: true }));
    expect(notifications.filter((n) => n.statutory).map((n) => n.recipient)).toEqual([
      "CQC",
      "Medical examiner office",
      "LeDeR programme",
    ]);
    expect(notifications[0]?.statutory).toBe(true);
    expect(notifications.at(-1)?.statutory).toBe(false);
  });

  it("names the nation's regulator", () => {
    const item = exitChecklist(context({ regulator: "ciw" })).find(
      (i) => i.key === "regulator_death_notification",
    );
    expect(item?.notification?.recipient).toBe("Care Inspectorate Wales");
  });
});

describe("discharge and transfer checklists", () => {
  it("sends a transfer of care summary to the receiving provider before the person leaves", () => {
    const item = exitChecklist(context({ kind: "transfer" })).find(
      (i) => i.key === "care_summary_sent",
    );
    expect(item).toMatchObject({
      title: "Transfer of care summary sent",
      notification: { recipient: "Receiving provider", due: { kind: "before_leaving" } },
    });
  });

  it("sends a discharge summary to the GP on discharge", () => {
    expect(
      exitChecklist(context({ kind: "discharge" })).find((i) => i.key === "care_summary_sent"),
    ).toMatchObject({
      title: "Discharge summary sent",
      notification: { recipient: "GP practice" },
    });
  });

  it("has no death-only items", () => {
    const discharge = keys({ kind: "discharge" });
    for (const key of [
      "death_verified",
      "after_death_care_recorded",
      "regulator_death_notification",
      "funeral_director_collection",
    ]) {
      expect(discharge).not.toContain(key);
    }
    expect(discharge).toContain("medicines_sent_with_person");
  });

  it("gives the deposit return the CMA clock from the rate table", () => {
    const deposit = exitChecklist(context({ kind: "discharge", holdsDeposit: true })).find(
      (i) => i.key === "deposit_returned",
    );
    expect(deposit?.notification?.due).toEqual({
      kind: "rate",
      rateKey: "cma.deposit_return_days",
      unit: "days",
    });
    expect(exitReturnDeadlines(AT, { holdsDeposit: true }, rates)).toEqual({
      moneyAndPropertyBy: addUkDays(AT, rates.exitReturnDays),
      depositBy: addUkDays(AT, rates.depositReturnDays),
    });
    expect(exitReturnDeadlines(AT, { holdsDeposit: false }, rates).depositBy).toBeNull();
  });
});

describe("checklist status", () => {
  const done: ExitItemState = { status: "done", by: "manager-1", at: AT };
  const items = exitChecklist(context({ holdsResidentsMoney: true }));
  const allDone = Object.fromEntries(items.map((i) => [i.key, done]));
  const nothingHeld: ExitReturns = { property: [], keys: [], residentsMoneyBalancePence: 0 };

  it("is ready to close when everything is done and nothing is held", () => {
    expect(exitChecklistStatus(items, allDone, nothingHeld)).toEqual({
      readyForReturn: true,
      readyToClose: true,
      outstanding: [],
      outstandingReturns: [],
      invalid: [],
    });
  });

  it("waits for returns while property, keys or money are still held, whatever the boxes say", () => {
    const status = exitChecklistStatus(items, allDone, {
      property: [{ id: "i1", category: "clothing", receivedOn: "2026-09-01", status: "held" }],
      keys: [
        {
          id: "k1",
          label: "Room 4",
          issuedOn: "2026-09-01",
          issuedTo: "person",
          returnedOn: null,
          reportedLostOn: null,
        },
      ],
      residentsMoneyBalancePence: 4250,
    });
    expect(status).toMatchObject({
      readyForReturn: true,
      readyToClose: false,
      outstandingReturns: ["property_returned", "keys_returned", "residents_money_returned"],
    });
    expect(checkExitWorkflowMove("awaiting_return", status)).toEqual({ ok: true });
    expect(checkExitWorkflowMove("closed", status)).toEqual({
      ok: false,
      problem: "returns_outstanding",
      outstanding: ["property_returned", "keys_returned", "residents_money_returned"],
    });
  });

  it("counts returns as done from the records even before anyone ticks them", () => {
    const states = { ...allDone, property_returned: { status: "pending" } as const };
    expect(exitChecklistStatus(items, states, nothingHeld).readyToClose).toBe(true);
  });

  it("accepts not required with a reason only where allowed", () => {
    const status = exitChecklistStatus(
      items,
      {
        ...allDone,
        next_of_kin_informed: {
          status: "not_required",
          reason: "No next of kin; advocate told",
          by: "m",
          at: AT,
        },
        death_verified: { status: "not_required", reason: "Not needed", by: "m", at: AT },
        gp_informed: { status: "not_required", reason: "", by: "m", at: AT },
      },
      nothingHeld,
    );
    expect(status).toMatchObject({
      outstanding: ["death_verified", "gp_informed"],
      invalid: ["death_verified", "gp_informed"],
    });
    expect(checkExitWorkflowMove("awaiting_return", status)).toEqual({
      ok: false,
      problem: "checklist_incomplete",
      outstanding: ["death_verified", "gp_informed"],
    });
  });

  it("does not gate moves other than to awaiting return or closed", () => {
    const status = exitChecklistStatus(items, {}, nothingHeld);
    expect(checkExitWorkflowMove("left", status)).toEqual({ ok: true });
    expect(checkExitWorkflowMove("cancelled", status)).toEqual({ ok: true });
  });
});
