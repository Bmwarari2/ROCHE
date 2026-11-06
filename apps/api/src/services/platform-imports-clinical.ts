import { randomUUID } from "node:crypto";
import {
  carePlan,
  carePlanSection,
  complianceItem,
  person,
  staffProfile,
  type Transaction,
  task,
  tenantUser,
} from "@harbour/db";
import {
  type ClinicalDryRun,
  type ClinicalRecordType,
  type ComplianceDetail,
  carePlanDrafts,
  clinicalDryRun,
  complianceItemView,
  type ImportError,
  type ImportValidation,
  importRowError,
  type MarEntry,
  medicineRowDraft,
  staffFileRowDetail,
  transcribeMarEntry,
  ukIsoDate,
  validateClinicalImport,
} from "@harbour/domain";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { MedicinesPorts } from "../integrations/medicines-ports";
import { insertEntry, personEntries } from "./medicines";
import { stagedRows } from "./platform-imports";
import {
  type ComplianceItemRow,
  nationOf,
  profileFacts,
  storedItem,
  workforceRates,
} from "./staff-files";

/**
 * Importing medicines, care plans and staff files (platform.md rules 27 to 31; slice 51). The dry
 * run checks every row against its type's rules and then against the records: the person or staff
 * file its identifier names (never a name), the dm+d product and the medicines rules, a draft or a
 * check already there. It returns what the commit writes, so the commit writes exactly what the
 * dry run checked, with the batch locked. Nothing here logs or echoes a value.
 */

export interface ClinicalImportContext {
  readonly tenantId: string;
  readonly tenantUserId: string;
  readonly allowTestNhsNumbers: boolean;
  readonly medicines: MedicinesPorts;
}

type Planned =
  | {
      readonly kind: "medicines";
      readonly entries: readonly MarEntry[];
      /** Each person's home, for the task to check their imported medicines. */
      readonly homes: ReadonlyMap<string, string | null>;
    }
  | {
      readonly kind: "care_plans";
      readonly plans: readonly {
        readonly personId: string;
        readonly locationId: string;
        readonly sections: ReturnType<typeof carePlanDrafts>[number]["sections"];
      }[];
    }
  | {
      readonly kind: "staff_files";
      readonly items: readonly {
        readonly staffProfileId: string;
        readonly detail: ComplianceDetail;
        readonly expiresOn: string | null;
        readonly recheckDueOn: string | null;
      }[];
    };

export interface ClinicalDryRunResult {
  readonly validation: ImportValidation;
  readonly report: ClinicalDryRun;
  readonly planned: Planned;
}

/** People by NHS number, among those the importer may read (every one, organisation-wide). */
async function peopleByNhs(tx: Transaction, numbers: readonly string[]) {
  const wanted = [...new Set(numbers.filter(Boolean))];
  if (wanted.length === 0) {
    return new Map<string, { id: string; locationId: string; current: boolean }>();
  }
  const rows = await tx
    .select({
      id: person.id,
      nhsNumber: person.nhsNumber,
      locationId: person.locationId,
      status: person.status,
    })
    .from(person)
    .where(and(inArray(person.nhsNumber, wanted), isNull(person.deletedAt)));
  return new Map(
    rows.map((r) => [
      r.nhsNumber ?? "",
      { id: r.id, locationId: r.locationId, current: RECEIVING_CARE.has(r.status) },
    ]),
  );
}

/**
 * People receiving care now (slice 51 clinical review, 5): an export may still list someone who
 * has left or died, and nothing clinical is imported for them.
 */
const RECEIVING_CARE: ReadonlySet<string> = new Set(["active", "on_leave", "in_hospital"]);

const notCurrent = (row: number): ImportError =>
  importRowError(row, "person_nhs_number", "person_not_current", "");

