import { defineWorkflow, type WorkflowDefinition } from "../platform/workflow";
import { addUkDays } from "../shared/time";
import { hasReason } from "./dates";
import type { ExitKind } from "./lifecycle";
import {
  type KeyIssue,
  outstandingKeys,
  outstandingProperty,
  type PropertyItemRecord,
} from "./property";
import { PEOPLE_RATE_KEYS, type PeopleRates } from "./rates";

/**
 * Discharge, transfer and death workflows (master prompt section 9.2; people.md section 4 rules
 * 11 and 12). Each runs on the platform workflow engine: the exit is recorded, everything except
 * returning money, property and keys is done, then the return is awaited (with a service level
 * from the rate table), then the workflow closes and the record can be archived. The checklist
 * says what must be done, who owns it, and which notifications it makes; statutory notifications
 * (CQC Regulation 16, medical examiner, LeDeR) are drafted by the safety module from the
 * `people.person.died` event and appear here as items the safety module completes.
 */

export type ExitState = "planned" | "left" | "awaiting_return" | "closed" | "cancelled";
export type DeathExitState = "recorded" | "awaiting_return" | "closed" | "cancelled";

const RETURN_SLA = {
  awaiting_return: { rateKey: PEOPLE_RATE_KEYS.exitReturnDays, unit: "days" },
} as const;

function leavingWorkflow(key: string): WorkflowDefinition<ExitState> {
  return defineWorkflow<ExitState>({
    key,
    version: 1,
    states: ["planned", "left", "awaiting_return", "closed", "cancelled"],
    initial: "planned",
    terminal: ["closed", "cancelled"],
    transitions: [
      { from: "planned", to: "left", permission: "people.admission.manage" },
      {
        from: "planned",
        to: "cancelled",
        permission: "people.admission.manage",
        requiresReason: true,
      },
      { from: "left", to: "awaiting_return", permission: "people.admission.manage" },
      { from: ["left", "awaiting_return"], to: "closed", permission: "people.admission.manage" },
      // A discharge or transfer recorded in error (the person never left) is cancelled with a
      // reason alongside the lifecycle correction, which emits `cancel_exit_workflow`.
      {
        from: ["left", "awaiting_return"],
        to: "cancelled",
        permission: "people.admission.manage",
        requiresReason: true,
      },
    ],
    sla: RETURN_SLA,
  });
}

export const DISCHARGE_WORKFLOW = leavingWorkflow("people.discharge");
export const TRANSFER_WORKFLOW = leavingWorkflow("people.transfer");

export const DEATH_WORKFLOW = defineWorkflow<DeathExitState>({
  key: "people.death",
  version: 1,
  states: ["recorded", "awaiting_return", "closed", "cancelled"],
  initial: "recorded",
  terminal: ["closed", "cancelled"],
  transitions: [
    { from: "recorded", to: "awaiting_return", permission: "people.admission.manage" },
    { from: ["recorded", "awaiting_return"], to: "closed", permission: "people.admission.manage" },
    // A death recorded in error (HZ-001): cancelled with a reason and a fresh sign-in, alongside
    // the lifecycle correction.
    {
      from: "recorded",
      to: "cancelled",
      permission: "people.admission.manage",
      requiresReason: true,
      requiresStepUp: true,
    },
  ],
  sla: RETURN_SLA,
});

export const EXIT_WORKFLOWS = {
  discharge: DISCHARGE_WORKFLOW,
  transfer: TRANSFER_WORKFLOW,
  death: DEATH_WORKFLOW,
} as const;

// ------------------------------------------------------------------------------------------------
// Checklist
// ------------------------------------------------------------------------------------------------

export type ExitItemOwner = "people" | "care" | "medicines" | "safety" | "finance";

export type ExitItemDue =
  | { readonly kind: "without_delay" }
  | { readonly kind: "before_leaving" }
  | { readonly kind: "rate"; readonly rateKey: string; readonly unit: "days" };

export interface ExitNotification {
  /** Who is told. */
  readonly recipient: string;
  /** True when a law requires it (drafted and submitted in the safety module). */
  readonly statutory: boolean;
  readonly due: ExitItemDue;
}

