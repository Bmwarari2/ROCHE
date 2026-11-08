import type { components } from "@harbour/contracts/client";
import type { Translator } from "@harbour/i18n";
import {
  type Entry,
  OUTCOME_REASON_CODES,
  OUTCOMES,
  type Outcome,
  outcomeTakesAmount,
} from "./medicine-round";
import { medicinesHref } from "./medicines";
import { readDateTimeField } from "./uk-time";

/**
 * Doses recorded twice and corrections of administration records on the web (HZ-004; medicines.md
 * 15.4 and 14.4): the decisions a conflict allows, what a correction does to the controlled drugs
 * register (so the witness signs for exactly that), and reading the correction form. The API
 * decides again; nothing here is kept.
 */

type Schemas = components["schemas"];
export type Conflict = Schemas["AdministrationConflict"];
export type Administration = Schemas["Administration"];
export type Uploaded = Schemas["UploadedAdministration"];
export type Decision = Schemas["ResolveAdministrationConflict"]["outcome"];
export type CorrectBody = Schemas["CorrectAdministration"];

export const RESOLVER = "medicines.record.manage";
export const conflictsHref = (locationId: string) => `/medicines-round/${locationId}/conflicts`;
export const conflictHref = (locationId: string, conflictId: string) =>
  `${conflictsHref(locationId)}/${conflictId}`;
export const administrationsHref = (personId: string) =>
  `${medicinesHref(personId)}/administrations`;
export const correctHref = (personId: string, administrationId: string, conflict?: string) =>
  `${administrationsHref(personId)}/${administrationId}/correct${
    conflict ? `?${new URLSearchParams({ conflict }).toString()}` : ""
  }`;

/** Where a refusal for a fresh sign-in goes: to sign in again, then back to this page. */
export const stepUpHref = (next: string) =>
  `/sign-in?${new URLSearchParams({ reason: "step-up", next }).toString()}`;

const TAKEN: ReadonlySet<string> = new Set(["given", "self_administered", "given_by_family"]);
const quantityOf = (r: { readonly amount: { readonly quantity: number } | null }) =>
  r.amount?.quantity ?? null;

/** Both records say the same thing: the same outcome and amount (the phone's sameDose). */
export function recordsAgree(c: Pick<Conflict, "current" | "uploaded">): boolean {
  return (
    c.current.outcome === c.uploaded.outcome && quantityOf(c.current) === quantityOf(c.uploaded)
  );
}

/** The same member recorded the record that stands and the second record. */
export function sameRecorder(c: Pick<Conflict, "current" | "uploadedBy">): boolean {
  return c.current.recorded.id === c.uploadedBy;
}

/**
 * The decisions the records allow, in the order offered, as the API's rules (re-review M2):
 * "given twice" only when both say the dose was taken; "the first stands" unless the second says
 * taken and the record that stands does not; "corrected" once a correction in force was made
 * after the second record arrived.
 */
export function decisionsFor(
  c: Pick<Conflict, "standing" | "current" | "uploaded" | "joined" | "receivedAt">,
): Decision[] {
  const takenUpload = [c.uploaded, ...c.joined].some((u) => TAKEN.has(u.outcome));
  const takenNow = TAKEN.has(c.current.outcome);
  const out: Decision[] = [];
  if (!(takenUpload && !takenNow)) out.push("first_stands");
  if (takenUpload && takenNow) out.push("both_given");
  if (correctionSince(c)) out.push("corrected");
  return out;
}

/** The correction in force made after the second record arrived, which "corrected" names. */
export function correctionSince(
  c: Pick<Conflict, "standing" | "current" | "receivedAt">,
): Administration | null {
  if (c.current.id === c.standing.id) return null;
  return Date.parse(c.current.recorded.at) >= Date.parse(c.receivedAt) ? c.current : null;
}

export interface RegisterMove {
  readonly movement: "administration" | "correction";
  /** For a correction, the signed change in what was given (before less after). */
  readonly quantity: number;
}

/**
 * What a correction of a controlled drug's record does to the register, as the API's
 * registerMoveForCorrection (medicines.md 14.4): nothing when the amount given and its time stand;
 * an administration entry when a dose not in the register is now given; otherwise a correction of
 * its entry by the change in what was given (a detail correction, 0, when only the time moved).
 */
export function registerMove(
  original: Pick<Administration, "outcome" | "amount" | "givenAt" | "inCdRegister">,
  corrected: {
    readonly outcome: string;
    readonly quantity: number | null;
    readonly givenAt: string;
  },
): RegisterMove | null {
  const before = original.outcome === "given" && original.amount ? original.amount.quantity : 0;
  const after = corrected.outcome === "given" && corrected.quantity ? corrected.quantity : 0;
  const moved =
    before > 0 && after > 0 && Date.parse(original.givenAt) !== Date.parse(corrected.givenAt);
  if (before === after && !moved) return null;
  if (before === 0 || !original.inCdRegister) {
    return after > 0 ? { movement: "administration", quantity: after } : null;
  }
  return { movement: "correction", quantity: Math.round((before - after) * 1000) / 1000 };
}

