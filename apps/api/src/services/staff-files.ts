import type {
  ComplianceItemKind,
  StaffFileItem,
  StaffFileSummary,
  StaffHrDocument,
} from "@harbour/contracts";
import {
  complianceItem,
  document,
  location,
  staffProfile,
  type Transaction,
  task,
} from "@harbour/db";
import {
  type ComplianceDetail,
  complianceItemView,
  complianceReminderDue,
  requiredItems,
  resolveWorkforceRates,
  SCHEDULE3_ITEMS,
  type StaffProfileFacts,
  type StoredComplianceItem,
  staffFileState,
  ukEndOfDay,
  ukIsoDate,
  WORKFORCE_RATE_KEYS,
  type WorkforceRates,
} from "@harbour/domain";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { rateRows } from "./rates";
import { NO_STAFF, type StaffLookup, staffNames } from "./staff";
import { withSystemRights } from "./system-rights";

/**
 * The staff profile and pre-employment file (workforce.md sections 2a and 5; WORK-002): the
 * stored rows turned into the domain's facts and back into what the API shows, the rate-table
 * figures the rules read, and the expiry reminders raised through the task engine.
 */

export type StaffProfileRow = typeof staffProfile.$inferSelect;
export type ComplianceItemRow = typeof complianceItem.$inferSelect;

export const STAFF_FILE_SOURCE = "staff_profile";
export const COMPLIANCE_ITEM_SOURCE = "compliance_item";
/** The task kind of an expiry reminder (workforce.md section 5). */
export const COMPLIANCE_EXPIRY_TASK = "workforce.compliance_expiry";
/** Who the reminders go to: the built-in HR role (the organisation may give it to anyone). */
export const COMPLIANCE_EXPIRY_ROLE = "hr";
export const STAFF_FILE_MANAGE = "workforce.staff_file.manage";

type Nation = "england" | "wales" | "scotland" | "northern_ireland";

/** The nation whose figures apply: the profile's location's, or England's for organisation-wide roles. */
export async function nationOf(tx: Transaction, locationId: string | null): Promise<Nation> {
  if (!locationId) return "england";
  const [row] = await tx
    .select({ nation: location.nation })
    .from(location)
    .where(eq(location.id, locationId));
  return (row?.nation as Nation | undefined) ?? "england";
}

/** Every workforce figure in force on a UK date, for one nation (tenant override first). */
export async function workforceRates(
  tx: Transaction,
  tenantId: string,
  nation: Nation,
  on: string,
): Promise<WorkforceRates> {
  const rows = await rateRows(tx, Object.values(WORKFORCE_RATE_KEYS));
  return resolveWorkforceRates(rows, nation, on, tenantId);
}

export function profileFacts(row: StaffProfileRow): StaffProfileFacts {
  return {
    workerId: row.tenantUserId,
    registration: row.registrationBody as StaffProfileFacts["registration"],
    previousCareWork: row.previousCareWork,
    startsOn: row.startsOn,
  };
}

export function storedItem(
  row: ComplianceItemRow,
  remindersSent: readonly number[] = [],
): StoredComplianceItem {
  return {
    detail: row.detail as ComplianceDetail,
    verifiedOn: row.verifiedOn,
    verifiedBy: row.verifiedBy,
    riskAssessmentSignedOn: row.riskAssessmentSignedOn,
    riskAssessmentSignedBy: row.riskAssessmentSignedBy,
    remindersSent,
  };
}

/** What a profile's items say on `today`, keyed for the API. */
export function fileState(
  profile: StaffProfileRow,
  items: readonly ComplianceItemRow[],
  today: string,
  rates: WorkforceRates,
) {
  const live = items.filter((i) => i.deletedAt === null);
  const state = staffFileState(
    profileFacts(profile),
    live.map((i) => storedItem(i)),
    today,
    rates,
  );
  return { live, state };
}

export function staffFileSummary(
  profile: StaffProfileRow,
  items: readonly ComplianceItemRow[],
  today: string,
  rates: WorkforceRates,
  names: StaffLookup,
): StaffFileSummary {
  const { state } = fileState(profile, items, today, rates);
  return {
    id: profile.id,
    version: profile.version,
    member: names(profile.tenantUserId) ?? {
      id: profile.tenantUserId,
      displayName: "Member of staff",
      jobTitle: null,
    },
    locationId: profile.locationId,
    jobTitle: profile.jobTitle,
    startsOn: profile.startsOn,
    leftOn: profile.leftOn,
    complete: state.complete,
    outstanding: [...state.outstanding],
    dueSoon: state.items.filter((i) => i.status === "due_soon").map((i) => i.kind),
  };
}

