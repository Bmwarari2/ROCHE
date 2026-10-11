import {
  aboutMe,
  advanceCareRecord,
  allergy,
  capacityAssessment,
  contact,
  document,
  dolsAuthorisation,
  person,
  personCareProfile,
  preAdmissionAssessment,
  propertyItem,
  type Transaction,
} from "@harbour/db";
import {
  type AboutMeDocument,
  type AdvanceCareSummary,
  type AllergyStatement,
  assembleHospitalTransferPack,
  type CommunicationStatement,
  type DocumentStoragePort,
  type HospitalTransferInput,
  type IddsiDrinkLevel,
  type IddsiFoodLevel,
  type MedicinesStatement,
  type PersonStatus,
  type ResuscitationStatement,
  type TransferAllergy,
  type TransferPackResult,
  type TransferPropertyItem,
  ukIsoDate,
} from "@harbour/domain";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { capacityViews } from "./mca";
import { isPrintableImage } from "./pdf";
import type { PersonRecord } from "./people";
import { ukDate } from "./transfer-pack-pdf";

/**
 * The hospital transfer pack from the record (people.md rule 10; HZ-001, HZ-007, HZ-015, HZ-016,
 * HZ-023). Every section is read as recorded, with the person it belongs to and when it was last
 * updated, and `assembleHospitalTransferPack` does the rest: it refuses a pack for someone not
 * receiving care or with any section belonging to someone else, and otherwise always produces
 * one, flagging every missing safety-critical section as "not recorded".
 *
 * Sources until later modules land: medicines come from the pre-admission medicines section until
 * the eMAR (Phase 2); resuscitation from the advance care records, with no positive "no decision
 * in place" statement yet (people.md section 11), so none recorded reads "not recorded".
 */

const SEVERITIES = ["mild", "moderate", "severe", "unknown"] as const;

/** Image types the printed pack can carry (transfer-pack-pdf.ts). */
export const PRINTABLE_PHOTO_TYPES: readonly string[] = ["image/jpeg", "image/png"];

interface MedicinesSection {
  readonly status?: string;
  readonly medicines?: readonly {
    name: string;
    dose: string;
    route: string;
    frequency: string;
    timeCritical?: boolean;
  }[];
  readonly notes?: string | null;
  readonly completedBy?: string | null;
  readonly completedAt?: string | null;
}

/**
 * Medicines from the pre-admission assessment until the eMAR (Phase 2). The list is from before
 * admission, so it never says "no current medicines": an empty list reads "not recorded since
 * admission, check the MAR", and a list is marked as needing checking against the MAR.
 */
function medicinesFrom(section: MedicinesSection | undefined): MedicinesStatement {
  if (section?.status !== "complete" || !section.completedAt) {
    return { status: "not_recorded" };
  }
  const items = section.medicines ?? [];
  if (items.length === 0) return { status: "not_recorded" };
  return {
    status: "recorded",
    source: "pre_admission_assessment",
    items: items.map((m) => ({
      name: m.name,
      dose: m.dose,
      route: m.route,
      frequency: m.frequency,
      lastGivenAt: null,
      timeCritical: m.timeCritical === true,
    })),
  };
}

const CPR_WORDS: Record<string, string> = {
  attempt_cpr: "For cardiopulmonary resuscitation",
  do_not_attempt_cpr: "Not for cardiopulmonary resuscitation",
};

export interface TransferPackRequest {
  readonly reasonForTransfer: string | null;
  readonly sendItemIds: readonly string[];
  readonly generatedBy: string;
  readonly now: Date;
}

/** Gathers the record and assembles the pack (never interpreted; HZ-023). */
export async function assemblePackFor(
  tx: Transaction,
  p: PersonRecord,
  request: TransferPackRequest,
): Promise<TransferPackResult> {
  return assembleHospitalTransferPack(await transferPackInput(tx, p, request));
}