export interface FormLike {
  get(name: string): FormDataEntryValue | null;
}

type Errors = Record<string, string>;
export type Read<T> =
  | { readonly ok: true; readonly body: T }
  | { readonly ok: false; readonly errors: Readonly<Errors>; readonly parts?: Readonly<Errors> };

const text = (form: FormLike, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};
const optional = (form: FormLike, name: string) => text(form, name) || null;
const QUANTITY = /^(?:0|[1-9]\d{0,7})(?:\.\d{1,3})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The corrected outcome and amount as typed, for showing the register move as the form changes. */
export function typedCorrection(form: FormLike): { outcome: string; quantity: number | null } {
  const typed = text(form, "quantity");
  return {
    outcome: text(form, "outcome"),
    quantity: QUANTITY.test(typed) && Number(typed) > 0 ? Number(typed) : null,
  };
}

/**
 * Reads the correction form into the request (`CorrectAdministration`). For a controlled drug
 * whose register this moves, the witness's signature (one signed for this correction) or, where
 * the page's policy allows, why there was none.
 */
export function readCorrection(
  form: FormLike,
  t: Translator,
  context: {
    readonly id: string;
    readonly original: Pick<
      Administration,
      "entryId" | "dueAt" | "outcome" | "amount" | "givenAt" | "inCdRegister"
    >;
    readonly unitCode: string | null;
    readonly controlledDrug: boolean;
    /** Signatures waiting for this recorder and this correction. */
    readonly waiting: ReadonlySet<string>;
    readonly loneAllowed: boolean;
    readonly now?: Date;
  },
): Read<CorrectBody> {
  const errors: Errors = {};
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
  let amount: CorrectBody["amount"] = null;
  if (outcome && outcomeTakesAmount(outcome)) {
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
  const correctionReason = text(form, "correctionReason");
  if (!correctionReason) errors.correctionReason = t("medicines.correct.form.reasonError");
  const when = readDateTimeField(form, "givenAt", {
    subject: t("medicines.correct.form.givenAtSubject"),
    t,
    ...(context.now ? { now: context.now } : {}),
    futureToleranceMinutes: 0,
  });
  if (!when.ok) errors.givenAt = when.message;
  const givenAt = when.ok ? when.instant : null;
  const covert = text(form, "covert") === "yes";
  if (covert && outcome !== "given") errors.covert = t("medicines.round.form.covertError");
  let controlledDrug: CorrectBody["controlledDrug"] = null;
  const move =
    context.controlledDrug && outcome && givenAt
      ? registerMove(context.original, {
          outcome,
          quantity: amount?.quantity ?? null,
          givenAt,
        })
      : null;
  if (move) {
    const choice = text(form, "witness");
    if (choice === "none") {
      const why = text(form, "noWitnessReason");
      if (!context.loneAllowed) errors.witness = t("cd.form.witnessRequired");
      else if (!why) errors.noWitnessReason = t("cd.form.noWitnessReasonError");
      else controlledDrug = { noWitnessReason: why };
    } else if (UUID.test(choice) && context.waiting.has(choice)) {
      controlledDrug = { witnessAssertionId: choice };
    } else {
      errors.witness = t("medicines.correct.form.witnessError");
    }
  }
  if (Object.keys(errors).length > 0 || !outcome || !givenAt) return { ok: false, errors };
  return {
    ok: true,
    body: {
      id: context.id,
      entryId: context.original.entryId,
      dueAt: context.original.dueAt,
      outcome,
      reason: codes.length > 0 ? { code, note } : null,
      amount,
      amountDifferenceReason: optional(form, "amountDifferenceReason"),
      timingReason: optional(form, "timingReason"),
      intervalOverrideReason: optional(form, "intervalOverrideReason"),
      controlledDrug,
      covert,
      correctionReason,
      givenAt,
      givenBy: null,
    },
  };
}

/** Reads the decision form into the request. */
export function readDecision(
  form: FormLike,
  t: Translator,
  offered: readonly Decision[],
  correctionId: string | null,
): Read<Schemas["ResolveAdministrationConflict"]> {
  const errors: Errors = {};
  const outcome = text(form, "outcome") as Decision;
  if (!offered.includes(outcome)) errors.outcome = t("medicines.conflicts.form.outcomeError");
  const note = text(form, "note");
  if (!note) errors.note = t("medicines.conflicts.form.noteError");
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    body: { outcome, correctionId: outcome === "corrected" ? correctionId : null, note },
  };
}

/** The unit an entry is given in (its first prescribed dose's), for amounts in words. */
export function entryUnit(entry: Pick<Entry, "directions">): { code: string; name: string } | null {
  const d = entry.directions;
  if (d.kind === "when_required") return d.dose?.unit ?? null;
  for (const slot of d.schedule.times) if (slot.dose) return slot.dose.unit;
  return null;
}