export function staffFileItem(
  profile: StaffProfileRow,
  items: readonly ComplianceItemRow[],
  today: string,
  rates: WorkforceRates,
  names: StaffLookup,
  documents: readonly StaffHrDocument[] | null,
): StaffFileItem {
  const { live, state } = fileState(profile, items, today, rates);
  const required = new Set(requiredItems(profileFacts(profile)));
  const views = SCHEDULE3_ITEMS.map((kind) => {
    const index = live.findIndex((i) => i.kind === kind);
    const row = index >= 0 ? live[index] : undefined;
    const view = index >= 0 ? state.views[index] : undefined;
    const status = required.has(kind)
      ? (state.items.find((i) => i.kind === kind)?.status ?? "missing")
      : "not_required";
    return {
      kind,
      required: required.has(kind),
      status,
      id: row?.id ?? null,
      version: row?.version ?? null,
      detail: (row?.detail as ComplianceDetail | undefined) ?? null,
      verifiedOn: row?.verifiedOn ?? null,
      verifiedBy: names(row?.verifiedBy),
      riskAssessmentSignedOn: row?.riskAssessmentSignedOn ?? null,
      riskAssessmentSignedBy: names(row?.riskAssessmentSignedBy),
      expiresOn: view?.expiresOn ?? null,
      recheckDueOn: view?.recheckDueOn ?? null,
      notes: view ? view.notes.map((n) => ({ ...n })) : [],
    };
  });
  return {
    ...staffFileSummary(profile, items, today, rates, names),
    pathwayCategory: profile.pathwayCategory,
    registrationBody: profile.registrationBody as StaffFileItem["registrationBody"],
    previousCareWork: profile.previousCareWork,
    dateOfBirth: profile.dateOfBirth,
    items: views as StaffFileItem["items"],
    documents: documents ? [...documents] : null,
    asOf: today,
  } as StaffFileItem;
}

/** A profile with its items, as the caller's row-level security finds them. */
export async function loadStaffFile(
  tx: Transaction,
  id: string,
): Promise<{ profile: StaffProfileRow; items: ComplianceItemRow[] } | null> {
  const [profile] = await tx
    .select()
    .from(staffProfile)
    .where(and(eq(staffProfile.id, id), isNull(staffProfile.deletedAt)));
  if (!profile) return null;
  const items = await tx.select().from(complianceItem).where(eq(complianceItem.staffProfileId, id));
  return { profile, items };
}

/**
 * The HR-only documents of a file's items, as the caller can see them: row-level security hides
 * them from anyone without workforce.hr_document.read, so this is only asked for holders.
 */
export async function hrDocuments(
  tx: Transaction,
  items: readonly ComplianceItemRow[],
): Promise<StaffHrDocument[]> {
  if (items.length === 0) return [];
  const kindOf = new Map(items.map((i) => [i.id, i.kind as ComplianceItemKind]));
  const rows = await tx
    .select()
    .from(document)
    .where(
      and(
        eq(document.category, "staff_hr_document"),
        eq(document.subjectType, COMPLIANCE_ITEM_SOURCE),
        inArray(document.subjectId, [...kindOf.keys()]),
        isNull(document.deletedAt),
      ),
    );
  return rows
    .filter((r) => r.status !== "destroyed")
    .map((r) => ({
      id: r.id,
      itemKind: kindOf.get(r.subjectId ?? "") ?? "identity_with_photo",
      title: r.title,
      contentType: r.contentType,
      sizeBytes: r.sizeBytes,
      createdAt: r.createdAt.toISOString(),
      status: r.status,
    }));
}

/** Names for a file's member, verifiers and signers. */
export function namesFor(
  tx: Transaction,
  profiles: readonly StaffProfileRow[],
  items: readonly ComplianceItemRow[],
): Promise<StaffLookup> {
  if (profiles.length === 0) return Promise.resolve(NO_STAFF);
  return staffNames(tx, [
    ...profiles.map((p) => p.tenantUserId),
    ...items.flatMap((i) => [i.verifiedBy, i.riskAssessmentSignedBy]),
  ]);
}

