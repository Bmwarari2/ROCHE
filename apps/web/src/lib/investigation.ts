import type { IncidentDetail, InvestigationItem } from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import { formatDate } from "./format";
import type { SafetyChip } from "./incidents";
import type { FieldErrors } from "./outcome";
import { readDateField } from "./uk-time";

/**
 * View logic for an incident's investigation (safety.md section 5; register row SAFE-010; hazard
 * HZ-091): its status and each action's in words and icons, who leads it and owns each action,
 * and reading the form. Pure and unit tested; the API checks everything again. An action with an
 * owner and a date becomes a task for its owner (the API makes it).
 */

/** The API's limits (`UpdateInvestigation`). */
export const INVESTIGATION_LIMITS = {
  findings: 8000,
  lessons: 8000,
  factor: 500,
  factors: 30,
  action: 1000,
  actions: 50,
} as const;

export const INVESTIGATION_METHODS = [
  "root_cause_analysis",
  "five_whys",
  "fishbone",
  "after_action_review",
  "swarm_huddle",
  "other",
] as const;
export type InvestigationMethod = (typeof INVESTIGATION_METHODS)[number];

export const ACTION_STATUSES = ["open", "done", "cancelled"] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

type FormValues = Pick<FormData, "get">;
const text = (form: FormValues, name: string) => String(form.get(name) ?? "").trim();

/** In progress or completed, as an icon and words; one the web does not know warns. */
export function investigationStatusChip(status: string, t: Translator): SafetyChip {
  const label = t("safety.investigation.status", { status });
  if (status === "open") return { status: "info", icon: "search", label };
  if (status === "completed") return { status: "done", icon: "circle-check", label };
  return { status: "overdue", icon: "triangle-alert", label };
}

/**
 * An action's status as an icon and words: open (overdue once its date has passed, by the UK
 * date), done or cancelled; one the web does not know warns.
 */
export function actionStatusChip(
  action: Pick<InvestigationItem["actions"][number], "status" | "dueOn">,
  today: string,
  t: Translator,
): SafetyChip {
  switch (action.status) {
    case "open":
      return action.dueOn && action.dueOn < today
        ? {
            status: "overdue",
            icon: "circle-alert",
            label: t("safety.investigation.actionStatus", { status: "overdue" }),
          }
        : {
            status: "due",
            icon: "clock",
            label: t("safety.investigation.actionStatus", { status: "open" }),
          };
    case "done":
      return {
        status: "done",
        icon: "circle-check",
        label: t("safety.investigation.actionStatus", { status: "done" }),
      };
    case "cancelled":
      return {
        status: "notApplicable",
        icon: "circle-minus",
        label: t("safety.investigation.actionStatus", { status: "cancelled" }),
      };
    default:
      return {
        status: "overdue",
        icon: "triangle-alert",
        label: t("safety.investigation.actionStatus", { status: "unknown" }),
      };
  }
}

/**
 * A member of staff in words: their name where the reader's list of staff has it (managers who
 * manage the team), else "you" or "a colleague", never an id (H-73 note in safety.md section 5).
 */
export function staffName(
  tenantUserId: string | null,
  viewerId: string,
  names: ReadonlyMap<string, string>,
  t: Translator,
): string {
  if (!tenantUserId) return t("safety.investigation.nobody");
  if (tenantUserId === viewerId) return t("safety.incident.who", { who: "you" });
  return names.get(tenantUserId) ?? t("safety.incident.who", { who: "colleague" });
}

/** The people a lead or an owner is chosen from: the reader first, then the team by name. */
export function staffOptions(
  viewerId: string,
  members: readonly { readonly id: string; readonly displayName: string }[],
  current: readonly (string | null)[],
  t: Translator,
): { readonly value: string; readonly label: string }[] {
  const options = new Map<string, string>([[viewerId, t("safety.incident.who", { who: "you" })]]);
  for (const m of members) if (!options.has(m.id)) options.set(m.id, m.displayName);
  // Someone already chosen stays choosable, even when the reader's list does not name them.
  for (const id of current) {
    if (id && !options.has(id)) options.set(id, t("safety.incident.who", { who: "colleague" }));
  }
  return [...options].map(([value, label]) => ({ value, label }));
}

/**
 * Whether the viewer is offered the investigation form: a holder of `safety.incident.manage` on
 * an incident seen whole (the API refuses a restricted reader). An investigation and its actions
 * may outlast the incident's closing, as the API allows.
 */
export function investigationManageable(
  incident: Pick<IncidentDetail, "restricted">,
  permissions: readonly string[],
): boolean {
  return permissions.includes("safety.incident.manage") && !incident.restricted;
}

/** Contributing factors, one per line, blank lines dropped. */
export function readFactors(value: string): string[] | null {
  const lines = value
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length > INVESTIGATION_LIMITS.factors) return null;
  if (lines.some((l) => l.length > INVESTIGATION_LIMITS.factor)) return null;
  return lines;
}

