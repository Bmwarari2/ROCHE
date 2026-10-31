import type { ExitOut, PersonStatus } from "@harbour/contracts";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  awaitingDraft,
  checklistParts,
  derivedLink,
  type ExitAction,
  type ExitEntry,
  exitActions,
  exitStateChip,
  itemChip,
  itemEditable,
  itemTitle,
  outstandingTitles,
  personStatusChip,
} from "./exit";

const t = createTranslator("en-GB");
const NOTIFICATION = "0194d000-0000-7000-8000-00000000b001";

function entry(key: string, overrides: Partial<ExitEntry> = {}): ExitEntry {
  return {
    key,
    title: `API title for ${key}`,
    owner: "people",
    returnItem: false,
    allowNotRequired: false,
    notification: null,
    hazardIds: [],
    status: "pending",
    reason: null,
    doneBy: null,
    doneAt: null,
    evidenceType: null,
    evidenceId: null,
    derived: false,
    version: 1,
    ...overrides,
  };
}

function exit(overrides: Partial<ExitOut> = {}): ExitOut {
  return {
    id: "0194d000-0000-7000-8000-00000000e001",
    personId: "0194d000-0000-7000-8600-000000000001",
    kind: "discharge",
    state: "left",
    leftAt: "2026-10-31T09:00:00.000Z",
    statusBefore: "active",
    context: {
      regulator: "cqc",
      localAuthorityFunded: false,
      nhsFunded: false,
      placeOfDeath: null,
      deathExpected: null,
      learningDisabilityOrAutism: false,
      dolsInPlace: false,
      homeIsDwpAppointee: false,
      holdsResidentsMoney: true,
      holdsDeposit: false,
      hasLoanEquipment: false,
    },
    details: {},
    checklist: [
      entry("gp_informed"),
      entry("property_returned", { returnItem: true, derived: true }),
      entry("residents_money_returned", { returnItem: true, owner: "finance" }),
    ],
    status: {
      readyForReturn: false,
      readyToClose: false,
      outstanding: ["gp_informed", "residents_money_returned"],
      outstandingReturns: ["residents_money_returned"],
      invalid: [],
    },
    deadlines: { moneyAndPropertyBy: null, depositBy: null },
    closedAt: null,
    cancelledReason: null,
    version: 1,
    ...overrides,
  };
}

const MANAGER = new Set([
  "people.admission.manage",
  "people.movement.record",
  "people.property.manage",
  "finance.ledger.approve",
]);
const NURSE = new Set(["people.movement.record", "people.property.manage"]);
const READER = new Set<string>();
const actions = (status: PersonStatus, e: ExitOut | null, held: ReadonlySet<string>) =>
  [...exitActions(status, e, (p) => held.has(p))].sort();

describe("exitActions: what the Leaving tab offers (PEOP-010)", () => {
  const cases: readonly [
    string,
    PersonStatus,
    ExitOut | null,
    ReadonlySet<string>,
    ExitAction[],
  ][] = [
    [
      "a live person, nothing in progress, a manager",
      "active",
      null,
      MANAGER,
      ["plan", "recordDeath", "recordDischarge"],
    ],
    ["a live person, a nurse records a death only", "in_hospital", null, NURSE, ["recordDeath"]],
    ["a live person, a reader is offered nothing", "active", null, READER, []],
    [
      "a planned discharge: record leaving, record a death, cancel, tick",
      "active",
      exit({ state: "planned" }),
      MANAGER,
      ["cancelPlan", "financeItems", "items", "recordDeath", "recordDischarge"],
    ],
    [
      "after a cancelled plan, a new exit can start",
      "active",
      exit({ state: "cancelled" }),
      MANAGER,
      ["plan", "recordDeath", "recordDischarge"],
    ],
    [
      "left with the checklist outstanding: tick and return, not yet awaiting returns",
      "discharged",
      exit(),
      MANAGER,
      ["financeItems", "items", "returns"],
    ],
    [
      "left and ready for returns",
      "discharged",
      exit({ status: { ...exit().status, readyForReturn: true } }),
      MANAGER,
      ["awaitReturns", "financeItems", "items", "returns"],
    ],
    [
      "a death awaiting returns, ready to close",
      "deceased",
      exit({
        kind: "death",
        state: "awaiting_return",
        status: { ...exit().status, readyForReturn: true, readyToClose: true },
      }),
      MANAGER,
      ["close", "financeItems", "items", "returns"],
    ],
    [
      "a nurse after a death ticks and returns, never moves or archives",
      "deceased",
      exit({
        kind: "death",
        state: "recorded",
        status: { ...exit().status, readyForReturn: true },
      }),
      NURSE,
      ["items", "returns"],
    ],
    ["closed: archive only", "discharged", exit({ state: "closed" }), MANAGER, ["archive"]],
    ["hazard HZ-001 archived: nothing at all", "archived", exit({ state: "closed" }), MANAGER, []],
    ["not admitted: nothing at all", "not_admitted", null, MANAGER, []],
  ];
  it.each(cases)("%s", (_name, status, e, held, expected) => {
    expect(actions(status, e, held)).toEqual([...expected].sort());
  });
});