export interface ExitChecklistItem {
  readonly key: string;
  readonly title: string;
  readonly owner: ExitItemOwner;
  /** Returning money, property, keys, deposits or equipment: the last stage before closure. */
  readonly returnItem: boolean;
  /** Whether "not required" (with a reason) is acceptable. */
  readonly allowNotRequired: boolean;
  readonly notification: ExitNotification | null;
  readonly hazardIds: readonly string[];
}

export interface ExitContext {
  readonly kind: ExitKind;
  /** The regulator for the location's nation (England: CQC). */
  readonly regulator: "cqc" | "ciw" | "care_inspectorate" | "rqia";
  readonly funding: { readonly localAuthority: boolean; readonly nhs: boolean };
  /** For a death: where it happened. */
  readonly placeOfDeath?: "care_home" | "hospital" | "elsewhere";
  /** For a death: expected (end of life) or not. Unexpected deaths are referred to the coroner. */
  readonly deathExpected?: boolean;
  /** True when the person had a learning disability or was autistic (LeDeR). */
  readonly learningDisabilityOrAutism: boolean;
  readonly dolsInPlace: boolean;
  /** True when a member of the home's staff is the person's DWP appointee. */
  readonly homeIsDwpAppointee: boolean;
  readonly holdsResidentsMoney: boolean;
  readonly holdsDeposit: boolean;
  readonly hasLoanEquipment: boolean;
}

const REGULATOR_NAMES: Record<ExitContext["regulator"], string> = {
  cqc: "CQC",
  ciw: "Care Inspectorate Wales",
  care_inspectorate: "Care Inspectorate",
  rqia: "RQIA",
};

interface ItemOptions {
  readonly owner?: ExitItemOwner;
  readonly returnItem?: boolean;
  readonly allowNotRequired?: boolean;
  readonly notification?: ExitNotification | null;
  readonly hazardIds?: readonly string[];
}

function item(key: string, title: string, options: ItemOptions = {}): ExitChecklistItem {
  return {
    key,
    title,
    owner: options.owner ?? "people",
    returnItem: options.returnItem ?? false,
    allowNotRequired: options.allowNotRequired ?? false,
    notification: options.notification ?? null,
    hazardIds: options.hazardIds ?? [],
  };
}

const tell = (
  recipient: string,
  due: ExitItemDue = { kind: "without_delay" },
): ExitNotification => ({
  recipient,
  statutory: false,
  due,
});

const statutory = (recipient: string): ExitNotification => ({
  recipient,
  statutory: true,
  due: { kind: "without_delay" },
});

function returnItems(context: ExitContext): ExitChecklistItem[] {
  const items = [
    item("property_returned", "Personal property returned or handed over", { returnItem: true }),
    item("keys_returned", "Keys and fobs returned or reported lost", { returnItem: true }),
  ];
  if (context.holdsResidentsMoney) {
    items.push(
      item("residents_money_returned", "Personal money returned and the account closed", {
        owner: "finance",
        returnItem: true,
      }),
    );
  }
  if (context.holdsDeposit) {
    items.push(
      item("deposit_returned", "Deposit returned", {
        owner: "finance",
        returnItem: true,
        notification: tell("The person or their estate", {
          kind: "rate",
          rateKey: PEOPLE_RATE_KEYS.depositReturnDays,
          unit: "days",
        }),
      }),
    );
  }
  if (context.hasLoanEquipment) {
    items.push(
      item("loan_equipment_returned", "Loan equipment returned to the supplier", {
        returnItem: true,
      }),
    );
  }
  return items;
}

