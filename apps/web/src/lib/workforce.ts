import type { MessageKey, Translator } from "@harbour/i18n";
import type { SafetyChip } from "@/lib/incidents";

/**
 * The workforce screens (plan slice 58; WORK-001, WORK-004, WORK-010, WORK-013): who sees which
 * screen, the form fields the generic form takes, and each status as an icon and a word. The API
 * checks every permission again; these only decide what is offered.
 */

export const RECRUITMENT = "workforce.recruitment.manage";
export const STAFF_FILE_READ = "workforce.staff_file.read";
export const STAFF_FILE_MANAGE = "workforce.staff_file.manage";
export const COMPETENCE_OBSERVE = "workforce.competence.observe";
export const CASEWORK = "workforce.casework.manage";

export const recruitmentShown = (permissions: readonly string[]) =>
  permissions.includes(RECRUITMENT);
export const staffShown = (permissions: readonly string[]) =>
  permissions.includes(STAFF_FILE_READ) || permissions.includes(STAFF_FILE_MANAGE);
/**
 * Employee relations is a restricted silo (ADR-0089): the navigation offers it only to holders of
 * the silo permission. A member named on a case without it reaches the case through its link; the
 * navigation never shows that anyone is on a case.
 */
export const caseworkShown = (permissions: readonly string[]) => permissions.includes(CASEWORK);

export type WorkforceValues = Readonly<Record<string, string | boolean | null>>;

interface FieldBase {
  readonly name: string;
  readonly label: string;
  readonly hint?: string;
  readonly required?: boolean;
  /** What to say when a required field is left empty, when "{label} is needed" does not read well. */
  readonly requiredMessage?: string;
}

export type WorkforceField =
  | (FieldBase & {
      readonly kind: "text";
      readonly maxLength?: number;
      readonly inputMode?: "numeric";
      readonly type?: "email" | "tel";
      readonly autoComplete?: string;
    })
  | (FieldBase & { readonly kind: "textarea"; readonly maxLength?: number })
  | (FieldBase & {
      readonly kind: "select";
      readonly options: readonly { readonly value: string; readonly label: string }[];
      readonly emptyOption?: string;
      readonly defaultValue?: string;
    })
  | (FieldBase & { readonly kind: "date"; readonly defaultValue?: string | null })
  | (FieldBase & { readonly kind: "checkbox" });

/**
 * A code's catalogue words. The API types its codes as strings, so the key is cast here once: every
 * code it sends has an entry, and the catalogue tests prove each family is complete.
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

/** A checklist item's status (induction and leaving), as an icon and a word. */
export function checklistChip(status: string, t: Translator): SafetyChip {
  switch (status) {
    case "done":
      return { status: "done", icon: "circle-check", label: t("workforce.status.done") };
    case "overdue":
      return { status: "overdue", icon: "circle-alert", label: t("workforce.status.overdue") };
    case "not_needed":
      return {
        status: "notApplicable",
        icon: "circle-minus",
        label: t("workforce.status.notNeeded"),
      };
    default:
      return { status: "due", icon: "clock", label: t("workforce.status.outstanding") };
  }
}

/** A Care Certificate standard's status. */
export function standardChip(status: string, t: Translator): SafetyChip {
  switch (status) {
    case "competent":
      return {
        status: "done",
        icon: "circle-check",
        label: t("workforce.careCertificate.competent"),
      };
    case "knowledge_assessed":
      return {
        status: "due",
        icon: "file-pen",
        label: t("workforce.careCertificate.knowledgeAssessed"),
      };
    default:
      return {
        status: "neutral",
        icon: "circle-minus",
        label: t("workforce.careCertificate.notStarted"),
      };
  }
}

/** An application's stage: closed stages read as finished, open ones as in progress. */
export function stageChip(stage: string, t: Translator): SafetyChip {
  const label = codeLabel("workforce.recruitment.stage", stage, t);
  if (stage === "accepted") return { status: "done", icon: "circle-check", label };
  if (stage === "rejected" || stage === "withdrawn" || stage === "declined") {
    return { status: "notApplicable", icon: "circle-minus", label };
  }
  return { status: "info", icon: "clock", label };
}

/** A case's stage: closed reads as finished; anything else in progress. */
export function caseStageChip(stage: string, t: Translator): SafetyChip {
  const label = codeLabel("workforce.cases.stage", stage, t);
  return stage === "closed"
    ? { status: "notApplicable", icon: "circle-minus", label }
    : { status: "info", icon: "clock", label };
}

/** A UK date (yyyy-mm-dd) as dd/mm/yyyy, or empty. */
export function ukDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return y && m && d ? `${d}/${m}/${y}` : "";
}

/** The name of a member of staff from a list of names, or the words for someone unnamed. */
export function nameOf(
  staff: readonly { readonly id: string; readonly displayName: string }[],
  id: string | null | undefined,
  t: Translator,
): string {
  return staff.find((s) => s.id === id)?.displayName ?? t("workforce.someone");
}

/** A list's entries that are there: the API names a member of staff as null when unknown. */
export function present<T>(items: readonly (T | null | undefined)[] | undefined): T[] {
  return (items ?? []).flatMap((item) => (item ? [item] : []));
}

/** Words as one list, in British English: "A, B and C". */
export function listOf(items: readonly string[]): string {
  return new Intl.ListFormat("en-GB", { style: "long", type: "conjunction" }).format(items);
}
