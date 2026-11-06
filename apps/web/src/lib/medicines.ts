import type { components } from "@harbour/contracts/client";
import type { Translator } from "@harbour/i18n";
import type { StatusChipStatus } from "@harbour/ui";
import {
  Ban,
  CircleCheck,
  Hourglass,
  type LucideIcon,
  Replace,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import { readDateField, readDateTimeField } from "./uk-time";

/**
 * The medicines record screens (MEDS-001, MEDS-006; medicines.md section 13; slice 52). Pure and
 * unit tested. The API runs every medicines rule; these read the forms into the contract so a
 * mistake is said at its field before anything is sent. A dose is sent as the number typed (a
 * trailing zero is not kept: "1.50" is 1.5) with dm+d's unit, never rounded or converted. Harbour never matches a medicine to an allergy or a
 * person, and never stops a medicine: people decide.
 */

type Schemas = components["schemas"];
export type MedicineEntry = Schemas["MedicineEntry"];
export type EntryState = MedicineEntry["state"];
export type Dose = Schemas["Dose"];
export type MarDirections = Schemas["MarDirections"];
export type DraftInput = Schemas["ReconciliationDraftInput"];
export type TranscribeBody = Schemas["TranscribeMedicine"];
export type ProductHit = Schemas["MedicineProducts"]["items"][number];
export type SourceKind = Schemas["MarSourceKind"];

export const MEDICINES_READERS = [
  "medicines.record.manage",
  "medicines.emar.administer",
  "care.plan.read",
] as const;
export const MEDICINES_WRITER = "medicines.record.manage";

export const medicinesHref = (personId: string) => `/people/${personId}/medicines`;
export const entryHref = (personId: string, entryId: string) =>
  `${medicinesHref(personId)}/${entryId}`;
export const reconciliationHref = (personId: string, recId: string) =>
  `${medicinesHref(personId)}/reconciliations/${recId}`;

export const SOURCE_KINDS: readonly SourceKind[] = [
  "prescription",
  "pharmacy_label",
  "pharmacy_mar",
  "discharge_letter",
  "transfer_letter",
  "gp_record",
  "clinic_letter",
  "prescriber_instruction",
  "previous_mar",
];
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const PATTERNS = ["every_day", "every_n_days", "weekly", "monthly"] as const;
export const DOSE_KINDS = ["amount", "range", "variable"] as const;
/** The dose times the form offers (the API takes up to 24). */
export const TIME_SLOTS = 8;
/** Years ahead a start, stop or review may be typed (a planned course), for the clock check. */
const AHEAD_MINUTES = 5 * 366 * 24 * 60;

export function medicinesShown(permissions: readonly string[]): boolean {
  return MEDICINES_READERS.some((p) => permissions.includes(p));
}

/** Each version's state as an icon and a word (never colour alone). */
export function entryChip(
  state: EntryState,
  t: Translator,
): { readonly status: StatusChipStatus; readonly icon: LucideIcon; readonly label: string } {
  const label = t("medicines.state", { state });
  switch (state) {
    case "not_yet_checked":
      return { status: "due", icon: Hourglass, label };
    case "checked":
      return { status: "done", icon: CircleCheck, label };
    case "difference_found":
      return { status: "overdue", icon: TriangleAlert, label };
    case "stopped":
      return { status: "notApplicable", icon: Ban, label };
    case "replaced":
      return { status: "notApplicable", icon: Replace, label };
    case "withdrawn":
      return { status: "notApplicable", icon: Undo2, label };
  }
}

/** The second check is offered to someone other than the transcriber while it is not yet checked. */
export function mayCheck(
  entry: Pick<MedicineEntry, "state" | "transcribed">,
  me: string,
  permissions: readonly string[],
): boolean {
  return (
    permissions.includes(MEDICINES_WRITER) &&
    entry.state === "not_yet_checked" &&
    entry.transcribed.id !== me
  );
}

/** A stop is offered while the version is in force or scheduled (not stopped, replaced or withdrawn). */
export function mayStop(
  entry: Pick<MedicineEntry, "state">,
  permissions: readonly string[],
): boolean {
  return (
    permissions.includes(MEDICINES_WRITER) &&
    (entry.state === "not_yet_checked" ||
      entry.state === "checked" ||
      entry.state === "difference_found")
  );
}

/** The version history newest first; withdrawn versions are struck through on screen. */
export function historyNewestFirst(versions: readonly MedicineEntry[]): MedicineEntry[] {
  return [...versions].sort((a, b) => b.version - a.version);
}

export interface FormWithAll {
  get(name: string): FormDataEntryValue | null;
  getAll(name: string): FormDataEntryValue[];
}

type Errors = Record<string, string>;
export type Read<T> =
  | { readonly ok: true; readonly body: T }
  | { readonly ok: false; readonly errors: Readonly<Errors> };

const text = (form: FormWithAll, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};
const optional = (form: FormWithAll, name: string) => text(form, name) || null;

/**
 * A dose quantity as the number typed: above zero, at most 3 decimal places, no leading zero before
 * a whole number ("007" is refused, so a slip is not read as 7). Never rounded (HZ-005).
 */
export function readQuantity(raw: string): number | null {
  if (!/^(0|[1-9]\d*)(\.\d{1,3})?$/.test(raw)) return null;
  const value = Number(raw);
  return value > 0 && value <= 10_000_000 ? value : null;
}

function readDose(
  form: FormWithAll,
  prefix: string,
  kind: string,
  unit: { code: string; name: string },
  errors: Errors,
  t: Translator,
): Dose | null {
  if (kind === "variable") return { kind: "variable", unit };
  if (kind === "range") {
    const from = readQuantity(text(form, `${prefix}from`));
    const to = readQuantity(text(form, `${prefix}to`));
    if (from === null || to === null || to <= from) {
      errors[`${prefix}from`] = t("medicines.form.rangeError");
      return null;
    }
    return { kind: "range", from, to, unit };
  }
  const quantity = readQuantity(text(form, `${prefix}quantity`));
  if (quantity === null) {
    errors[`${prefix}quantity`] = t("medicines.form.quantityError");
    return null;
  }
  return { kind: "amount", quantity, unit };
}

/**
 * What a version says, from the form: the chosen dm+d product (its route and unit only from what
 * dm+d permits), the directions, the prescriber, the dates and the optional words. Used by
 * transcription and by a reconciliation's change and start decisions (no source there).
 */
export function readDraft(
  form: FormWithAll,
  t: Translator,
  product: ProductHit | null,
  now: Date = new Date(),
): Read<DraftInput> {
  const errors: Errors = {};
  if (!product) errors.product = t("medicines.form.productError");
  const route = product?.permittedRoutes.find((r) => r.code === text(form, "route"));
  if (product && !route) errors.route = t("medicines.form.routeError");
  const unit = product?.permittedDoseUnits.find((u) => u.code === text(form, "unit"));
  if (product && !unit) errors.unit = t("medicines.form.unitError");
  const doseKind = text(form, "doseKind");
  if (!(DOSE_KINDS as readonly string[]).includes(doseKind)) {
    errors.doseKind = t("medicines.form.doseKindError");
  }

  let directions: MarDirections | null = null;
  const kind = text(form, "directionsKind");
  if (kind === "when_required") {
    const dose = unit ? readDose(form, "prn-", doseKind, unit, errors, t) : null;
    if (dose) directions = { kind: "when_required", dose };
  } else if (kind === "regular") {
    const pattern = readPattern(form, t, errors);
    const times: { time: string; dose: Dose }[] = [];
    for (let slot = 1; slot <= TIME_SLOTS; slot++) {
      const time = text(form, `time-${slot}`);
      const dosed = ["quantity", "from", "to"].some((f) => text(form, `slot-${slot}-${f}`) !== "");
      if (!time) {
        // A dose with no time is never dropped silently (HZ-005).
        if (dosed) errors[`time-${slot}`] = t("medicines.form.timeMissing");
        continue;
      }
      if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(time)) {
        errors[`time-${slot}`] = t("medicines.form.timeError");
        continue;
      }
      const dose = unit ? readDose(form, `slot-${slot}-`, doseKind, unit, errors, t) : null;
      if (dose) times.push({ time, dose });
    }
    if (times.length === 0 && !Object.keys(errors).some((k) => k.startsWith("time-"))) {
      errors["time-1"] = t("medicines.form.timesError");
    }
    if (new Set(times.map((x) => x.time)).size !== times.length) {
      errors["time-1"] = t("medicines.form.timesRepeated");
    }
    if (pattern && times.length > 0) {
      directions = {
        kind: "regular",
        schedule: { pattern, times: times.sort((a, b) => a.time.localeCompare(b.time)) },
      };
    }
  } else {
    errors.directionsKind = t("medicines.form.directionsError");
  }

  const prescriber = text(form, "prescriber");
  if (!prescriber) errors.prescriber = t("medicines.form.prescriberError");
  const ahead = { t, now, futureToleranceMinutes: AHEAD_MINUTES };
  const starts = readDateTimeField(form, "startsAt", {
    ...ahead,
    subject: t("medicines.form.startsSubject"),
  });
  if (!starts.ok) errors.startsAt = starts.message;
  const stops = readDateTimeField(form, "stopsAt", {
    ...ahead,
    optional: true,
    subject: t("medicines.form.stopsSubject"),
  });
  if (!stops.ok) errors.stopsAt = stops.message;
  const review = readDateField(form, "reviewOn", {
    t,
    optional: true,
    subject: t("medicines.form.reviewSubject"),
  });
  if (!review.ok) errors.reviewOn = review.message;

  if (Object.keys(errors).length > 0 || !product || !route || !directions) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    body: {
      product: { vmpId: product.vmpId, ampId: null, name: product.name },
      route,
      directions,
      indication: optional(form, "indication"),
      specialInstructions: optional(form, "specialInstructions"),
      prescriber,
      startsAt: starts.ok ? (starts.instant as string) : "",
      stopsAt: stops.ok ? stops.instant : null,
      reviewOn: review.ok ? review.date : null,
    },
  };
}

