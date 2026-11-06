import { z } from "zod";

/**
 * PRN protocols, outcomes, the organisation's medicine lists and the PRN frequency report (Phase 2
 * slice 28; medicines.md section 16; MEDS-003). Enumerations mirror packages/domain; the API tests
 * keep them in step. The protocol shows the prescriber's limits from the entry; nothing here
 * recommends a dose or a medicine.
 */

const uuid = z.uuid();
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });
const version = z.number().int().min(1);
const words = (max: number) => z.string().trim().min(1).max(max);

export const MedicineListName = z
  .enum(["time_critical", "paracetamol", "bisphosphonate", "psychotropic"])
  .meta({ id: "MedicineListName" });

export const NewMedicineListItem = z
  .strictObject({
    vmpId: z.string().regex(/^[0-9]{6,18}$/),
    productName: words(300),
    reason: words(500).nullable(),
  })
  .meta({ id: "NewMedicineListItem" });

export const RemoveMedicineListItem = z
  .strictObject({ reason: words(500), version })
  .meta({ id: "RemoveMedicineListItem" });

export const MedicineListItemOut = z
  .object({
    id: uuid,
    list: MedicineListName,
    vmpId: z.string(),
    productName: z.string(),
    reason: z.string().nullable(),
    removedAt: isoDateTime.nullable(),
    removedReason: z.string().nullable(),
    version,
  })
  .meta({ id: "MedicineListItem" });

export const MedicineList = z
  .object({ list: MedicineListName, items: z.array(MedicineListItemOut) })
  .meta({ id: "MedicineList" });

const protocolFields = {
  purpose: words(500),
  triggers: z.array(words(300)).min(1).max(20),
  nonDrugAlternatives: z.array(words(300)).max(20),
  purposeGroup: words(120).nullable(),
  orderOfUse: z.number().int().min(1).max(20).nullable(),
  expectedEffect: words(500),
  agreedWithName: words(200),
  agreedWithRole: z.enum(["prescriber", "pharmacist"]),
  agreedOn: isoDate,
  reviewOn: isoDate,
};

export const NewPrnProtocol = z
  .strictObject({ medicationId: uuid, ...protocolFields })
  .meta({ id: "NewPrnProtocol" });

export const ChangePrnProtocol = z
  .strictObject({ ...protocolFields, reason: words(500), version })
  .meta({ id: "ChangePrnProtocol" });

export const WithdrawPrnProtocol = z
  .strictObject({ reason: words(500), version })
  .meta({ id: "WithdrawPrnProtocol" });

export const PrnProtocolOut = z
  .object({
    id: uuid,
    personId: uuid,
    medicationId: uuid,
    medicineId: uuid,
    medicineName: z.string(),
    ...protocolFields,
    /** The prescriber's limits, from the current version of the entry (never a copy). */
    limits: z.object({
      dose: z.string().nullable(),
      maxPer24h: z.number().nullable(),
      minimumIntervalMinutes: z.number().int().nullable(),
      indication: z.string().nullable(),
    }),
    psychotropic: z.boolean(),
    withdrawnOn: isoDate.nullable(),
    withdrawnReason: z.string().nullable(),
    changeReason: z.string().nullable(),
    status: z.enum([
      "in_use",
      "review_overdue",
      "medicine_stopped",
      "not_when_required_now",
      "withdrawn",
    ]),
    statusWords: z.string(),
    version,
  })
  .meta({ id: "PrnProtocol" });

export const PrnProtocolList = z
  .object({ items: z.array(PrnProtocolOut) })
  .meta({ id: "PrnProtocolList" });

export const PrnOutcomeValue = z
  .enum(["effective", "partly_effective", "not_effective", "person_asleep", "could_not_assess"])
  .meta({ id: "PrnOutcomeValue" });

export const RecordPrnOutcome = z
  .strictObject({
    /** The client's UUID: a resend with the same id is the same record. */
    id: uuid,
    outcome: PrnOutcomeValue,
    note: words(2000).nullable(),
    observedAt: isoDateTime,
    /** Set to correct an earlier outcome of the same dose, with a reason. */
    correction: z
      .strictObject({ supersedesId: uuid, reason: words(500) })
      .nullable()
      .default(null),
  })
  .meta({ id: "RecordPrnOutcome" });

export const PrnOutcomeOut = z
  .object({
    id: uuid,
    personId: uuid,
    administrationId: uuid,
    outcome: PrnOutcomeValue,
    outcomeWords: z.string(),
    note: z.string().nullable(),
    observedAt: isoDateTime,
    recordedBy: uuid,
    recordedAt: isoDateTime,
    supersedesId: uuid.nullable(),
    correctionReason: z.string().nullable(),
  })
  .meta({ id: "PrnOutcome" });

export const OutstandingPrnOutcomes = z
  .object({
    items: z.array(
      z.object({
        administrationId: uuid,
        entryId: uuid,
        medicineName: z.string(),
        givenAt: isoDateTime,
        dueAt: isoDateTime,
      }),
    ),
  })
  .meta({ id: "OutstandingPrnOutcomes" });

export const PrnFrequencyReport = z
  .object({
    from: isoDate,
    to: isoDate,
    /** Always shown with the counts: a count for a clinician, never a judgement. */
    note: z.string(),
    items: z.array(
      z.object({
        personId: uuid,
        name: z.string(),
        medicineId: uuid,
        medicineName: z.string(),
        psychotropic: z.boolean(),
        doses: z.number().int(),
        daysWithDoses: z.number().int(),
        /** The most on one calendar day, UK time: not the prescriber's rolling 24 hours. */
        mostInOneDay: z.number().int(),
        withoutProtocol: z.number().int(),
        /** Given under a protocol past its review date. */
        underOverdueProtocol: z.number().int(),
        outcomes: z.record(PrnOutcomeValue, z.number().int()),
        outcomesOutstanding: z.number().int(),
      }),
    ),
  })
  .meta({ id: "PrnFrequencyReport" });

export type NewPrnProtocol = z.infer<typeof NewPrnProtocol>;
export type ChangePrnProtocol = z.infer<typeof ChangePrnProtocol>;
export type PrnProtocolOut = z.infer<typeof PrnProtocolOut>;
export type RecordPrnOutcome = z.infer<typeof RecordPrnOutcome>;
export type PrnOutcomeOut = z.infer<typeof PrnOutcomeOut>;
export type PrnFrequencyReport = z.infer<typeof PrnFrequencyReport>;
export type MedicineListItemOut = z.infer<typeof MedicineListItemOut>;