export async function transferPackInput(
  tx: Transaction,
  p: PersonRecord,
  request: TransferPackRequest,
): Promise<HospitalTransferInput> {
  const { now } = request;

  // Photo: the document's own person decides whose it is, so a misfiled photo refuses the pack.
  // Only JPEG and PNG photos go on the printed pack; anything else is flagged on the first page.
  let photo: HospitalTransferInput["photo"] = null;
  if (p.photoDocumentId) {
    const [doc] = await tx
      .select({
        personId: document.personId,
        createdAt: document.createdAt,
        contentType: document.contentType,
        imagePrintable: document.imagePrintable,
      })
      .from(document)
      .where(eq(document.id, p.photoDocumentId));
    if (doc) {
      // Whether it prints was decided once, when it was uploaded (or by `decidePhotoPrintable`
      // before this transaction for an older photo): a 16-bit or interlaced PNG, a truncated file
      // or one over the size limit does not print, so page 1 names it and the hand-over needs an
      // acknowledgement. Nothing is decoded here.
      const printable =
        PRINTABLE_PHOTO_TYPES.includes(doc.contentType) && doc.imagePrintable === true;
      photo = {
        personId: doc.personId ?? "",
        asOf: doc.createdAt,
        data: { documentId: p.photoDocumentId, takenOn: ukIsoDate(doc.createdAt), printable },
      };
    }
  }

  // Allergies (HZ-007): unknown is never shown as none.
  const allergies = await tx
    .select()
    .from(allergy)
    .where(
      and(eq(allergy.personId, p.id), eq(allergy.status, "active"), isNull(allergy.deletedAt)),
    );
  let allergyStatement: AllergyStatement;
  if (p.allergyStatus === "no_known_allergies") {
    // Who set the status and when (a trigger keeps them), never the last edit of the row.
    allergyStatement = {
      status: "no_known_allergies",
      recordedBy: p.allergyStatusConfirmedBy,
      recordedAt: p.allergyStatusConfirmedAt,
    };
  } else if (p.allergyStatus === "has_allergies") {
    allergyStatement = {
      status: "has_allergies",
      allergies: allergies.map(
        (a): TransferAllergy => ({
          substance: a.substance,
          reaction: a.reaction,
          severity: (SEVERITIES as readonly string[]).includes(a.severity)
            ? (a.severity as TransferAllergy["severity"])
            : "unknown",
        }),
      ),
    };
  } else {
    allergyStatement = { status: "unknown" };
  }
  const allergiesAsOf = allergies.reduce<Date | null>(
    (latest, a) => (latest === null || a.updatedAt > latest ? a.updatedAt : latest),
    p.allergyStatusConfirmedAt,
  );

  // Medicines: the pre-admission list until the eMAR (Phase 2).
  const [assessment] = await tx
    .select()
    .from(preAdmissionAssessment)
    .where(and(eq(preAdmissionAssessment.personId, p.id), isNull(preAdmissionAssessment.deletedAt)))
    .orderBy(desc(preAdmissionAssessment.updatedAt))
    .limit(1);
  const sections = (assessment?.sections ?? {}) as Record<string, MedicinesSection>;
  const medicinesSection = sections.medicines;
  const medicines: HospitalTransferInput["medicines"] = {
    personId: assessment?.personId ?? p.id,
    asOf: medicinesSection?.completedAt ? new Date(medicinesSection.completedAt) : null,
    data: medicinesFrom(medicinesSection),
  };

  // Communication needs (HZ-023): an empty list is "not recorded" until someone confirms none.
  const needs = Array.isArray(p.communicationNeeds)
    ? (p.communicationNeeds as { code: string; display: string; preferredFormat?: string }[])
    : [];
  let communication: CommunicationStatement;
  if (needs.length > 0) {
    communication = {
      status: "recorded",
      needs: needs.map((n) => ({
        code: n.code,
        display: n.display,
        preferredFormat: n.preferredFormat ?? "",
      })),
      confirmedBy: p.communicationNeedsConfirmedBy,
      confirmedAt: p.communicationNeedsConfirmedAt,
    };
  } else if (
    p.communicationNeedsStatus === "none_identified" &&
    p.communicationNeedsConfirmedBy &&
    p.communicationNeedsConfirmedAt
  ) {
    communication = {
      status: "none_identified",
      confirmedBy: p.communicationNeedsConfirmedBy,
      confirmedAt: p.communicationNeedsConfirmedAt,
    };
  } else {
    communication = { status: "not_recorded" };
  }

  // Resuscitation (HZ-015): the advance care records in force, as recorded.
  const records = await tx
    .select()
    .from(advanceCareRecord)
    .where(and(eq(advanceCareRecord.personId, p.id), isNull(advanceCareRecord.deletedAt)));
  const summaries: AdvanceCareSummary[] = records.map((r) => ({
    id: r.id,
    kind: r.kind as AdvanceCareSummary["kind"],
    cprDecision: (r.cprDecision ?? null) as AdvanceCareSummary["cprDecision"],
    summary:
      [r.cprDecision ? CPR_WORDS[r.cprDecision] : null, r.details].filter(Boolean).join(". ") ||
      "See the scanned form",
    clinician: [r.clinicianName, r.clinicianRole].filter(Boolean).join(", ") || "Not recorded",
    completedOn: r.completedOn,
    reviewOn: r.reviewDueOn,
    documentId: r.documentId,
    active: r.status === "active",
  }));
  const resuscitation: ResuscitationStatement =
    summaries.length > 0 ? { status: "recorded", records: summaries } : { status: "not_recorded" };
  const resuscitationAsOf = records.reduce<Date | null>(
    (latest, r) => (latest === null || r.updatedAt > latest ? r.updatedAt : latest),
    null,
  );

  // About Me.
  const [aboutMeRow] = await tx.select().from(aboutMe).where(eq(aboutMe.personId, p.id));

  // Eating and drinking (HZ-016): the IDDSI codes exactly as the care profile holds them.
  const [profile] = await tx
    .select()
    .from(personCareProfile)
    .where(eq(personCareProfile.personId, p.id));
  const eatingAndDrinking: HospitalTransferInput["eatingAndDrinking"] =
    profile && (profile.iddsiFoodLevel || profile.iddsiDrinkLevel)
      ? {
          personId: profile.personId,
          asOf: profile.iddsiChangedAt ?? profile.updatedAt,
          data: {
            foodLevel: (profile.iddsiFoodLevel ?? null) as IddsiFoodLevel | null,
            drinkLevel: (profile.iddsiDrinkLevel ?? null) as IddsiDrinkLevel | null,
            notes: profile.iddsiAdvisedBy ? `Levels advised by ${profile.iddsiAdvisedBy}` : null,
          },
        }
      : null;

  // Capacity, DoLS and legal representatives: the current assessments as recorded.
  const assessments = capacityViews(
    await tx.select().from(capacityAssessment).where(eq(capacityAssessment.personId, p.id)),
  );
  const assessmentRows =
    assessments.length === 0
      ? []
      : await tx
          .select({
            id: capacityAssessment.id,
            personId: capacityAssessment.personId,
            decision: capacityAssessment.decision,
            outcome: capacityAssessment.outcome,
            assessedAt: capacityAssessment.assessedAt,
          })
          .from(capacityAssessment)
          .where(
            inArray(
              capacityAssessment.id,
              assessments.map((a) => a.id),
            ),
          );
  const dols = await tx
    .select({ grantedTo: dolsAuthorisation.grantedTo, endedAt: dolsAuthorisation.endedAt })
    .from(dolsAuthorisation)
    .where(
      and(
        eq(dolsAuthorisation.personId, p.id),
        eq(dolsAuthorisation.outcome, "granted"),
        isNull(dolsAuthorisation.deletedAt),
      ),
    );
  const dolsInPlace = dols.some(
    (d) => d.endedAt === null && (d.grantedTo === null || d.grantedTo.getTime() > now.getTime()),
  );
  const capacityAndLegal: HospitalTransferInput["capacityAndLegal"] =
    assessmentRows.length > 0 || dolsInPlace
      ? {
          personId: assessmentRows[0]?.personId ?? p.id,
          asOf: assessmentRows.reduce<Date | null>(
            (latest, a) => (latest === null || a.assessedAt > latest ? a.assessedAt : latest),
            null,
          ),
          data: {
            summary:
              assessmentRows
                .map(
                  (a) =>
                    `${a.decision}: ${a.outcome === "lacks_capacity" ? "lacks capacity" : "has capacity"} (assessed ${ukDate(a.assessedAt)})`,
                )
                .join("; ") || "No capacity assessments recorded",
            dolsInPlace,
          },
        }
      : null;

  // Infection status from the pre-admission section, when it was completed.
  const infection = sections.infection_status;
  const infectionSource: HospitalTransferInput["infection"] =
    infection?.status === "complete" && infection.notes
      ? {
          personId: assessment?.personId ?? p.id,
          asOf: infection.completedAt ? new Date(infection.completedAt) : null,
          data: { summary: infection.notes },
        }
      : null;

  const contacts = await tx
    .select()
    .from(contact)
    .where(and(eq(contact.personId, p.id), isNull(contact.deletedAt)));

  const property = await tx
    .select()
    .from(propertyItem)
    .where(and(eq(propertyItem.personId, p.id), isNull(propertyItem.deletedAt)));

  return {
    personStatus: p.status as PersonStatus,
    identity: {
      personId: p.id,
      givenName: p.givenName,
      familyName: p.familyName,
      preferredName: p.preferredName,
      dateOfBirth: p.dateOfBirth,
      nhsNumber: p.nhsNumber,
      gpPracticeOdsCode: p.gpPracticeOdsCode,
    },
    generatedAt: now,
    generatedBy: request.generatedBy,
    photo,
    allergies: { personId: p.id, asOf: allergiesAsOf, data: allergyStatement },
    medicines,
    communication: {
      personId: p.id,
      asOf: p.communicationNeedsConfirmedAt,
      data: communication,
    },
    resuscitation: { personId: p.id, asOf: resuscitationAsOf, data: resuscitation },
    aboutMe: aboutMeRow
      ? {
          personId: aboutMeRow.personId,
          asOf: aboutMeRow.updatedAt,
          data: aboutMeRow.sections as AboutMeDocument,
        }
      : null,
    reasonForTransfer: request.reasonForTransfer,
    baseline: null,
    eatingAndDrinking,
    capacityAndLegal,
    contacts: contacts.map((c) => ({
      personId: c.personId,
      name: `${c.givenName} ${c.familyName}`,
      relationship: c.relationship,
      role: c.role,
      phone: c.phone,
    })),
    infection: infectionSource,
    property: property.map(
      (i): TransferPropertyItem => ({
        id: i.id,
        description: i.description,
        category: i.category,
        valuable: i.valuable,
        receivedOn: i.receivedOn,
        status: i.status as TransferPropertyItem["status"],
      }),
    ),
    sendItemIds: request.sendItemIds,
    homeContact: p.locationPhone ? { locationName: p.locationName, phone: p.locationPhone } : null,
  };
}

