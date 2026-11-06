import type { components } from "@harbour/contracts/client";
import type { Translator } from "@harbour/i18n";
import type { StatusChipStatus } from "@harbour/ui";
import {
  CircleCheck,
  CircleDashed,
  Clock,
  Hourglass,
  type LucideIcon,
  TriangleAlert,
} from "lucide-react";
import { type FormWithAll, medicinesHref, type Read } from "./medicines";

/**
 * The medicines round on the web (slice 53; MEDS-002, MEDS-003, MEDS-004; medicines.md section 16):
 * pure helpers for the round pages and the form that records a dose. The API runs every rule
 * again (`checkAdministration`) and answers in words; these read the form so a mistake is said at
 * its field first. Harbour never matches a medicine to an allergy (ADR-0082): the record page shows
 * the person and every allergy beside the medicine, and people compare them (HZ-007).
 */

type Schemas = components["schemas"];
export type RoundDose = Schemas["MedicineRound"]["doses"][number];
export type RoundPrn = Schemas["MedicineRound"]["whenRequired"][number];
export type Entry = Schemas["MedicineEntry"];
export type CovertRecord = Schemas["CovertRecord"];
export type Outcome = Schemas["AdministrationOutcome"];
type Dose = Schemas["Dose"];

/** Who may see and record the round: the API checks it again at the person's home. */
export const ROUND_PERMISSION = "medicines.emar.administer";
export const medicinesRoundShown = (permissions: readonly string[]) =>
  permissions.includes(ROUND_PERMISSION);

export const locationRoundHref = (locationId: string) => `/medicines-round/${locationId}`;
export const personRoundHref = (personId: string) => `${medicinesHref(personId)}/round`;
/** The page that records one dose: a scheduled dose by its due time, a when-required one without. */
export const recordDoseHref = (personId: string, entryId: string, dueAt: string | null) =>
  `${personRoundHref(personId)}/record?entry=${entryId}${dueAt ? `&due=${encodeURIComponent(dueAt)}` : ""}`;

/** The slot a round shows by default: two hours either side of now (the API reaches back further for late doses). */
export function defaultSlot(now: Date = new Date()): { from: string; to: string } {
  const hour = 3_600_000;
  return {
    from: new Date(now.getTime() - 2 * hour).toISOString(),
    to: new Date(now.getTime() + 2 * hour).toISOString(),
  };
}

/** A dose's state as an icon and a word (never colour alone). */
export function doseChip(
  state: RoundDose["state"],
  words: string,
): { readonly status: StatusChipStatus; readonly icon: LucideIcon; readonly label: string } {
  switch (state) {
    case "late":
      return { status: "overdue", icon: TriangleAlert, label: words };
    case "due":
      return { status: "due", icon: Clock, label: words };
    case "not_yet_due":
      return { status: "notApplicable", icon: Hourglass, label: words };
    case "recorded":
      return { status: "done", icon: CircleCheck, label: words };
  }
}

/** A covert record's state as an icon and a word; anything but current needs attention. */
export function covertChip(record: Pick<CovertRecord, "status" | "statusWords">): {
  readonly status: StatusChipStatus;
  readonly icon: LucideIcon;
  readonly label: string;
} {
  return record.status === "current"
    ? { status: "done", icon: CircleCheck, label: record.statusWords }
    : record.status === "not_started" || record.status === "ended"
      ? { status: "notApplicable", icon: CircleDashed, label: record.statusWords }
      : { status: "overdue", icon: TriangleAlert, label: record.statusWords };
}

/** The covert record for the entry's medicine that is not ended, if any (shown beside it; H-1354). */
export function covertFor(
  entry: Pick<Entry, "medicineId">,
  records: readonly CovertRecord[],
): CovertRecord | null {
  return records.find((r) => r.medicineId === entry.medicineId && r.status !== "ended") ?? null;
}

/**
 * The dose prescribed for a dose time (the schedule's time "HH:MM"), or the when-required dose.
 * Null when the entry says nothing for that time: the person then types the amount.
 */
export function prescribedDose(entry: Pick<Entry, "directions">, time: string | null): Dose | null {
  const d = entry.directions;
  if (d.kind === "when_required") return d.dose;
  if (time === null) return null;
  return d.schedule.times.find((slot) => slot.time === time)?.dose ?? null;
}

/** The amount to offer: the prescribed amount when it is one number, otherwise empty. */
export function offeredAmount(dose: Dose | null): string {
  return dose?.kind === "amount" ? String(dose.quantity) : "";
}

/** Every outcome a dose can be recorded with, in the order the form offers them. */
export const OUTCOMES: readonly Outcome[] = [
  "given",
  "refused",
  "omitted",
  "withheld",
  "not_available",
  "self_administered",
  "given_by_family",
];