function readPattern(
  form: FormWithAll,
  t: Translator,
  errors: Errors,
): Schemas["SchedulePattern"] | null {
  const pattern = text(form, "pattern");
  switch (pattern) {
    case "every_day":
      return { kind: "every_day" };
    case "every_n_days": {
      const days = Number(text(form, "intervalDays"));
      const anchor = readDateField(form, "anchorOn", {
        t,
        subject: t("medicines.form.anchorSubject"),
      });
      if (!Number.isInteger(days) || days < 2 || days > 366) {
        errors.intervalDays = t("medicines.form.intervalDaysError");
      }
      if (!anchor.ok) errors.anchorOn = anchor.message;
      return errors.intervalDays || !anchor.ok
        ? null
        : { kind: "every_n_days", intervalDays: days, anchorOn: anchor.date as string };
    }
    case "weekly": {
      const weekdays = form
        .getAll("weekdays")
        .filter((d): d is (typeof WEEKDAYS)[number] =>
          (WEEKDAYS as readonly string[]).includes(String(d)),
        );
      const weeks = Number(text(form, "intervalWeeks") || "1");
      const anchor = readDateField(form, "anchorOn", {
        t,
        subject: t("medicines.form.anchorSubject"),
      });
      if (weekdays.length === 0) errors.weekdays = t("medicines.form.weekdaysError");
      if (!Number.isInteger(weeks) || weeks < 1 || weeks > 52) {
        errors.intervalWeeks = t("medicines.form.intervalWeeksError");
      }
      if (!anchor.ok) errors.anchorOn = anchor.message;
      return errors.weekdays || errors.intervalWeeks || !anchor.ok
        ? null
        : {
            kind: "weekly",
            weekdays: [...new Set(weekdays)],
            intervalWeeks: weeks,
            anchorOn: anchor.date as string,
          };
    }
    case "monthly": {
      const day = Number(text(form, "dayOfMonth"));
      if (!Number.isInteger(day) || day < 1 || day > 31) {
        errors.dayOfMonth = t("medicines.form.dayOfMonthError");
        return null;
      }
      return { kind: "monthly", dayOfMonth: day };
    }
    default:
      errors.pattern = t("medicines.form.patternError");
      return null;
  }
}

