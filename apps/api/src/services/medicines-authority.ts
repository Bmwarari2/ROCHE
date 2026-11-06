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
import { and, arrayContains, eq, isNull } from "drizzle-orm";

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
    const statuses: CovertStatus[] = records.map((r) => covertStatus(r, input.today));
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
