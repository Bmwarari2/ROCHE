import type { components } from "@harbour/contracts/client";
import type { Translator } from "@harbour/i18n";
import type { StatusChipStatus } from "@harbour/ui";
import {
  CircleCheck,
  Flag,
  type LucideIcon,
  PackagePlus,
  PencilLine,
  Pill,
  Recycle,
  Trash2,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import { readDateTimeField } from "./uk-time";

/**
 * The controlled drugs register screens (MEDS-005, MEDS-014; medicines.md section 15; slice 54).
 * Pure and unit tested. The API runs every register rule and keeps the running balance; these
 * read the forms into the contract so a mistake is said at its field, word each movement and
 * result as an icon and a word, and put each correction under the entry it corrects. Nothing here
 * adds up a balance: every balance shown is the API's.
 */

type Schemas = components["schemas"];
export type CdEntry = Schemas["CdEntry"];
export type CdPageSummary = Schemas["CdPageSummary"];
export type CdMovement = Schemas["CdMovement"];
export type WaitingAssertion = Schemas["CdWaitingAssertions"]["assertions"][number];

/** The API's readers of the register (`READERS` in apps/api/src/routes/controlled-drugs.ts). */
export const CD_READERS = [
  "medicines.cd.administer",
  "medicines.cd.witness",
  "medicines.record.manage",
  "medicines.emar.administer",
  "care.plan.read",
] as const;
export const CD_RECORDER = "medicines.cd.administer";
export const CD_WITNESS = "medicines.cd.witness";
export const CD_COUNTER = "medicines.stock.manage";

export const cdTabHref = (personId: string) => `/people/${personId}/controlled-drugs`;
export const cdPageHref = (personId: string, pageId: string) => `${cdTabHref(personId)}/${pageId}`;

/** The movements a person records on the web (administrations come from the MAR). */
export const RECORDED_MOVEMENTS = ["receipt", "transfer_out", "disposal", "destruction"] as const;
export type RecordedMovement = (typeof RECORDED_MOVEMENTS)[number];
/** What a witness can sign for: a recorded movement, a correction or a count. */
export const WITNESSED = [...RECORDED_MOVEMENTS, "correction", "stock_check"] as const;

export function cdShown(permissions: readonly string[]): boolean {
  return CD_READERS.some((p) => permissions.includes(p));
}

/** Each movement as an icon and a word. */
export function movementChip(
  movement: CdMovement,
  t: Translator,
): { readonly status: StatusChipStatus; readonly icon: LucideIcon; readonly label: string } {
  const label = t("cd.movement", { movement });
  const icons: Record<CdMovement, LucideIcon> = {
    receipt: PackagePlus,
    administration: Pill,
    disposal: Recycle,
    transfer_out: Undo2,
    destruction: Trash2,
    correction: PencilLine,
  };
  return {
    status: movement === "correction" ? "info" : "neutral",
    icon: icons[movement] ?? Pill,
    label,
  };
}

/** A flag (for example "no witness, for manager review") as an icon and words. */
export function flagChip(
  flag: string,
  t: Translator,
): { readonly status: StatusChipStatus; readonly icon: LucideIcon; readonly label: string } {
  return { status: "due", icon: Flag, label: t("cd.flag", { flag }) };
}

/** A stock check's result: balanced, or not, as an icon and the API's words. */
export function stockCheckChip(check: {
  readonly difference: number;
  readonly resultInWords: string;
}): { readonly status: StatusChipStatus; readonly icon: LucideIcon; readonly label: string } {
  return check.difference === 0
    ? { status: "done", icon: CircleCheck, label: check.resultInWords }
    : { status: "overdue", icon: TriangleAlert, label: check.resultInWords };
}

/** Whether the next count is overdue now (from the API's due time). */
export function countOverdue(dueAt: string | null, now: Date = new Date()): boolean {
  return dueAt !== null && Date.parse(dueAt) <= now.getTime();
}

/**
 * The entries in page order, each correction placed directly under the entry it corrects (and a
 * correction of a correction under that), so the margin note sits beside what it puts right. The
 * register itself is never reordered: `seq` is shown with each.
 */
export function withCorrectionsBeside(
  entries: readonly CdEntry[],
): { readonly entry: CdEntry; readonly depth: number }[] {
  const bySeq = [...entries].sort((a, b) => a.seq - b.seq);
  const children = new Map<string, CdEntry[]>();
  const roots: CdEntry[] = [];
  const ids = new Set(bySeq.map((e) => e.id));
  for (const e of bySeq) {
    if (e.correctsId && ids.has(e.correctsId)) {
      children.set(e.correctsId, [...(children.get(e.correctsId) ?? []), e]);
    } else roots.push(e);
  }
  const out: { entry: CdEntry; depth: number }[] = [];
  const walk = (e: CdEntry, depth: number) => {
    out.push({ entry: e, depth });
    for (const c of children.get(e.id) ?? []) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

export interface FormLike {
  get(name: string): FormDataEntryValue | null;
}

type Errors = Record<string, string>;
export type Read<T> =
  | { readonly ok: true; readonly body: T }
  | { readonly ok: false; readonly errors: Readonly<Errors> };

const text = (form: FormLike, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};
const optional = (form: FormLike, name: string) => text(form, name) || null;

/** A quantity as the number typed: up to 3 decimal places, no leading zero; signed only if allowed. */
export function readCdQuantity(raw: string, signed = false): number | null {
  const pattern = signed ? /^[-+]?(0|[1-9]\d*)(\.\d{1,3})?$/ : /^(0|[1-9]\d*)(\.\d{1,3})?$/;
  if (!pattern.test(raw)) return null;
  const value = Number(raw);
  return Math.abs(value) <= 10_000_000 ? value : null;
}

/** The witness's signature: what they saw, how much, and whom they watched record it. */
export function readWitness(
  form: FormLike,
  t: Translator,
  recorders: ReadonlySet<string>,
): Read<Schemas["AssertWitness"]> {
  const errors: Errors = {};
  const movement = text(form, "movement");
  if (!(WITNESSED as readonly string[]).includes(movement)) {
    errors.movement = t("cd.witness.movementError");
  }
  const signed = movement === "correction";
  const quantity = readCdQuantity(text(form, "quantity"), signed);
  if (quantity === null || (!signed && quantity <= 0 && movement !== "stock_check")) {
    errors.quantity = t("cd.form.quantityError");
  }
  const recorderId = text(form, "recorderId");
  if (!recorders.has(recorderId)) errors.recorderId = t("cd.witness.recorderError");
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      movement: movement as Schemas["AssertWitness"]["movement"],
      quantity: quantity as number,
      administrationId: null,
      recorderId,
    },
  };
}

type Witness = Schemas["CdWitness"];

/** The second signature: one waiting for this recorder, or (where allowed) why there is none. */
function readWitnessChoice(
  form: FormLike,
  t: Translator,
  waiting: ReadonlySet<string>,
  loneAllowed: boolean,
  errors: Errors,
): Witness | null {
  const choice = text(form, "witness");
  if (choice === "none") {
    if (!loneAllowed) {
      errors.witness = t("cd.form.witnessRequired");
      return null;
    }
    const why = text(form, "noWitnessReason");
    if (!why) {
      errors.noWitnessReason = t("cd.form.noWitnessReasonError");
      return null;
    }
    return { noWitnessReason: why };
  }
  if (!waiting.has(choice)) {
    errors.witness = t("cd.form.witnessError");
    return null;
  }
  return { witnessAssertionId: choice };
}

/** A receipt, return, disposal or destruction. */
export function readCdEntry(
  form: FormLike,
  t: Translator,
  options: {
    readonly waiting: ReadonlySet<string>;
    /** The page's policy allows no witness (never for a destruction). */
    readonly loneAllowed: boolean;
    readonly now?: Date;
  },
): Read<Schemas["RecordCdEntry"]> {
  const errors: Errors = {};
  const movement = text(form, "movement");
  if (!(RECORDED_MOVEMENTS as readonly string[]).includes(movement)) {
    errors.movement = t("cd.form.movementError");
  }
  const quantity = readCdQuantity(text(form, "quantity"));
  if (quantity === null || quantity <= 0) errors.quantity = t("cd.form.quantityError");
  const when = readDateTimeField(form, "occurredAt", {
    t,
    optional: true,
    subject: t("cd.form.occurredSubject"),
    ...(options.now ? { now: options.now } : {}),
  });
  if (!when.ok) errors.occurredAt = when.message;
  const witness = readWitnessChoice(
    form,
    t,
    options.waiting,
    options.loneAllowed && movement !== "destruction",
    errors,
  );
  if (Object.keys(errors).length > 0 || !witness || !when.ok) return { ok: false, errors };
  return {
    ok: true,
    body: {
      movement: movement as RecordedMovement,
      quantity: quantity as number,
      occurredAt: when.instant,
      counterparty: optional(form, "counterparty"),
      reference: optional(form, "reference"),
      correctsId: null,
      corrects: null,
      reason: optional(form, "reason"),
      witness,
    },
  };
}

/** A correction of one entry: its quantity (a signed change) or a detail, with a reason. */
export function readCorrection(
  form: FormLike,
  t: Translator,
  options: {
    readonly entries: ReadonlySet<string>;
    readonly waiting: ReadonlySet<string>;
    readonly loneAllowed: boolean;
  },
): Read<Schemas["RecordCdEntry"]> {
  const errors: Errors = {};
  const correctsId = text(form, "correctsId");
  if (!options.entries.has(correctsId)) errors.correctsId = t("cd.correct.entryError");
  const corrects = text(form, "corrects");
  if (corrects !== "quantity" && corrects !== "detail") {
    errors.corrects = t("cd.correct.whatError");
  }
  let quantity = 0;
  if (corrects === "quantity") {
    const q = readCdQuantity(text(form, "quantity"), true);
    if (q === null || q === 0) errors.quantity = t("cd.correct.quantityError");
    else quantity = q;
  }
  const reason = text(form, "reason");
  if (!reason) errors.reason = t("cd.correct.reasonError");
  const witness = readWitnessChoice(form, t, options.waiting, options.loneAllowed, errors);
  if (Object.keys(errors).length > 0 || !witness) return { ok: false, errors };
  return {
    ok: true,
    body: {
      movement: "correction",
      quantity,
      occurredAt: null,
      counterparty: null,
      reference: optional(form, "reference"),
      correctsId,
      corrects: corrects as "quantity" | "detail",
      reason,
      witness,
    },
  };
}

/** A count, witnessed; a reason is asked for by the API when it does not balance. */
export function readStockCheck(
  form: FormLike,
  t: Translator,
  options: { readonly waiting: ReadonlySet<string>; readonly loneAllowed: boolean },
): Read<Schemas["RecordStockCheck"]> {
  const errors: Errors = {};
  const counted = readCdQuantity(text(form, "counted"));
  if (counted === null) errors.counted = t("cd.check.countedError");
  const witness = readWitnessChoice(form, t, options.waiting, options.loneAllowed, errors);
  if (Object.keys(errors).length > 0 || !witness) return { ok: false, errors };
  return {
    ok: true,
    body: { counted: counted as number, reason: optional(form, "reason"), witness },
  };
}

/** The API's refusal codes whose words belong at a field. */
export const CD_FIELD_FOR_PROBLEM: Readonly<Record<string, string>> = {
  cd_stock_check_reason_required: "reason",
  cd_correction_needs_reason: "reason",
  cd_witness_required: "witness",
  cd_witness_blank: "witness",
};