/** A medicines rule's refusal as plain words with no value (security review of slice 51, L3). */
const MEDICINE_REFUSALS: Readonly<Record<string, string>> = {
  same_product_in_force:
    "This medicine is already on the person's MAR, or on an earlier row of the file. Change it on the MAR instead.",
  route_not_permitted: "The route is not one dm+d gives for this medicine.",
  product_not_dmd: "The medicine must be a dm+d product.",
  indication_required: "Give the indication for a when-required medicine.",
  prescriber_required: "Give the prescriber.",
  source_required: "Give the source and its reference.",
  stops_before_starts: "The stop date must be after the start date.",
};
const medicineRefused = (row: number, problem: string): ImportError => ({
  row,
  column: "vmp_id",
  code: "medicine_refused",
  message:
    MEDICINE_REFUSALS[problem] ??
    "The medicine cannot be recorded like this: check the dose, its unit and the times against dm+d and the source.",
});

const notFound = (row: number): ImportError =>
  importRowError(row, "person_nhs_number", "person_not_found", "NHS number");

async function medicinesDryRun(
  tx: Transaction,
  ctx: ClinicalImportContext,
  validation: ImportValidation,
): Promise<{ errors: ImportError[]; planned: Planned }> {
  const errors: ImportError[] = [];
  const entries: MarEntry[] = [];
  const people = await peopleByNhs(
    tx,
    validation.rows.map((r) => r.person_nhs_number ?? ""),
  );
  const erroneous = new Set(validation.errors.map((e) => e.row));
  const earlierByPerson = new Map<string, MarEntry[]>();
  const now = new Date();
  for (const [index, row] of validation.rows.entries()) {
    const n = index + 1;
    if (erroneous.has(n) || erroneous.has(0)) continue;
    const found = people.get(row.person_nhs_number ?? "");
    if (!found) {
      errors.push(notFound(n));
      continue;
    }
    if (!found.current) {
      errors.push(notCurrent(n));
      continue;
    }
    // dm+d's own facts by code: an unknown code is refused, never guessed (HZ-005).
    const facts = await ctx.medicines.dmd.facts({
      vmpId: row.vmp_id ?? "",
      ampId: row.amp_id ?? null,
    });
    if (!facts) {
      errors.push(importRowError(n, "vmp_id", "dmd_unknown", "This dm+d code"));
      continue;
    }
    const draft = medicineRowDraft(row, found.id, {
      name: facts.name,
      routeName: facts.permittedRoutes.find((r) => r.code === row.route_code)?.name ?? "",
      unitName: facts.permittedDoseUnits.find((u) => u.code === row.dose_unit_code)?.name ?? "",
    });
    let earlier = earlierByPerson.get(found.id);
    if (!earlier) {
      earlier = (await personEntries(tx, found.id)).map((s) => s.entry);
      earlierByPerson.set(found.id, earlier);
    }
    const result = transcribeMarEntry(draft, facts, {
      id: randomUUID(),
      by: ctx.tenantUserId,
      at: now,
      origin: "import",
      earlierEntries: earlier,
    });
    if (!result.ok) {
      for (const problem of new Set(result.issues.map((x) => x.problem))) {
        errors.push(medicineRefused(n, problem));
      }
      continue;
    }
    // A later row for the same person and product meets this one, as on the MAR (rule 6).
    earlier.push(result.entry);
    entries.push(result.entry);
  }
  const homes = new Map([...people.values()].map((p) => [p.id, p.locationId]));
  return { errors, planned: { kind: "medicines", entries, homes } };
}

async function carePlansDryRun(
  tx: Transaction,
  validation: ImportValidation,
): Promise<{ errors: ImportError[]; planned: Planned }> {
  const errors: ImportError[] = [];
  const people = await peopleByNhs(
    tx,
    validation.rows.map((r) => r.person_nhs_number ?? ""),
  );
  const ids = [...people.values()].map((p) => p.id);
  const withDraft = new Set(
    ids.length === 0
      ? []
      : (
          await tx
            .select({ personId: carePlan.personId })
            .from(carePlan)
            .where(
              and(
                inArray(carePlan.personId, ids),
                eq(carePlan.status, "draft"),
                isNull(carePlan.deletedAt),
              ),
            )
        ).map((r) => r.personId),
  );
  const plans: Extract<Planned, { kind: "care_plans" }>["plans"][number][] = [];
  for (const draft of carePlanDrafts(validation.rows)) {
    const found = people.get(draft.nhsNumber);
    if (!found) {
      for (const n of draft.rows) errors.push(notFound(n));
      continue;
    }
    if (!found.current) {
      for (const n of draft.rows) errors.push(notCurrent(n));
      continue;
    }
    if (withDraft.has(found.id)) {
      for (const n of draft.rows) {
        errors.push(importRowError(n, "person_nhs_number", "care_plan_draft_exists", ""));
      }
      continue;
    }
    const locationId = found.locationId;
    plans.push({ personId: found.id, locationId, sections: draft.sections });
  }
  return { errors, planned: { kind: "care_plans", plans } };
}