function readSource(form: FormWithAll, t: Translator, errors: Errors) {
  const kind = text(form, "sourceKind");
  const reference = text(form, "sourceReference");
  if (!(SOURCE_KINDS as readonly string[]).includes(kind)) {
    errors.sourceKind = t("medicines.form.sourceKindError");
  }
  if (!reference) errors.sourceReference = t("medicines.form.sourceReferenceError");
  return { kind: kind as SourceKind, reference, documentId: null };
}

/** A new medicine: the draft, its source and the reasons the API may ask for. */
export function readTranscription(
  form: FormWithAll,
  t: Translator,
  product: ProductHit | null,
  now: Date = new Date(),
): Read<TranscribeBody> {
  const draft = readDraft(form, t, product, now);
  const errors: Errors = draft.ok ? {} : { ...draft.errors };
  const source = readSource(form, t, errors);
  if (!draft.ok || Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      ...draft.body,
      source,
      reanchorReason: optional(form, "reanchorReason"),
      earlierDosesDueReason: optional(form, "earlierDosesDueReason"),
    },
  };
}

/** The second check: compared with the source itself, and whether it matches; a difference in words. */
export function readCheck(form: FormWithAll, t: Translator): Read<Schemas["CheckMedicine"]> {
  const errors: Errors = {};
  if (text(form, "comparedWithSource") !== "yes") {
    errors.comparedWithSource = t("medicines.check.comparedError");
  }
  const outcome = text(form, "outcome");
  if (outcome !== "matches_source" && outcome !== "differs_from_source") {
    errors.outcome = t("medicines.check.outcomeError");
  }
  const difference = optional(form, "difference");
  if (outcome === "differs_from_source" && !difference) {
    errors.difference = t("medicines.check.differenceError");
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      outcome: outcome as "matches_source" | "differs_from_source",
      difference: outcome === "differs_from_source" ? difference : null,
      comparedWithSource: true,
    },
  };
}

