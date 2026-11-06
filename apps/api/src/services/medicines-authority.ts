import {
  covertMedicationRecord,
  medication,
  selfAdministrationAssessment,
  type Transaction,
} from "@harbour/db";
import {
  type AdministrationEscalation,
  type CovertStatus,
  covertDoseFlags,
  covertStatus,
  type SelfAdminLevel,
  selfAdminDoseFlags,
  selfAdminStatus,
} from "@harbour/domain";
import { and, arrayContains, eq, isNull, sql } from "drizzle-orm";

/**
 * Covert records whose basis has changed since they were written: their capacity assessment or
 * best-interests decision has been corrected, or a later assessment of covert medicines finds the
 * person has capacity (NICE SC1 1.15.1; HZ-026). Such a record no longer covers a dose.
 */
export async function covertBasisChanged(
  tx: Transaction,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const result = await tx.execute<{ id: string }>(sql`
    SELECT r.id::text AS id FROM public.covert_medication_record r
     WHERE r.id IN (${sql.join(
       ids.map((i) => sql`${i}::uuid`),
       sql`, `,
     )})
       AND (EXISTS (SELECT 1 FROM public.capacity_assessment s
                     WHERE s.tenant_id = r.tenant_id AND s.supersedes_id = r.capacity_assessment_id)
         OR EXISTS (SELECT 1 FROM public.best_interests_decision s
                     WHERE s.tenant_id = r.tenant_id AND s.supersedes_id = r.best_interests_decision_id)
         OR EXISTS (SELECT 1 FROM public.capacity_assessment c
                      JOIN public.capacity_assessment l
                        ON l.tenant_id = c.tenant_id AND l.person_id = c.person_id
                     WHERE c.tenant_id = r.tenant_id AND c.id = r.capacity_assessment_id
                       AND l.decision_kind = 'covert_medicines' AND l.outcome = 'has_capacity'
                       AND l.assessed_at > c.assessed_at))`);
  return new Set(result.rows.map((r) => r.id));
}

/**
 * The marks a dose carries from the person's covert records and self-administration assessments
 * (Phase 2 slice 38; medicines.md 15.4; HZ-026, HZ-120). A dose is never refused for them: it
 * has happened and the record must say so (HZ-004). A flag says what was missing and an
 * escalation brings it to the nurse in charge.
 */
export async function authorityMarks(
  tx: Transaction,
  input: {
    readonly personId: string;
    readonly medicationId: string;
    readonly outcome: string;
    readonly covert: boolean;
    /** The UK date of the dose. */
    readonly today: string;
  },
): Promise<{ flags: string[]; escalations: AdministrationEscalation[] }> {
  const flags: string[] = [];
  const escalations: AdministrationEscalation[] = [];
  const selfTaken = input.outcome === "self_administered";
  if (!input.covert && !selfTaken) return { flags, escalations };
  const [entry] = await tx
    .select({ medicineId: medication.medicineId })
    .from(medication)
    .where(eq(medication.id, input.medicationId));
  if (!entry) return { flags, escalations };
  if (input.covert) {
    const records = await tx
      .select({
        id: covertMedicationRecord.id,
        startsOn: covertMedicationRecord.startsOn,
        reviewOn: covertMedicationRecord.reviewOn,
        endedOn: covertMedicationRecord.endedOn,
      })
      .from(covertMedicationRecord)
      .where(
        and(
          eq(covertMedicationRecord.personId, input.personId),
          eq(covertMedicationRecord.medicineId, entry.medicineId),
          isNull(covertMedicationRecord.deletedAt),
        ),
      );
    const changed = await covertBasisChanged(
      tx,
      records.map((r) => r.id),
    );
    const statuses: CovertStatus[] = records.map((r) =>
      covertStatus({ ...r, basisChanged: changed.has(r.id) }, input.today),
    );
    const mark = covertDoseFlags(statuses);
    if (mark) {
      flags.push(mark.flag);
      escalations.push({
        severity: mark.urgent ? "urgent" : "warning",
        reason: "review",
        message: mark.urgent
          ? "A dose was given covertly with no current covert record for this medicine: check the best-interests decision now."
          : "A dose was given covertly while the covert record's review is overdue: arrange the review.",
      });
    }
  }
  if (selfTaken) {
    const assessments = await tx
      .select({
        assessedOn: selfAdministrationAssessment.assessedOn,
        recordedAt: selfAdministrationAssessment.recordedAt,
        reviewOn: selfAdministrationAssessment.reviewOn,
        level: selfAdministrationAssessment.level,
        medicineIds: selfAdministrationAssessment.medicineIds,
      })
      .from(selfAdministrationAssessment)
      .where(
        and(
          eq(selfAdministrationAssessment.personId, input.personId),
          arrayContains(selfAdministrationAssessment.medicineIds, [entry.medicineId]),
        ),
      );
    const state = selfAdminStatus(
      assessments.map((a) => ({ ...a, level: a.level as SelfAdminLevel })),
      entry.medicineId,
      input.today,
    );
    const mark = selfAdminDoseFlags(state);
    if (mark) {
      flags.push(mark.flag);
      if (mark.escalate) {
        escalations.push({
          severity: "warning",
          reason: "review",
          message:
            "The person took this medicine themselves with no assessment that they look after it: assess and record it.",
        });
      }
    }
  }
  return { flags, escalations };
}