/** The coded reasons each outcome takes (`OUTCOME_REASONS` in the domain); `other` needs words. */
export const OUTCOME_REASON_CODES: Readonly<Record<Outcome, readonly string[]>> = {
  given: [],
  self_administered: [],
  given_by_family: [],
  refused: ["declined", "other"],
  omitted: [
    "asleep",
    "away_from_home",
    "in_hospital",
    "nil_by_mouth",
    "unable_to_swallow",
    "vomiting",
    "other",
  ],
  not_available: ["out_of_stock", "not_delivered", "other"],
  withheld: ["prescriber_instruction", "outside_prescribed_parameters", "other"],
};

/** Outcomes in which the person took the dose: they need the amount. */
const TAKEN: ReadonlySet<Outcome> = new Set(["given", "self_administered", "given_by_family"]);
export const outcomeTakesAmount = (outcome: string) => TAKEN.has(outcome as Outcome);

const text = (form: FormWithAll, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};
const optional = (form: FormWithAll, name: string) => text(form, name) || null;

/** A positive number as typed, never a leading zero or more than three decimal places. */
const QUANTITY = /^(?:0|[1-9]\d{0,7})(?:\.\d{1,3})?$/;

/**
 * Reads the record-a-dose form into the request (`RecordAdministration`). The context gives what the
 * page already knows: the client's id for the record, the entry, the due time (null for a
 * when-required dose) and the prescribed unit.
 */
export function readAdministration(
  form: FormWithAll,
  t: Translator,
  context: {
    readonly id: string;
    readonly entryId: string;
    readonly dueAt: string | null;
    readonly unitCode: string | null;
  },
): Read<Schemas["RecordAdministration"]> {
  const errors: Record<string, string> = {};
  const outcomeText = text(form, "outcome");
  const outcome = (OUTCOMES as readonly string[]).includes(outcomeText)
    ? (outcomeText as Outcome)
    : null;
  if (!outcome) errors.outcome = t("medicines.round.form.outcomeError");
  const codes = outcome ? OUTCOME_REASON_CODES[outcome] : [];
  const code = text(form, "reasonCode");
  const note = optional(form, "reasonNote");
  if (codes.length > 0 && !codes.includes(code)) {
    errors.reasonCode = t("medicines.round.form.reasonError");
  }
  if (code === "other" && !note) errors.reasonNote = t("medicines.round.form.reasonNoteError");
  let amount: Schemas["RecordAdministration"]["amount"] = null;
  if (outcome && TAKEN.has(outcome)) {
    const typed = text(form, "quantity");
    const quantity = Number(typed);
    if (!QUANTITY.test(typed) || !(quantity > 0)) {
      errors.quantity = t("medicines.round.form.quantityError");
    } else if (!context.unitCode) {
      errors.quantity = t("medicines.round.form.unitError");
    } else {
      amount = { quantity, unitCode: context.unitCode };
    }
  }
  const covert = text(form, "covert") === "yes";
  if (covert && outcome !== "given") errors.covert = t("medicines.round.form.covertError");
  if (Object.keys(errors).length > 0 || !outcome) return { ok: false, errors };
  return {
    ok: true,
    body: {
      id: context.id,
      entryId: context.entryId,
      dueAt: context.dueAt,
      outcome,
      reason: codes.length > 0 ? { code, note } : null,
      amount,
      amountDifferenceReason: optional(form, "amountDifferenceReason"),
      timingReason: optional(form, "timingReason"),
      intervalOverrideReason: optional(form, "intervalOverrideReason"),
      controlledDrug: null,
      covert,
      givenAt: null,
      deviceOffsetMs: null,
      givenBeforeRecorded: null,
      givenBy: null,
    },
  };
}

/**
 * Which form field each administration refusal belongs to (the API's code is `administration_` and
 * the domain's problem), so the API's words show there; anything else shows above the form.
 */
export const ADMINISTRATION_FIELD_FOR_PROBLEM: Readonly<Record<string, string>> = {
  administration_amount_required: "quantity",
  administration_amount_wrong_unit: "quantity",
  administration_amount_not_a_dose: "quantity",
  administration_amount_differs_needs_reason: "amountDifferenceReason",
  administration_timing_reason_required: "timingReason",
  administration_interval_override_required: "intervalOverrideReason",
  administration_reason_required: "reasonCode",
  administration_reason_not_for_outcome: "reasonCode",
  administration_note_required: "reasonNote",
};

/** People on the location round, in the API's order (room, then name), with their names. */
export function roundPeople<
  P extends { readonly personId: string },
  S extends { readonly id: string },
>(
  people: readonly P[],
  summaries: readonly S[],
): { readonly entry: P; readonly person: S | null }[] {
  const byId = new Map(summaries.map((s) => [s.id, s]));
  return people.map((entry) => ({ entry, person: byId.get(entry.personId) ?? null }));
}