/** A stop: when, why, and the instruction's source; the version as read. */
export function readStop(
  form: FormWithAll,
  t: Translator,
  expectedVersion: number,
  now: Date = new Date(),
): Read<Schemas["StopMedicine"]> {
  const errors: Errors = {};
  const when = readDateTimeField(form, "effectiveAt", {
    t,
    now,
    futureToleranceMinutes: AHEAD_MINUTES,
    subject: t("medicines.stop.whenSubject"),
  });
  if (!when.ok) errors.effectiveAt = when.message;
  const reason = text(form, "reason");
  if (!reason) errors.reason = t("medicines.stop.reasonError");
  const source = readSource(form, t, errors);
  if (Object.keys(errors).length > 0 || !when.ok) return { ok: false, errors };
  return {
    ok: true,
    body: {
      effectiveAt: when.instant as string,
      reason,
      source,
      expectedVersion,
      withdrawLaterReason: optional(form, "withdrawLaterReason"),
    },
  };
}

/** The API's refusal codes whose words say what to add, and the reason field each reveals. */
export const REASON_FOR_PROBLEM: Readonly<Record<string, string>> = {
  medicine_count_reanchored: "reanchorReason",
  medicine_later_version_scheduled: "withdrawLaterReason",
  medicine_return_without_discharge_letter: "noDischargeLetterReason",
};