function sharedNotifications(context: ExitContext): ExitChecklistItem[] {
  const items: ExitChecklistItem[] = [];
  if (context.funding.localAuthority) {
    items.push(
      item("local_authority_informed", "Local authority told", {
        notification: tell("Local authority"),
      }),
    );
  }
  if (context.funding.nhs) {
    items.push(
      item("icb_informed", "Integrated care board told", {
        notification: tell("Integrated care board"),
      }),
    );
  }
  if (context.dolsInPlace) {
    items.push(
      item(
        "dols_supervisory_body_informed",
        "DoLS supervisory body told the authorisation has ended",
        {
          notification: tell("DoLS supervisory body"),
          hazardIds: ["HZ-020"],
        },
      ),
    );
  }
  if (context.homeIsDwpAppointee) {
    items.push(
      item("dwp_informed", "DWP told (the home is the appointee)", {
        owner: "finance",
        notification: tell("Department for Work and Pensions"),
      }),
    );
  }
  items.push(
    item("pharmacy_informed", "Pharmacy told to stop or redirect supplies", {
      notification: tell("Pharmacy"),
    }),
  );
  return items;
}

/** The checklist for an exit, with the notifications it makes. */
export function exitChecklist(context: ExitContext): ExitChecklistItem[] {
  if (context.kind === "death") {
    const regulator = REGULATOR_NAMES[context.regulator];
    const items: ExitChecklistItem[] = [
      item("death_verified", "Death verified (who, their role and when)"),
      item("next_of_kin_informed", "Next of kin or representative told", {
        allowNotRequired: true,
        notification: tell("Next of kin or representative"),
      }),
      item("after_death_care_recorded", "After-death care recorded", { owner: "care" }),
      item("regulator_death_notification", `${regulator} death notification`, {
        owner: "safety",
        allowNotRequired: true,
        notification: statutory(regulator),
        hazardIds: ["HZ-013"],
      }),
      item("gp_informed", "GP told", { allowNotRequired: true, notification: tell("GP practice") }),
    ];
    if (context.placeOfDeath !== "hospital") {
      items.push(
        item("medical_examiner_information", "Information sent to the medical examiner", {
          owner: "safety",
          allowNotRequired: true,
          notification: statutory("Medical examiner office"),
          hazardIds: ["HZ-013"],
        }),
      );
    }
    if (context.deathExpected === false) {
      items.push(
        item(
          "coroner_referral_recorded",
          "Coroner referral recorded (who referred and the reference)",
          {
            notification: tell("Coroner"),
          },
        ),
      );
    }
    if (context.learningDisabilityOrAutism) {
      items.push(
        item("leder_notification", "LeDeR notification", {
          owner: "safety",
          notification: statutory("LeDeR programme"),
          hazardIds: ["HZ-013"],
        }),
      );
    }
    items.push(
      ...sharedNotifications(context),
      item("medicines_handled", "Medicines kept or returned under the home's policy", {
        owner: "medicines",
      }),
      item("funeral_director_collection", "Funeral director's collection recorded"),
      ...returnItems(context),
    );
    return items;
  }
  const receiving = context.kind === "transfer" ? "Receiving provider" : "GP practice";
  return [
    item("destination_recorded", "Where the person is going recorded"),
    item("person_involved", "The person and their representatives involved in the plan", {
      allowNotRequired: true,
    }),
    item("next_of_kin_informed", "Next of kin or representative told", {
      allowNotRequired: true,
      notification: tell("Next of kin or representative"),
    }),
    item(
      "care_summary_sent",
      context.kind === "transfer" ? "Transfer of care summary sent" : "Discharge summary sent",
      { notification: tell(receiving, { kind: "before_leaving" }) },
    ),
    item("medicines_sent_with_person", "Medicines and the medicines list sent with the person", {
      owner: "medicines",
      allowNotRequired: true,
    }),
    item("gp_informed", "GP told", { notification: tell("GP practice") }),
    ...sharedNotifications(context),
    ...returnItems(context),
  ];
}

/** The notifications an exit makes, statutory ones first. */
export function exitNotifications(
  context: ExitContext,
): (ExitNotification & { readonly itemKey: string })[] {
  return exitChecklist(context)
    .filter(
      (i): i is ExitChecklistItem & { notification: ExitNotification } => i.notification !== null,
    )
    .map((i) => ({ itemKey: i.key, ...i.notification }))
    .sort((a, b) => Number(b.statutory) - Number(a.statutory));
}

