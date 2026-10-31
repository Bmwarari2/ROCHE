import { z } from "zod";

/**
 * Letter and email templates (comms.md rules 18 to 23; COMMS-007; ADR-0051; hazard HZ-051).
 * Templates hold no personal data: merge fields are `{{field.name}}` from the catalogue only.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });
const version = z.number().int().min(1);

export const TemplateKind = z
  .enum(["admission", "fee_review", "incident_follow_up", "duty_of_candour", "general"])
  .meta({ id: "TemplateKind" });
export const TemplateChannel = z.enum(["letter", "email"]).meta({ id: "TemplateChannel" });

export const MergeFieldItem = z
  .object({
    key: z.string(),
    label: z.string(),
    type: z.enum(["text", "date", "datetime", "money", "number"]),
    dataClass: z.enum(["none", "personal", "special_category"]),
    personBound: z.boolean(),
    multiLine: z.boolean(),
    notInEmail: z.boolean(),
  })
  .meta({ id: "MergeFieldItem" });
export const MergeFieldList = z
  .object({ items: z.array(MergeFieldItem) })
  .meta({ id: "MergeFieldList" });

const templateText = {
  name: z.string().trim().min(1).max(200),
  /** Email only; null for a letter. */
  subject: z.string().max(80).nullable(),
  body: z.string().min(1).max(20_000),
};

export const CreateLetterTemplate = z
  .object({ kind: TemplateKind, channel: TemplateChannel, ...templateText })
  .meta({ id: "CreateLetterTemplate" });

export const EditTemplateVersion = z
  .object({ ...templateText, version })
  .meta({ id: "EditTemplateVersion" });

export const ApproveTemplateVersion = z.object({ version }).meta({ id: "ApproveTemplateVersion" });

export const EndTemplateVersion = z
  .object({ reason: z.string().trim().min(1).max(500), version })
  .meta({ id: "EndTemplateVersion" });

export const TemplateIssue = z
  .object({ problem: z.string(), field: z.string().nullable(), message: z.string() })
  .meta({ id: "TemplateIssue" });

export const LetterTemplateVersionItem = z
  .object({
    id: uuid,
    templateId: uuid,
    versionNumber: z.number().int(),
    state: z.enum(["draft", "approved", "superseded", "retired", "discarded"]),
    name: z.string(),
    subject: z.string().nullable(),
    body: z.string(),
    authorId: uuid,
    contributorIds: z.array(uuid),
    approvedBy: uuid.nullable(),
    approvedAt: isoDateTime.nullable(),
    retiredAt: isoDateTime.nullable(),
    retirementReason: z.string().nullable(),
    discardReason: z.string().nullable(),
    /** What stops approval, in words (`checkTemplateDefinition`); empty when none. */
    issues: z.array(TemplateIssue),
    /** Fields used that hold personal or special category data. */
    personalDataFields: z.array(z.string()),
    /** Plain-English suggestions; nothing is blocked (rule 26). */
    styleWarnings: z.array(z.string()),
    version: z.number().int(),
  })
  .meta({ id: "LetterTemplateVersionItem" });

export const LetterTemplateItem = z
  .object({
    id: uuid,
    kind: TemplateKind,
    channel: TemplateChannel,
    currentVersionId: uuid.nullable(),
    /** The version in use, then the open draft, if any. */
    current: LetterTemplateVersionItem.nullable(),
    draft: LetterTemplateVersionItem.nullable(),
    version: z.number().int(),
  })
  .meta({ id: "LetterTemplateItem" });

export const LetterTemplateList = z
  .object({ items: z.array(LetterTemplateItem) })
  .meta({ id: "LetterTemplateList" });

export const LetterTemplateVersionList = z
  .object({ items: z.array(LetterTemplateVersionItem) })
  .meta({ id: "LetterTemplateVersionList" });

// ------------------------------------------------------------------------------------------------
// Letters (rules 24 and 25)
// ------------------------------------------------------------------------------------------------

export const LetterRecipient = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("person") }),
    z.object({ kind: z.literal("contact"), contactId: uuid }),
  ])
  .meta({ id: "LetterRecipient" });

export const LetterRequest = z
  .object({
    templateId: uuid,
    recipient: LetterRecipient,
    /** An incident follow-up letter's incident (needs safety.incident.manage). */
    incidentId: uuid.optional(),
    /**
     * Values the sender types: admission and fee fields only; money in whole pence, dates
     * yyyy-mm-dd. Every other field comes from the record.
     */
    values: z
      .record(z.string().max(64), z.union([z.string().max(2000), z.number()]))
      .refine((v) => Object.keys(v).length <= 10, "At most 10 values")
      .optional(),
  })
  .meta({ id: "LetterRequest" });

export const SendLetter = LetterRequest.extend({
  /** The sender has seen the preview: the person, the recipient and the personal details. */
  confirmed: z.literal(true),
  /** From the preview: the send is refused (409) if the letter would differ in any way. */
  templateVersionId: uuid,
  textHash: z.string().regex(/^[0-9a-f]{64}$/),
}).meta({ id: "SendLetter" });

export const LetterPreview = z
  .object({
    /** Repeat both when sending: they pin the letter to exactly what was checked. */
    templateVersionId: uuid,
    textHash: z.string(),
    /** Who the letter is about, for the check before sending (rule 25, HZ-001). */
    person: z.object({
      id: uuid,
      fullName: z.string(),
      preferredName: z.string().nullable(),
      roomLabel: z.string().nullable(),
      photoUrl: z.string().nullable(),
      /** An invented sample person (HZ-072): the check before sending says so. */
      sample: z.boolean(),
    }),
    channel: TemplateChannel,
    subject: z.string().nullable(),
    text: z.string(),
    recipientName: z.string(),
    personalDataFields: z.array(z.string()),
    containsSpecialCategory: z.boolean(),
  })
  .meta({ id: "LetterPreview" });

export const LetterItem = z
  .object({
    id: uuid,
    templateVersionId: uuid,
    channel: TemplateChannel,
    recipientKind: z.enum(["person", "contact"]),
    contactId: uuid.nullable(),
    personalFields: z.array(z.string()),
    specialCategory: z.boolean(),
    incidentId: uuid.nullable(),
    documentId: uuid.nullable(),
    sentBy: uuid,
    sentAt: isoDateTime,
  })
  .meta({ id: "LetterItem" });

export const LetterList = z.object({ items: z.array(LetterItem) }).meta({ id: "LetterList" });

export type LetterTemplateItem = z.infer<typeof LetterTemplateItem>;
export type LetterTemplateVersionItem = z.infer<typeof LetterTemplateVersionItem>;
export type LetterPreview = z.infer<typeof LetterPreview>;
export type LetterItem = z.infer<typeof LetterItem>;