/**
 * Decides, once, whether a person's photo prints, for a photo uploaded before the decision was
 * stored at upload (`document.image_printable` empty). The row is read in one short transaction,
 * the file is read and checked with no transaction open, and the answer is stored in another, so
 * no image is ever decoded while a database connection is held (S2). Called before the transfer
 * pack routes open their own transaction.
 */
export async function decidePhotoPrintable(
  run: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>,
  storage: DocumentStoragePort,
  personId: string,
): Promise<void> {
  const pending = await run(async (tx) => {
    const [row] = await tx
      .select({
        id: document.id,
        storageKey: document.storageKey,
        contentType: document.contentType,
        status: document.status,
      })
      .from(person)
      .innerJoin(document, eq(document.id, person.photoDocumentId))
      .where(
        and(
          eq(person.id, personId),
          eq(document.personId, personId),
          isNull(document.imagePrintable),
          isNull(document.deletedAt),
        ),
      );
    return row && PRINTABLE_PHOTO_TYPES.includes(row.contentType) && row.status === "available"
      ? row
      : null;
  });
  if (!pending) return;
  const bytes = await storage.get(pending.storageKey).catch(() => null);
  const printable = bytes !== null && isPrintableImage({ bytes, contentType: pending.contentType });
  await run((tx) =>
    tx
      .update(document)
      .set({ imagePrintable: printable })
      .where(and(eq(document.id, pending.id), isNull(document.imagePrintable))),
  );
}