// Reconciliation (medicines.md section 13 rule 6). A person decides every entry and line; a line
// that says "stop" stops nothing until someone decides it.

/**
 * A line to add. Typed here rather than from the generated client, whose type for the nullable
 * product cannot hold one (openapi-typescript reads the default as an empty object).
 */
export interface ReconciliationLine {
  readonly sourceId: string;
  readonly asWritten: string;
  readonly says: (typeof LINE_SAYS)[number];
  readonly product: { readonly vmpId: string; readonly ampId: null; readonly name: string } | null;
}

export const RECONCILIATION_SOURCE_KINDS = [...SOURCE_KINDS, "person_or_family"] as const;
export const LINE_SAYS = ["start", "continue", "change", "stop", "unclear"] as const;
export type Reconciliation = Schemas["MedicineReconciliation"];

/** A source: its kind, reference and when it was received (now or before). */
export function readReconciliationSource(
  form: FormWithAll,
  t: Translator,
  now: Date = new Date(),
): Read<Schemas["AddReconciliationSource"]> {
  const errors: Errors = {};
  const kind = text(form, "sourceKind");
  if (!(RECONCILIATION_SOURCE_KINDS as readonly string[]).includes(kind)) {
    errors.sourceKind = t("medicines.form.sourceKindError");
  }
  const reference = text(form, "sourceReference");
  if (!reference) errors.sourceReference = t("medicines.form.sourceReferenceError");
  const received = readDateTimeField(form, "receivedAt", {
    t,
    now,
    subject: t("medicines.rec.receivedSubject"),
  });
  if (!received.ok) errors.receivedAt = received.message;
  if (Object.keys(errors).length > 0 || !received.ok) return { ok: false, errors };
  return {
    ok: true,
    body: {
      kind: kind as Schemas["AddReconciliationSource"]["kind"],
      reference,
      documentId: null,
      receivedAt: received.instant as string,
      currentBecause: optional(form, "currentBecause"),
    },
  };
}

/** A line as written on a source, with what it says and, where known, its dm+d product. */
export function readReconciliationItem(
  form: FormWithAll,
  t: Translator,
  sourceIds: ReadonlySet<string>,
  product: ProductHit | null,
): Read<ReconciliationLine> {
  const errors: Errors = {};
  const sourceId = text(form, "sourceId");
  if (!sourceIds.has(sourceId)) errors.sourceId = t("medicines.rec.sourceError");
  const asWritten = text(form, "asWritten");
  if (!asWritten) errors.asWritten = t("medicines.rec.asWrittenError");
  const says = text(form, "says");
  if (!(LINE_SAYS as readonly string[]).includes(says)) errors.says = t("medicines.rec.saysError");
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      sourceId,
      asWritten,
      says: says as (typeof LINE_SAYS)[number],
      product: product ? { vmpId: product.vmpId, ampId: null, name: product.name } : null,
    },
  };
}

const lineIds = (form: FormWithAll, offered: ReadonlySet<string>) =>
  form
    .getAll("itemIds")
    .map(String)
    .filter((id) => offered.has(id));

