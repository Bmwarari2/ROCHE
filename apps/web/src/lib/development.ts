import type { MessageKey, Translator } from "@harbour/i18n";
import type { SafetyChip } from "@/lib/incidents";

/**
 * The training, competence, supervision and revalidation screens (plan slice 57; WORK-005,
 * WORK-008, WORK-009, WORK-012): who sees which screen and form, the form fields the generic form
 * takes, and each status as an icon and a word. The API and the database check every permission
 * again; these only decide what is offered.
 */

export const TRAINING = "workforce.training.manage";
export const OBSERVE = "workforce.competence.observe";
export const SUPERVISION = "workforce.supervision.manage";
export const STAFF_FILE_READ = "workforce.staff_file.read";

const has = (permissions: readonly string[], p: string) => permissions.includes(p);

/** The training matrix and members' records: any of the workforce read permissions. */
export const developmentShown = (permissions: readonly string[]) =>
  [TRAINING, OBSERVE, SUPERVISION, STAFF_FILE_READ].some((p) => has(permissions, p));

/**
 * What the viewer may do on a member's record. Nobody records anything about themselves (the API
 * and the database refuse it too), so every form is withheld on one's own record.
 */
export function developmentActions(permissions: readonly string[], self: boolean) {
  const may = (p: string) => !self && has(permissions, p);
  return {
    recordTraining: may(TRAINING),
    signOff: may(OBSERVE),
    withdraw: may(OBSERVE) || may(TRAINING),
    supervise: may(SUPERVISION),
    revalidation: may(TRAINING),
  };
}

export type DevelopmentValues = Readonly<Record<string, string | boolean | null>>;

interface FieldBase {
  readonly name: string;
  readonly label: string;
  readonly hint?: string;
  readonly required?: boolean;
  /** What to say when a required field is left empty, when "{label} is needed" does not read well. */
  readonly requiredMessage?: string;
}

export type DevelopmentField =
  | (FieldBase & {
      readonly kind: "text";
      readonly maxLength?: number;
      readonly inputMode?: "numeric";
      readonly defaultValue?: string;
    })
  | (FieldBase & { readonly kind: "textarea"; readonly maxLength?: number })
  | (FieldBase & {
      readonly kind: "select";
      readonly options: readonly { readonly value: string; readonly label: string }[];
      readonly emptyOption?: string;
      readonly defaultValue?: string;
    })
  | (FieldBase & { readonly kind: "date"; readonly defaultValue?: string | null })
  | (FieldBase & { readonly kind: "checkbox"; readonly defaultChecked?: boolean });

/**
 * A code's catalogue words. The API types its codes as strings, so the key is cast here once: every
 * code it sends has an entry, and the unit tests prove each family is complete.
 */
export function codeLabel(prefix: string, code: string, t: Translator): string {
  return t(`${prefix}.${code}` as MessageKey);
}

/** Options for a select from codes, each with its catalogue words. */
export function codeOptions(
  codes: readonly string[],
  prefix: string,
  t: Translator,
): { value: string; label: string }[] {
  return codes.map((code) => ({ value: code, label: codeLabel(prefix, code, t) }));
}

/** A training topic's state today, as an icon and a word (lapsed and due soon stand out in words). */
export function trainingChip(status: string, t: Translator): SafetyChip {
  switch (status) {
    case "valid":
      return { status: "done", icon: "circle-check", label: t("development.status.valid") };
    case "due_soon":
      return { status: "due", icon: "clock", label: t("development.status.due_soon") };
    case "expired":
      return { status: "overdue", icon: "circle-alert", label: t("development.status.expired") };
    default:
      return { status: "overdue", icon: "triangle-alert", label: t("development.status.missing") };
  }
}

/** A topic the member's roles do not need: a status of its own, with its own icon. */
export function notNeededChip(t: Translator): SafetyChip {
  return {
    status: "notApplicable",
    icon: "circle-minus",
    label: t("development.matrix.notNeeded"),
  };
}

/** A competence's state for the medicines gate: signed off, or why not. */
export function competenceChip(
  state: { readonly allowed: boolean; readonly reason: string | null },
  t: Translator,
): SafetyChip {
  if (state.allowed) {
    return { status: "done", icon: "circle-check", label: t("development.competence.allowed") };
  }
  return {
    status: "overdue",
    icon: state.reason === "withdrawn" ? "circle-minus" : "circle-alert",
    label: codeLabel("development.competence.reason", state.reason ?? "missing", t),
  };
}

/** The next supervision or appraisal: upcoming, due or overdue. */
export function meetingChip(state: string, t: Translator): SafetyChip {
  if (state === "overdue") {
    return { status: "overdue", icon: "circle-alert", label: t("development.meeting.overdue") };
  }
  if (state === "due") return { status: "due", icon: "clock", label: t("development.meeting.due") };
  return { status: "info", icon: "clock", label: t("development.meeting.upcoming") };
}

/** One revalidation requirement: met, or still to do. */
export function requirementChip(met: boolean, t: Translator): SafetyChip {
  return met
    ? { status: "done", icon: "circle-check", label: t("development.revalidation.met") }
    : { status: "due", icon: "clock", label: t("development.revalidation.outstanding") };
}

/** The statuses a matrix filter offers, worst first. */
export const MATRIX_STATUSES = ["missing", "expired", "due_soon", "valid"] as const;

/** NMC revalidation's requirements, in the order the planner shows them. */
export const REVALIDATION_REQUIREMENTS = [
  "practice_hours",
  "cpd_hours",
  "participatory_cpd_hours",
  "feedback",
  "reflective_accounts",
  "reflective_discussion",
  "health_and_character",
  "professional_indemnity",
  "confirmation",
] as const;

export const SUPERVISION_KINDS = ["supervision", "appraisal", "spot_check"] as const;

/** Counts of a matrix's cells by status, for the summary above it. */
export function matrixCounts(
  members: readonly { readonly cells: readonly { readonly status: string }[] }[],
): Record<(typeof MATRIX_STATUSES)[number], number> {
  const counts = { missing: 0, expired: 0, due_soon: 0, valid: 0 };
  for (const m of members) {
    for (const cell of m.cells) {
      if (cell.status in counts) counts[cell.status as keyof typeof counts] += 1;
    }
  }
  return counts;
}

/** A UK date (yyyy-mm-dd) as dd/mm/yyyy, or empty. */
export function ukDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return y && m && d ? `${d}/${m}/${y}` : "";
}

/** Words as one list, in British English: "A, B and C". */
export function listOf(items: readonly string[]): string {
  return new Intl.ListFormat("en-GB", { style: "long", type: "conjunction" }).format(items);
}

/** A list's entries that are there: the API names a member of staff as null when unknown. */
export function present<T>(items: readonly (T | null | undefined)[] | undefined): T[] {
  return (items ?? []).flatMap((item) => (item ? [item] : []));
}

/** Whether a member's name matches the matrix's name search (any part, ignoring case and accents). */
export function matchesName(name: string, query: string | undefined): boolean {
  const fold = (text: string) =>
    text
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLocaleLowerCase("en-GB")
      .trim();
  const wanted = fold(query ?? "");
  return wanted === "" || fold(name).includes(wanted);
}