async function staffFilesDryRun(
  tx: Transaction,
  ctx: ClinicalImportContext,
  validation: ImportValidation,
): Promise<{ errors: ImportError[]; planned: Planned }> {
  const errors: ImportError[] = [];
  const emails = [
    ...new Set(validation.rows.map((r) => (r.member_email ?? "").toLowerCase()).filter(Boolean)),
  ];
  const files =
    emails.length === 0
      ? []
      : await tx
          .select({ profile: staffProfile, email: tenantUser.email })
          .from(staffProfile)
          .innerJoin(tenantUser, eq(tenantUser.id, staffProfile.tenantUserId))
          .where(
            and(
              inArray(sql`lower(${tenantUser.email})`, emails),
              eq(tenantUser.status, "active"),
              isNull(staffProfile.deletedAt),
            ),
          );
  // Two members whose emails differ only in case match nobody (security review of slice 51, L2).
  const counts = new Map<string, number>();
  for (const f of files) {
    const e = f.email.toLowerCase();
    counts.set(e, (counts.get(e) ?? 0) + 1);
  }
  const ambiguous = new Set([...counts].filter(([, n]) => n > 1).map(([e]) => e));
  const byEmail = new Map(
    files
      .filter((f) => !ambiguous.has(f.email.toLowerCase()))
      .map((f) => [f.email.toLowerCase(), f.profile]),
  );
  const profileIds = files.map((f) => f.profile.id);
  const existing: ComplianceItemRow[] =
    profileIds.length === 0
      ? []
      : await tx
          .select()
          .from(complianceItem)
          .where(
            and(
              inArray(complianceItem.staffProfileId, profileIds),
              isNull(complianceItem.deletedAt),
            ),
          );
  const erroneous = new Set(validation.errors.map((e) => e.row));
  const today = ukIsoDate(new Date());
  const items: Extract<Planned, { kind: "staff_files" }>["items"][number][] = [];
  for (const [index, row] of validation.rows.entries()) {
    const n = index + 1;
    if (erroneous.has(n) || erroneous.has(0)) continue;
    const email = (row.member_email ?? "").toLowerCase();
    if (ambiguous.has(email)) {
      errors.push(importRowError(n, "member_email", "staff_file_ambiguous", "Work email"));
      continue;
    }
    const profile = byEmail.get(email);
    if (!profile) {
      errors.push(importRowError(n, "member_email", "staff_file_not_found", "Work email"));
      continue;
    }
    if (profile.tenantUserId === ctx.tenantUserId) {
      errors.push(importRowError(n, "member_email", "own_staff_file", ""));
      continue;
    }
    if (existing.some((i) => i.staffProfileId === profile.id && i.kind === row.kind)) {
      errors.push(importRowError(n, "kind", "check_already_recorded", ""));
      continue;
    }
    const detail = staffFileRowDetail(row);
    const rates = await workforceRates(
      tx,
      ctx.tenantId,
      await nationOf(tx, profile.locationId),
      today,
    );
    const draft = {
      detail,
      verifiedOn: null,
      verifiedBy: null,
      riskAssessmentSignedOn: null,
      riskAssessmentSignedBy: null,
    } as unknown as ComplianceItemRow;
    const view = complianceItemView(storedItem(draft), profileFacts(profile), today, rates);
    items.push({
      staffProfileId: profile.id,
      detail,
      expiresOn: view.expiresOn,
      recheckDueOn: view.recheckDueOn,
    });
  }
  return { errors, planned: { kind: "staff_files", items } };
}