/** A decision about a current entry: continue, change (a new draft), stop (a reason) or a query. */
export function readEntryDecision(
  form: FormWithAll,
  t: Translator,
  entryId: string,
  offeredLines: ReadonlySet<string>,
  product: ProductHit | null,
  now: Date = new Date(),
): Read<Schemas["EntryDecision"]> {
  const kind = text(form, "decision");
  const itemIds = lineIds(form, offeredLines);
  switch (kind) {
    case "continue":
      return {
        ok: true,
        body: {
          kind,
          entryId,
          itemIds,
          note: optional(form, "note"),
          confirmedWith: optional(form, "confirmedWith"),
          scheduledStillStands: optional(form, "scheduledStillStands"),
        },
      };
    case "change": {
      const draft = readDraft(form, t, product, now);
      if (!draft.ok) return draft;
      return {
        ok: true,
        body: {
          kind,
          entryId,
          itemIds,
          draft: draft.body,
          reanchorReason: optional(form, "reanchorReason"),
          withdrawLaterReason: optional(form, "withdrawLaterReason"),
          scheduledStillStands: optional(form, "scheduledStillStands"),
        },
      };
    }
    case "stop": {
      const reason = text(form, "reason");
      if (!reason) return { ok: false, errors: { reason: t("medicines.stop.reasonError") } };
      return {
        ok: true,
        body: {
          kind,
          entryId,
          itemIds,
          reason,
          withdrawLaterReason: optional(form, "withdrawLaterReason"),
        },
      };
    }
    case "query": {
      const question = text(form, "question");
      if (!question) return { ok: false, errors: { question: t("medicines.rec.questionError") } };
      return { ok: true, body: { kind, entryId, question } };
    }
    default:
      return { ok: false, errors: { decision: t("medicines.rec.decisionError") } };
  }
}

/** A decision about a line no entry answers: start (a draft), not started (a reason) or a query. */
export function readItemDecision(
  form: FormWithAll,
  t: Translator,
  itemId: string,
  product: ProductHit | null,
  now: Date = new Date(),
): Read<Schemas["ItemDecision"]> {
  const kind = text(form, "decision");
  switch (kind) {
    case "start": {
      const draft = readDraft(form, t, product, now);
      if (!draft.ok) return draft;
      return {
        ok: true,
        body: {
          kind,
          itemId,
          draft: draft.body,
          reanchorReason: optional(form, "reanchorReason"),
          earlierDosesDueReason: optional(form, "earlierDosesDueReason"),
        },
      };
    }
    case "not_started": {
      const reason = text(form, "reason");
      if (!reason) return { ok: false, errors: { reason: t("medicines.rec.notStartedError") } };
      return { ok: true, body: { kind, itemId, reason } };
    }
    case "query": {
      const question = text(form, "question");
      if (!question) return { ok: false, errors: { question: t("medicines.rec.questionError") } };
      return { ok: true, body: { kind, itemId, question } };
    }
    default:
      return { ok: false, errors: { decision: t("medicines.rec.decisionError") } };
  }
}

/** Completion: allergies compared, the person involved or why not, at the version read. */
export function readCompletion(
  form: FormWithAll,
  t: Translator,
  expectedVersion: number,
): Read<Schemas["CompleteReconciliation"]> {
  const errors: Errors = {};
  if (text(form, "allergiesCompared") !== "yes") {
    errors.allergiesCompared = t("medicines.rec.allergiesError");
  }
  const involved = text(form, "involved");
  const why = text(form, "notInvolvedReason");
  if (involved !== "yes" && involved !== "no") errors.involved = t("medicines.rec.involvedError");
  if (involved === "no" && !why) errors.notInvolvedReason = t("medicines.rec.notInvolvedError");
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      expectedVersion,
      allergiesCompared: true,
      personInvolvement: involved === "yes" ? { involved: true } : { involved: false, reason: why },
      noDischargeLetterReason: optional(form, "noDischargeLetterReason"),
    },
  };
}

/** The decision recorded so far for an entry or a line, if any. */
export function decisionFor(
  rec: Pick<Reconciliation, "entryDecisions" | "itemDecisions">,
  on: { readonly entryId?: string; readonly itemId?: string },
): { readonly kind: string } | null {
  if (on.entryId) return rec.entryDecisions.find((d) => d.entryId === on.entryId) ?? null;
  if (on.itemId) return rec.itemDecisions.find((d) => d.itemId === on.itemId) ?? null;
  return null;
}