/**
 * Cancels the open expiry reminders of an item whose reminder date changed (a renewal, a new
 * check): the new date's reminders follow from the sweep. The reminders are about no person and
 * no location (review round 1, finding 4), so the caller, who may see the item but not the task,
 * cancels them as the system would, for this item only, and the transaction's context is put back.
 */
export async function endItemReminders(tx: Transaction, itemId: string): Promise<number> {
  return withSystemRights(tx, async () => {
    const ended = await tx
      .update(task)
      .set({ status: "cancelled", statusReason: "Ended: the check was recorded again" })
      .where(
        and(
          eq(task.kind, COMPLIANCE_EXPIRY_TASK),
          eq(task.sourceType, COMPLIANCE_ITEM_SOURCE),
          eq(task.sourceId, itemId),
          inArray(task.status, ["open", "in_progress"]),
        ),
      )
      .returning({ id: task.id });
    return ended.length;
  });
}

/**
 * Expiry reminders (workforce.md rule 1 and section 5): for each item with an expiry or a DBS
 * re-check date, one task at each document-expiry offset before it, once each. The tasks already
 * raised for the item and that date, whatever their status, are the reminders sent; the job never
 * changes the item. Runs as the system in each organisation.
 */
export async function raiseStaffFileReminders(
  tx: Transaction,
  tenantId: string,
  now: Date,
): Promise<number> {
  const today = ukIsoDate(now);
  const rows = await tx
    .select({ item: complianceItem, profile: staffProfile })
    .from(complianceItem)
    .innerJoin(staffProfile, eq(staffProfile.id, complianceItem.staffProfileId))
    .where(
      and(
        isNull(complianceItem.deletedAt),
        isNull(staffProfile.deletedAt),
        or(sql`${staffProfile.leftOn} IS NULL`, sql`${staffProfile.leftOn} >= ${today}`),
        or(
          sql`${complianceItem.expiresOn} IS NOT NULL`,
          sql`${complianceItem.recheckDueOn} IS NOT NULL`,
        ),
      ),
    );
  if (rows.length === 0) return 0;
  const sent = await tx
    .select({ sourceId: task.sourceId, details: task.details })
    .from(task)
    .where(
      and(
        eq(task.kind, COMPLIANCE_EXPIRY_TASK),
        inArray(
          task.sourceId,
          rows.map((r) => r.item.id),
        ),
      ),
    );
  const ratesByNation = new Map<Nation, WorkforceRates>();
  let raised = 0;
  for (const { item, profile } of rows) {
    const nation = await nationOf(tx, profile.locationId);
    const rates = ratesByNation.get(nation) ?? (await workforceRates(tx, tenantId, nation, today));
    ratesByNation.set(nation, rates);
    const facts = profileFacts(profile);
    const view = complianceItemView(storedItem(item), facts, today, rates);
    const dueOn = view.expiresOn ?? view.recheckDueOn;
    const already = sent
      .filter((s) => s.sourceId === item.id)
      .map((s) => s.details as { reminderDays?: number; reminderDueOn?: string } | null)
      .filter((d) => d?.reminderDueOn === dueOn && typeof d?.reminderDays === "number")
      .map((d) => d?.reminderDays as number);
    const due = complianceReminderDue(view, already, today, rates);
    if (!due) continue;
    const nearest = Math.min(
      rates.reminderDaysFirst,
      rates.reminderDaysSecond,
      rates.reminderDaysThird,
    );
    await tx.insert(task).values({
      kind: COMPLIANCE_EXPIRY_TASK,
      title: "Renew a staff check before it expires",
      requiredPermission: STAFF_FILE_MANAGE,
      sourceType: COMPLIANCE_ITEM_SOURCE,
      sourceId: item.id,
      // No location: the care staff working there never see whose check is due (review round 1,
      // finding 4); organisation-wide roles do, and HR's inbox comes with the task port.
      locationId: null,
      assigneeRoleKey: COMPLIANCE_EXPIRY_ROLE,
      dueAt: ukEndOfDay(due.dueOn),
      priority: due.days <= nearest ? "urgent" : "routine",
      details: {
        reminderDays: due.days,
        reminderDueOn: due.dueOn,
        complianceItemKind: item.kind,
        staffProfileId: profile.id,
      },
    });
    raised += 1;
  }
  return raised;
}
