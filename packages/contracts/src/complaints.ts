import { z } from "zod";
import { StaffName } from "./staff";

/**
 * Complaints and compliments (Phase 2 slice 18; safety.md Phase 2 rule 2; SAFE-011; Regulation 16).
 * The complainant's details are personal data kept on the record and returned only to holders of
 * safety.complaint.manage where it is; audit and events carry ids only.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();
const text = (max: number) => z.string().trim().min(1).max(max);

export const ComplaintState = z
  .enum([
    "received",
    "acknowledged",
    "investigating",
    "responded",
    "appealed",
    "appeal_responded",
    "closed",
  ])
  .meta({ id: "ComplaintState" });
export type ComplaintState = z.infer<typeof ComplaintState>;

export const ComplainantRelationship = z
  .enum([
    "person_using_service",
    "family_or_friend",
    "representative",
    "professional",
    "member_of_public",
    "other",
  ])
  .meta({ id: "ComplainantRelationship" });

export const ComplaintChannel = z
  .enum(["in_person", "phone", "email", "letter", "other"])
  .meta({ id: "ComplaintChannel" });

export const ComplaintOutcome = z
  .enum(["upheld", "partly_upheld", "not_upheld"])
  .meta({ id: "ComplaintOutcome" });

export const CreateComplaint = z
  .object({
    id: uuid.optional(),
    locationId: uuid,
    personId: uuid.optional(),
    complainantName: text(200),
    complainantRelationship: ComplainantRelationship,
    complainantContact: text(500).optional(),
    channel: ComplaintChannel,
    receivedAt: isoDateTime,
    /** When the complainant first knew of the matter (UK date). */
    knewOfMatterOn: isoDate,
    summary: z.string().trim().min(3).max(10_000),
  })
  .meta({ id: "CreateComplaint" });
export type CreateComplaint = z.infer<typeof CreateComplaint>;

export const ComplaintResponse = z
  .object({
    outcome: ComplaintOutcome,
    actionsTaken: z.string().trim().min(3).max(10_000),
    /** The response told the complainant how to go to the Ombudsman, and the time limit. */
    ombudsmanSignposted: z.boolean(),
    /** The kept copy of the response (document.id). */
    documentId: uuid,
  })
  .meta({ id: "ComplaintResponse" });
export type ComplaintResponse = z.infer<typeof ComplaintResponse>;

export const ComplaintStep = z
  .object({
    to: ComplaintState.exclude(["received"]),
    version: z.number().int().min(1),
    /** Closing needs one (withdrawn, or finished after a response). */
    reason: z.string().trim().min(3).max(1000).optional(),
    /** Responding, first or after an appeal. */
    response: ComplaintResponse.optional(),
    /** Recording an appeal. */
    appeal: z
      .object({ receivedAt: isoDateTime, reason: z.string().trim().min(3).max(10_000) })
      .optional(),
  })
  .meta({ id: "ComplaintStep" });
export type ComplaintStep = z.infer<typeof ComplaintStep>;

export const ComplaintPause = z
  .object({ from: isoDate, to: isoDate, reason: z.string().trim().min(3).max(500) })
  .meta({ id: "ComplaintPause" });

export const SetComplaintPauses = z
  .object({ pauses: z.array(ComplaintPause).max(50), version: z.number().int().min(1) })
  .meta({ id: "SetComplaintPauses" });
export type SetComplaintPauses = z.infer<typeof SetComplaintPauses>;

export const ComplaintItem = z
  .object({
    id: uuid,
    locationId: uuid,
    personId: uuid.nullable(),
    complainantName: z.string(),
    complainantRelationship: ComplainantRelationship,
    complainantContact: z.string().nullable(),
    channel: ComplaintChannel,
    receivedAt: isoDateTime,
    knewOfMatterOn: isoDate,
    summary: z.string(),
    state: ComplaintState,
    pauses: z.array(ComplaintPause),
    acknowledgedAt: isoDateTime.nullable(),
    response: ComplaintResponse.nullable(),
    respondedAt: isoDateTime.nullable(),
    appealReceivedAt: isoDateTime.nullable(),
    appealReason: z.string().nullable(),
    appealResponse: ComplaintResponse.nullable(),
    appealRespondedAt: isoDateTime.nullable(),
    closedReason: z.string().nullable(),
    closedAt: isoDateTime.nullable(),
    /** The tenant's targets in working days with the nation's bank holidays, pauses added. */
    clocks: z.object({
      acknowledgeBy: isoDate,
      respondBy: isoDate,
      pausedWorkingDays: z.number().int(),
      wording: z.string(),
    }),
    /** The Local Government and Social Care Ombudsman (England); null elsewhere for now. */
    ombudsman: z.object({ normallyBy: isoDate, wording: z.string() }).nullable(),
    recordedBy: StaffName.nullable(),
    version: z.number().int(),
  })
  .meta({ id: "ComplaintItem" });
export type ComplaintItem = z.infer<typeof ComplaintItem>;

export const ComplaintList = z
  .object({ items: z.array(ComplaintItem) })
  .meta({ id: "ComplaintList" });
export type ComplaintList = z.infer<typeof ComplaintList>;

export const CreateCompliment = z
  .object({
    id: uuid.optional(),
    locationId: uuid,
    personId: uuid.optional(),
    fromName: text(200),
    fromRelationship: ComplainantRelationship,
    receivedAt: isoDateTime,
    summary: z.string().trim().min(3).max(10_000),
    staffIds: z.array(uuid).max(50).default([]),
    evidenceStatementIds: z.array(text(100)).max(50).default([]),
    documentId: uuid.optional(),
  })
  .meta({ id: "CreateCompliment" });
export type CreateCompliment = z.infer<typeof CreateCompliment>;

export const TagCompliment = z
  .object({ evidenceStatementIds: z.array(text(100)).max(50), version: z.number().int().min(1) })
  .meta({ id: "TagCompliment" });
export type TagCompliment = z.infer<typeof TagCompliment>;

export const ComplimentItem = z
  .object({
    id: uuid,
    locationId: uuid,
    personId: uuid.nullable(),
    fromName: z.string(),
    fromRelationship: ComplainantRelationship,
    receivedAt: isoDateTime,
    summary: z.string(),
    staff: z.array(StaffName),
    evidenceStatementIds: z.array(z.string()),
    documentId: uuid.nullable(),
    recordedBy: StaffName.nullable(),
    version: z.number().int(),
  })
  .meta({ id: "ComplimentItem" });
export type ComplimentItem = z.infer<typeof ComplimentItem>;

export const ComplimentList = z
  .object({ items: z.array(ComplimentItem) })
  .meta({ id: "ComplimentList" });
export type ComplimentList = z.infer<typeof ComplimentList>;