/** The dry run of a staged medicines, care plans or staff files batch (rule 31). */
export async function clinicalDryRunNow(
  tx: Transaction,
  batchId: string,
  recordType: ClinicalRecordType,
  ctx: ClinicalImportContext,
): Promise<ClinicalDryRunResult> {
  const rows = await stagedRows(tx, batchId);
  const validation = validateClinicalImport(recordType, rows, {
    today: ukIsoDate(new Date()),
    allowTestNhsNumbers: ctx.allowTestNhsNumbers,
  });
  const checked =
    recordType === "medicines"
      ? await medicinesDryRun(tx, ctx, validation)
      : recordType === "care_plans"
        ? await carePlansDryRun(tx, validation)
        : await staffFilesDryRun(tx, ctx, validation);
  const planned = checked.planned;
  const count =
    planned.kind === "medicines"
      ? planned.entries.length
      : planned.kind === "care_plans"
        ? planned.plans.length
        : planned.items.length;
  const { validation: all, report } = clinicalDryRun(recordType, validation, checked.errors, count);
  return { validation: all, report, planned };
}

/** The task raised for each person whose medicines an import added (HZ-003, rule 28). */
export const MEDICINES_IMPORT_CHECK = "medicines.import_check";

/** The audit action written once per record a commit creates (rule 27). */
export const CLINICAL_IMPORTED: Readonly<
  Record<ClinicalRecordType, { action: string; resourceType: string }>
> = {
  medicines: { action: "medicines.entry.imported", resourceType: "medication" },
  care_plans: { action: "care.plan.imported", resourceType: "care_plan" },
  staff_files: { action: "workforce.compliance_item.imported", resourceType: "compliance_item" },
};

/**
 * Writes what the dry run planned, tied to the batch (rules 28 to 30): medicines not yet checked,
 * care plans as drafts, staff file checks unverified. Returns the ids of the records created, in
 * file order. The batch is still staged after its dry run, as the database's guard requires.
 */
export async function commitClinical(
  tx: Transaction,
  batchId: string,
  planned: Planned,
): Promise<string[]> {
  const created: string[] = [];
  if (planned.kind === "medicines") {
    for (const entry of planned.entries) {
      await insertEntry(tx, entry, entry.id, { importBatchId: batchId });
      created.push(entry.id);
    }
    // HZ-003 (slice 51 clinical review): every imported medicine is held until its second check,
    // so each person gets an urgent task to have them checked before their next round.
    const people = [...new Set(planned.entries.map((e) => e.personId))];
    if (people.length > 0) {
      await tx.insert(task).values(
        people.map((personId) => ({
          kind: MEDICINES_IMPORT_CHECK,
          title: "Check imported medicines against their source before the next round",
          requiredPermission: "medicines.record.manage",
          personId,
          locationId: planned.homes.get(personId) ?? null,
          sourceType: "import_batch",
          sourceId: batchId,
          assigneeRoleKey: "registered_manager",
          dueAt: new Date(),
          priority: "urgent" as const,
          details: {
            importedMedicines: planned.entries.filter((e) => e.personId === personId).length,
          },
        })),
      );
    }
  } else if (planned.kind === "care_plans") {
    for (const plan of planned.plans) {
      const [draft] = await tx
        .insert(carePlan)
        .values({
          personId: plan.personId,
          locationId: plan.locationId,
          status: "draft",
          importBatchId: batchId,
        })
        .returning({ id: carePlan.id });
      if (!draft) throw new Error("care plan not created");
      for (const s of plan.sections) {
        await tx.insert(carePlanSection).values({
          personId: plan.personId,
          planId: draft.id,
          domain: s.domain,
          need: s.need,
          outcome: s.outcome,
          strengths: s.strengths,
          contingency: s.contingency,
        });
      }
      created.push(draft.id);
    }
  } else {
    for (const item of planned.items) {
      const [saved] = await tx
        .insert(complianceItem)
        .values({
          staffProfileId: item.staffProfileId,
          kind: item.detail.kind,
          detail: item.detail,
          verifiedOn: null,
          verifiedBy: null,
          expiresOn: item.expiresOn,
          recheckDueOn: item.recheckDueOn,
          importBatchId: batchId,
        })
        .returning({ id: complianceItem.id });
      if (!saved) throw new Error("compliance item not created");
      created.push(saved.id);
    }
  }
  return created;
}
