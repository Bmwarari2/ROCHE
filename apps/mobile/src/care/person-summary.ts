/**
 * The point-of-care header's care flags (HZ-001 header on every screen; HZ-015 resuscitation;
 * HZ-016 IDDSI). The resuscitation status comes from the active ReSPECT and DNACPR records on the
 * device through `resuscitationStatus` from `@harbour/domain` (the rule the API's person summary
 * uses); with none it reads "not recorded", never blank and never a reassuring default. Records in
 * force that disagree are flagged so staff check the documents. A passed review date does not end
 * a decision: it stays shown, with the overdue review spoken and listed.
 */
import {
  type AdvanceCareKind,
  type AdvanceCareRecordState,
  type AdvanceCareStatus,
  type CprDecision,
  describeIddsiLevel,
  type ResuscitationStatus,
  resuscitationStatus,
} from "@harbour/domain";
import type { HeaderFlag } from "@harbour/ui-native/logic";
import { t } from "../i18n/t";
import { formatIsoDate } from "./time";

/** An `advance_care_record` row as synced. */
export interface AdvanceCareRow {
  readonly id: string;
  readonly person_id?: string | null;
  readonly kind: string | null;
  readonly status: string | null;
  readonly cpr_decision: string | null;
  readonly clinician_name: string | null;
  readonly clinician_role: string | null;
  readonly completed_on: string | null;
  readonly review_due_on: string | null;
}

const KINDS: readonly AdvanceCareKind[] = ["respect", "dnacpr", "adrt", "advance_care_plan"];
const STATUSES: readonly AdvanceCareStatus[] = ["active", "withdrawn", "superseded"];
const DECISIONS: readonly CprDecision[] = ["attempt_cpr", "do_not_attempt_cpr"];

/** Rows the domain rule can read; anything malformed is left out, never guessed. */
export function toAdvanceCareStates(rows: readonly AdvanceCareRow[]): AdvanceCareRecordState[] {
  return rows.flatMap((row) => {
    const kind = KINDS.find((k) => k === row.kind);
    const status = STATUSES.find((s) => s === row.status);
    if (!kind || !status || !row.completed_on) return [];
    return [
      {
        id: row.id,
        kind,
        status,
        cprDecision: DECISIONS.find((d) => d === row.cpr_decision) ?? null,
        completedOn: row.completed_on.slice(0, 10),
        clinicianName: row.clinician_name,
        clinicianRole: row.clinician_role,
        reviewDueOn: row.review_due_on ? row.review_due_on.slice(0, 10) : null,
      },
    ];
  });
}

/** The status the header shows, as a key for the catalogue. */
export function resuscitationKey(
  status: ResuscitationStatus,
): "attempt_cpr" | "do_not_attempt_cpr" | "conflicting" | "not_recorded" {
  if (status.conflicting) return "conflicting";
  return status.status;
}

const APPEARANCE = {
  do_not_attempt_cpr: { tone: "danger", icon: "heart-off" },
  attempt_cpr: { tone: "info", icon: "heart-pulse" },
  conflicting: { tone: "danger", icon: "triangle-alert" },
  not_recorded: { tone: "warning", icon: "circle-help" },
} as const;

/** Where the decision comes from, who made it and whether its review is overdue. */
export function resuscitationDetails(status: ResuscitationStatus): string[] {
  if (status.status === "not_recorded" || !status.kind) return [];
  const lines = [
    t("mobile.header.resuscitationSource", {
      kind: status.kind,
      date: formatIsoDate(status.completedOn) ?? "",
    }),
  ];
  if (status.clinicianName) {
    lines.push(
      t("mobile.header.resuscitationClinician", {
        name: status.clinicianName,
        role: status.clinicianRole ?? "",
      }),
    );
  }
  if (status.reviewOverdue && status.reviewDueOn) {
    lines.push(
      t("mobile.header.resuscitationReviewOverdue", { date: formatIsoDate(status.reviewDueOn) }),
    );
  }
  return lines;
}

/** HZ-015: the resuscitation flag, always present: a decision, a conflict or "not recorded". */
export function resuscitationFlag(
  rows: readonly AdvanceCareRow[],
  today: string,
): { readonly flag: HeaderFlag; readonly status: ResuscitationStatus } {
  const status = resuscitationStatus(toAdvanceCareStates(rows), today);
  const key = resuscitationKey(status);
  const spoken = [
    t("mobile.header.resuscitationSpoken", { status: key }),
    ...resuscitationDetails(status),
  ];
  return {
    status,
    flag: {
      key: "resuscitation",
      tone: APPEARANCE[key].tone,
      icon: APPEARANCE[key].icon,
      label: t("mobile.header.resuscitation", { status: key }),
      accessibilityLabel: spoken.join(" "),
    },
  };
}

/** The `person_care_profile` columns the header reads. */
export interface ProfileLevels {
  readonly iddsi_food_level: string | null;
  readonly iddsi_drink_level: string | null;
}

function level(kind: "food" | "drink", code: string | null): string | null {
  if (!code) return null;
  try {
    return describeIddsiLevel(kind, code);
  } catch {
    // An unknown code is shown as recorded rather than hidden, so staff notice it.
    return code;
  }
}

/**
 * HZ-016: the prescribed IDDSI levels, number, name and colour in words. When the care profile
 * has loaded and is not on the device, a warning says the levels are not recorded (C3), never a
 * blank that reads as "no restriction".
 */
export function iddsiFlags(profile: ProfileLevels | null, loaded = true): HeaderFlag[] {
  if (!profile && loaded) {
    return [
      {
        key: "iddsi-not-recorded",
        tone: "warning",
        icon: "circle-help",
        label: t("mobile.header.iddsiNotRecorded"),
      },
    ];
  }
  const food = level("food", profile?.iddsi_food_level ?? null);
  const drink = level("drink", profile?.iddsi_drink_level ?? null);
  return [
    ...(food
      ? [
          {
            key: "iddsi-food",
            tone: "info",
            icon: "utensils",
            label: t("mobile.header.iddsiFood", { level: food }),
          } as const,
        ]
      : []),
    ...(drink
      ? [
          {
            key: "iddsi-drink",
            tone: "info",
            icon: "utensils",
            label: t("mobile.header.iddsiDrink", { level: drink }),
          } as const,
        ]
      : []),
  ];
}
