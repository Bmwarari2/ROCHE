import { type ExpiryState, expiryState } from "./expiry";

/**
 * The Schedule 3 pre-employment file (workforce.md rule 1; Health and Social Care Act 2008
 * (Regulated Activities) Regulations 2014, regulation 19 and Schedule 3; WORK-002). What a role
 * needs, and whether a worker's file is complete: every required item satisfied and none expired.
 */

export const SCHEDULE3_ITEMS = [
  "identity_with_photo",
  "dbs_certificate",
  "conduct_in_care_work",
  "references",
  "relevant_qualifications",
  "employment_history",
  "health_fitness",
  "right_to_work",
  "professional_registration",
] as const;

export type Schedule3ItemKind = (typeof SCHEDULE3_ITEMS)[number];

/**
 * Checks a role may need beyond Schedule 3, never part of a complete file: driving for work (a
 * DVLA licence check and business-use insurance; H-835).
 */
export const OTHER_COMPLIANCE_ITEMS = ["driving_for_work"] as const;
/** Every kind of compliance item the staff file keeps. */
export const COMPLIANCE_ITEMS = [...SCHEDULE3_ITEMS, ...OTHER_COMPLIANCE_ITEMS] as const;
export type ComplianceItemKindCode = (typeof COMPLIANCE_ITEMS)[number];

/** Registered roles add their professional registration (an NMC PIN for nurses). */
export type RoleRegistration = "nmc" | "hcpc" | "swe" | "gmc" | null;

export interface Schedule3Role {
  readonly registration: RoleRegistration;
  /**
   * Whether the person has worked in health or social care before: if so, evidence of conduct there
   * and why it ended is required (Schedule 3 paragraph 4).
   */
  readonly previousCareWork: boolean;
}

export function requiredItems(role: Schedule3Role): readonly Schedule3ItemKind[] {
  return SCHEDULE3_ITEMS.filter((kind) => {
    if (kind === "professional_registration") return role.registration !== null;
    if (kind === "conduct_in_care_work") return role.previousCareWork;
    return true;
  });
}

export interface Schedule3Item {
  readonly kind: Schedule3ItemKind;
  /** Satisfied once seen and recorded by someone who may (workforce.recruitment.manage). */
  readonly satisfied: boolean;
  /** For an item that expires (right to work, registration): its last valid day. */
  readonly expiresOn: string | null;
  /** Reminder offsets already raised for this expiry. */
  readonly remindersSent?: readonly number[];
}

export interface ItemState {
  readonly kind: Schedule3ItemKind;
  readonly status: "satisfied" | "missing" | "due_soon" | "expired";
  readonly expiry: ExpiryState | null;
}

export interface Schedule3State {
  /** Every required item satisfied and in date: the file is complete. */
  readonly complete: boolean;
  readonly items: readonly ItemState[];
  /** Required items missing or expired, in Schedule 3 order. */
  readonly outstanding: readonly Schedule3ItemKind[];
  /** Reminders to raise today: the item and the offset in days. */
  readonly reminders: readonly { readonly kind: Schedule3ItemKind; readonly days: number }[];
}

export function schedule3State(
  role: Schedule3Role,
  items: readonly Schedule3Item[],
  today: string,
  reminderOffsets: readonly number[],
): Schedule3State {
  const byKind = new Map(items.map((item) => [item.kind, item]));
  const states: ItemState[] = [];
  const reminders: { kind: Schedule3ItemKind; days: number }[] = [];
  for (const kind of requiredItems(role)) {
    const item = byKind.get(kind);
    if (!item?.satisfied) {
      states.push({ kind, status: "missing", expiry: null });
      continue;
    }
    if (item.expiresOn === null) {
      states.push({ kind, status: "satisfied", expiry: null });
      continue;
    }
    const expiry = expiryState(item.expiresOn, today, reminderOffsets, item.remindersSent ?? []);
    if (expiry.reminderDue !== null) reminders.push({ kind, days: expiry.reminderDue });
    states.push({
      kind,
      status:
        expiry.status === "expired"
          ? "expired"
          : expiry.status === "due_soon"
            ? "due_soon"
            : "satisfied",
      expiry,
    });
  }
  const outstanding = states
    .filter((s) => s.status === "missing" || s.status === "expired")
    .map((s) => s.kind);
  return { complete: outstanding.length === 0, items: states, outstanding, reminders };
}