export type ExitItemState =
  | { readonly status: "pending" }
  | {
      readonly status: "done";
      readonly by: string;
      readonly at: Date;
      readonly evidenceId?: string | null;
    }
  | {
      readonly status: "not_required";
      readonly reason: string;
      readonly by: string;
      readonly at: Date;
    };

export const MIN_EXIT_REASON_LENGTH = 3;

/** What the inventory, keys log and ledger say about the return items. */
export interface ExitReturns {
  readonly property: readonly PropertyItemRecord[];
  readonly keys: readonly KeyIssue[];
  /** Balance held for the person in pence (residents' money ledger), or null when none is held. */
  readonly residentsMoneyBalancePence: number | null;
}

export interface ExitChecklistStatus {
  /** Every item except the return items is done: the workflow may move to `awaiting_return`. */
  readonly readyForReturn: boolean;
  /** Everything is done: the workflow may close and the record be archived. */
  readonly readyToClose: boolean;
  readonly outstanding: readonly string[];
  readonly outstandingReturns: readonly string[];
  /** Items whose recorded state is not acceptable (for example "not required" where it must be done). */
  readonly invalid: readonly string[];
}

function derivedReturnDone(key: string, returns: ExitReturns): boolean | null {
  if (key === "property_returned") return outstandingProperty(returns.property).length === 0;
  if (key === "keys_returned") return outstandingKeys(returns.keys).length === 0;
  if (key === "residents_money_returned") {
    return returns.residentsMoneyBalancePence === null || returns.residentsMoneyBalancePence === 0;
  }
  return null;
}

/**
 * Where the checklist stands. Property, keys and money are derived from their own records, so a
 * box cannot be ticked while an item is still held.
 */
export function exitChecklistStatus(
  items: readonly ExitChecklistItem[],
  states: Readonly<Record<string, ExitItemState>>,
  returns: ExitReturns,
): ExitChecklistStatus {
  const outstanding: string[] = [];
  const outstandingReturns: string[] = [];
  const invalid: string[] = [];
  for (const entry of items) {
    const state = states[entry.key] ?? { status: "pending" };
    let done = state.status === "done";
    if (state.status === "not_required") {
      if (entry.allowNotRequired && hasReason(state.reason, MIN_EXIT_REASON_LENGTH)) done = true;
      else invalid.push(entry.key);
    }
    const derived = derivedReturnDone(entry.key, returns);
    if (derived !== null) done = derived;
    if (!done) (entry.returnItem ? outstandingReturns : outstanding).push(entry.key);
  }
  return {
    readyForReturn: outstanding.length === 0,
    readyToClose: outstanding.length === 0 && outstandingReturns.length === 0,
    outstanding,
    outstandingReturns,
    invalid,
  };
}

export type ExitMoveCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly problem: "checklist_incomplete" | "returns_outstanding";
      readonly outstanding: readonly string[];
    };

/** The checklist gate the API applies before `moveWorkflow` to `awaiting_return` or `closed`. */
export function checkExitWorkflowMove(
  to: ExitState | DeathExitState,
  status: ExitChecklistStatus,
): ExitMoveCheck {
  if (to !== "awaiting_return" && to !== "closed") return { ok: true };
  if (!status.readyForReturn) {
    return { ok: false, problem: "checklist_incomplete", outstanding: status.outstanding };
  }
  if (to === "closed" && !status.readyToClose) {
    return { ok: false, problem: "returns_outstanding", outstanding: status.outstandingReturns };
  }
  return { ok: true };
}

/** When the money, property and deposit returns fall due after the person left or died. */
export function exitReturnDeadlines(
  leftAt: Date,
  context: Pick<ExitContext, "holdsDeposit">,
  rates: Pick<PeopleRates, "exitReturnDays" | "depositReturnDays">,
): { readonly moneyAndPropertyBy: Date; readonly depositBy: Date | null } {
  return {
    moneyAndPropertyBy: addUkDays(leftAt, rates.exitReturnDays),
    depositBy: context.holdsDeposit ? addUkDays(leftAt, rates.depositReturnDays) : null,
  };
}