describe("checklist items", () => {
  it("lets finance items be changed only with finance approval, and never derived ones", () => {
    const withFinance = exitActions("discharged", exit(), (p) => MANAGER.has(p));
    const withoutFinance = exitActions("discharged", exit(), (p) => NURSE.has(p));
    const money = entry("residents_money_returned", { owner: "finance" });
    expect(itemEditable(money, withFinance, "cqc")).toBe(true);
    expect(itemEditable(money, withoutFinance, "cqc")).toBe(false);
    expect(itemEditable(entry("gp_informed"), withoutFinance, "cqc")).toBe(true);
    expect(itemEditable(entry("property_returned", { derived: true }), withFinance, "cqc")).toBe(
      false,
    );
  });

  it("hazard HZ-013 never offers a statutory notification to tick by hand while it is being drafted", () => {
    const all = exitActions("deceased", exit({ kind: "death" }), () => true);
    const regulator = entry("regulator_death_notification", { owner: "safety" });
    const examiner = entry("medical_examiner_information", { owner: "safety" });
    expect(all.has("notificationItems")).toBe(true);
    expect(itemEditable(regulator, all, "cqc")).toBe(false);
    expect(itemEditable(examiner, all, "ciw")).toBe(false);
    expect(awaitingDraft(regulator, "cqc")).toBe(true);
    // Outside England the regulator's notification is not drafted: the notification holder records it.
    expect(itemEditable(regulator, all, "ciw")).toBe(true);
    expect(awaitingDraft(regulator, "ciw")).toBe(false);
    const noSubmit = exitActions("deceased", exit({ kind: "death" }), (p) => MANAGER.has(p));
    expect(itemEditable(regulator, noSubmit, "ciw")).toBe(false);
  });

  it("hazard HZ-013 links a drafted notification to its page, and property to the returns", () => {
    expect(
      derivedLink(
        entry("medical_examiner_information", {
          derived: true,
          evidenceType: "statutory_notification",
          evidenceId: NOTIFICATION,
        }),
      ),
    ).toEqual({ kind: "notification", href: `/notifications/statutory/${NOTIFICATION}` });
    expect(derivedLink(entry("keys_returned", { derived: true }))).toEqual({
      kind: "returns",
      href: "#returns",
    });
    expect(derivedLink(entry("gp_informed"))).toBeNull();
  });

  it("says each state in words with an icon, never colour alone", () => {
    expect(itemChip({ status: "done" }, t)).toMatchObject({ icon: "circle-check", label: "Done" });
    expect(itemChip({ status: "pending" }, t)).toMatchObject({ icon: "clock", label: "To do" });
    expect(itemChip({ status: "not_required" }, t).label).toBe("Not required");
    expect(exitStateChip({ state: "awaiting_return" }, t).label).toBe("Waiting for returns");
    expect(exitStateChip({ state: "closed" }, t).label).toBe("Closed");
  });

  it("names items in the catalogue's words, and an unknown item in the API's", () => {
    expect(itemTitle(entry("gp_informed"), "discharge", t)).toBe("GP told");
    expect(itemTitle(entry("care_summary_sent"), "transfer", t)).toBe(
      "Transfer of care summary sent",
    );
    expect(itemTitle(entry("care_summary_sent"), "discharge", t)).toBe("Discharge summary sent");
    expect(itemTitle(entry("something_new"), "death", t)).toBe("API title for something_new");
  });

  it("puts the returns last and lists what is outstanding", () => {
    const parts = checklistParts(exit());
    expect(parts.first.map((e) => e.key)).toEqual(["gp_informed"]);
    expect(parts.returns.map((e) => e.key)).toEqual([
      "property_returned",
      "residents_money_returned",
    ]);
    expect(outstandingTitles(exit(), ["residents_money_returned"], t)).toEqual([
      "Personal money returned and the account closed",
    ]);
  });
});

describe("personStatusChip", () => {
  it("hazard HZ-001 marks an archived record as archived, in words", () => {
    expect(personStatusChip("archived", t)).toMatchObject({ icon: "archive", label: "Archived" });
    expect(personStatusChip("deceased", t)?.label).toBe("Died");
    expect(personStatusChip("discharged", t)?.label).toBe("Left the service");
    expect(personStatusChip("active", t)).toBeNull();
  });
});