export interface InvestigationInput {
  readonly leadTenantUserId: string | null;
  readonly method: InvestigationMethod | null;
  readonly findings: string | null;
  readonly contributingFactors: readonly string[];
  readonly lessons: string | null;
  readonly actions: readonly {
    readonly id?: string;
    readonly action: string;
    readonly ownerTenantUserId: string | null;
    readonly dueOn: string | null;
    readonly status: ActionStatus;
  }[];
  readonly bulletinPublished: boolean;
  readonly status: "open" | "completed";
}

export type InvestigationRead =
  | { readonly ok: true; readonly input: InvestigationInput }
  | {
      readonly ok: false;
      readonly errors: FieldErrors;
      readonly parts?: Readonly<Record<string, readonly string[]>>;
    };

/**
 * Reads the investigation form: the lead and method (or none yet), the findings, the factors (one
 * per line), the lessons, each action's status (the actions already there keep their words,
 * owner and date, so their tasks stay theirs), one new action with its owner and date, whether to
 * publish the lessons as a bulletin, and whether it is completed. Completing it needs the
 * findings and the lessons, as the API checks; publishing a bulletin needs the lessons.
 */
export function readInvestigationForm(
  form: FormValues,
  current: InvestigationItem | null,
  staff: readonly string[],
  status: "open" | "completed",
  t: Translator,
): InvestigationRead {
  const errors: Record<string, string> = {};
  const parts: Record<string, readonly string[]> = {};
  const person = (name: string): string | null => {
    const value = text(form, name);
    if (!value) return null;
    if (staff.includes(value)) return value;
    errors[name] = t("safety.investigation.error", { field: "person" });
    return null;
  };
  const leadTenantUserId = person("lead");
  const methodValue = text(form, "method");
  const method = (INVESTIGATION_METHODS as readonly string[]).includes(methodValue)
    ? (methodValue as InvestigationMethod)
    : null;
  const findings = text(form, "findings");
  if (findings.length > INVESTIGATION_LIMITS.findings) {
    errors.findings = t("safety.investigation.error", { field: "tooLong" });
  }
  const factors = readFactors(text(form, "factors"));
  if (!factors) errors.factors = t("safety.investigation.error", { field: "factors" });
  const lessons = text(form, "lessons");
  if (lessons.length > INVESTIGATION_LIMITS.lessons) {
    errors.lessons = t("safety.investigation.error", { field: "tooLong" });
  }
  const bulletinPublished = text(form, "bulletin") === "yes";
  if (status === "completed") {
    if (!findings) errors.findings = t("safety.investigation.error", { field: "findings" });
    if (!lessons) errors.lessons = t("safety.investigation.error", { field: "lessons" });
  }
  if (bulletinPublished && !lessons && !errors.lessons) {
    errors.lessons = t("safety.investigation.error", { field: "bulletin" });
  }

  const actions: InvestigationInput["actions"][number][] = (current?.actions ?? []).map((a, i) => {
    const chosen = text(form, `action-${i}-status`);
    const next = (ACTION_STATUSES as readonly string[]).includes(chosen)
      ? (chosen as ActionStatus)
      : a.status;
    return {
      id: a.id,
      action: a.action,
      ownerTenantUserId: a.ownerTenantUserId,
      dueOn: a.dueOn,
      status: next,
    };
  });
  const newAction = text(form, "newAction");
  const newOwner = person("newOwner");
  const due = readDateField(form, "newDueOn", {
    subject: t("safety.investigation.dueSubject"),
    optional: true,
    t,
  });
  if (!due.ok) {
    errors.newDueOn = due.message;
    parts.newDueOn = due.parts;
  }
  if (newAction) {
    if (newAction.length < 3 || newAction.length > INVESTIGATION_LIMITS.action) {
      errors.newAction = t("safety.investigation.error", { field: "action" });
    } else if (actions.length >= INVESTIGATION_LIMITS.actions) {
      errors.newAction = t("safety.investigation.error", { field: "tooManyActions" });
    } else {
      actions.push({
        action: newAction,
        ownerTenantUserId: newOwner,
        dueOn: due.ok ? due.date : null,
        status: "open",
      });
    }
  } else if (newOwner || (due.ok && due.date)) {
    errors.newAction = t("safety.investigation.error", { field: "actionMissing" });
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors, ...(Object.keys(parts).length > 0 ? { parts } : {}) };
  }
  return {
    ok: true,
    input: {
      leadTenantUserId,
      method,
      findings: findings || null,
      contributingFactors: factors ?? [],
      lessons: lessons || null,
      actions,
      bulletinPublished,
      status,
    },
  };
}

/** "Due 01/12/2026", or that no date is set. */
export function actionDue(dueOn: string | null, t: Translator): string {
  const date = formatDate(dueOn);
  return date
    ? t("safety.investigation.due", { date })
    : t("safety.investigation.due", { date: "none" });
}
