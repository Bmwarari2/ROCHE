import { z } from "zod";

/**
 * The organisation's escalation policy linked from validated-tool results (care.md section 5,
 * escalation policies; medical-device boundary section 5 rule 4; HZ-012, HZ-014; human action
 * H-73). Harbour shows the policy the organisation configured for the tool and band; it never
 * recommends a response of its own.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });

export const EscalationPolicyToolKey = z
  .enum(["news2", "must", "waterlow", "braden", "ng249_falls"])
  .meta({ id: "EscalationPolicyToolKey" });
export type EscalationPolicyToolKey = z.infer<typeof EscalationPolicyToolKey>;

/** A band code as stored with a result (news2: low, low_medium, medium, high; and so on). */
const band = z.string().regex(/^[a-z_]{2,40}$/);

/**
 * The policy a result links. `configured`: the organisation's own policy for the tool, for this
 * band or every band, at the result's location or across the organisation, named as the
 * organisation names it, with its reference and its document when uploaded. `not_configured`: the
 * organisation has linked no policy for this tool and band; say "No escalation policy is
 * configured for this result. Follow your organisation's procedures and tell the nurse in charge"
 * and never suggest a response.
 */
export const EscalationPolicyRef = z
  .discriminatedUnion("status", [
    z.object({
      status: z.literal("configured"),
      toolKey: EscalationPolicyToolKey,
      /** The result's band; null for a result with no band. */
      band: band.nullable(),
      linkId: uuid,
      title: z.string(),
      reference: z.string().nullable(),
      /** The policy document in the organisation's document store, when uploaded. */
      documentId: uuid.nullable(),
      /** Whether the link was for this band or for every band of the tool. */
      matchedOn: z.enum(["band", "tool"]),
      /** Whether the link was the location's own or the organisation's. */
      scope: z.enum(["location", "organisation"]),
    }),
    z.object({
      status: z.literal("not_configured"),
      toolKey: EscalationPolicyToolKey,
      band: band.nullable(),
    }),
  ])
  .meta({
    id: "EscalationPolicyRef",
    description:
      "The organisation's own escalation policy for a validated tool's result, or that none is configured; never a Harbour recommendation",
  });
export type EscalationPolicyRef = z.infer<typeof EscalationPolicyRef>;

const title = z.string().trim().min(3).max(200);
const reference = z.string().trim().max(100);

export const EscalationPolicyLinkItem = z
  .object({
    id: uuid,
    toolKey: EscalationPolicyToolKey,
    /** One band of the tool, or null for every band. */
    band: band.nullable(),
    /** One location, or null for the whole organisation. */
    locationId: uuid.nullable(),
    title: z.string(),
    reference: z.string().nullable(),
    documentId: uuid.nullable(),
    updatedAt: isoDateTime,
    version: z.number().int(),
  })
  .meta({ id: "EscalationPolicyLinkItem" });
export type EscalationPolicyLinkItem = z.infer<typeof EscalationPolicyLinkItem>;

export const EscalationPolicyLinkList = z
  .object({
    items: z.array(EscalationPolicyLinkItem),
    /** The bands each tool's results carry, which a link may name (none for the falls pathway). */
    bands: z.record(z.string(), z.array(z.string())),
  })
  .meta({ id: "EscalationPolicyLinkList" });
export type EscalationPolicyLinkList = z.infer<typeof EscalationPolicyLinkList>;

export const CreateEscalationPolicyLink = z
  .object({
    /** A client UUIDv7, so a save tried again records the link once (HZ-029). */
    id: uuid.optional(),
    toolKey: EscalationPolicyToolKey,
    band: band.nullable().default(null),
    locationId: uuid.nullable().default(null),
    title,
    reference: reference.nullable().optional(),
    documentId: uuid.nullable().optional(),
  })
  .meta({
    id: "CreateEscalationPolicyLink",
    description:
      "Links the organisation's escalation policy to a validated tool, for one band or every band, for one location or the whole organisation",
  });
export type CreateEscalationPolicyLink = z.infer<typeof CreateEscalationPolicyLink>;

export const UpdateEscalationPolicyLink = z
  .object({
    title,
    reference: reference.nullable().optional(),
    documentId: uuid.nullable().optional(),
    /** The version read. */
    version: z.number().int().min(1),
  })
  .meta({ id: "UpdateEscalationPolicyLink" });
export type UpdateEscalationPolicyLink = z.infer<typeof UpdateEscalationPolicyLink>;

export const RemoveEscalationPolicyLink = z
  .object({ version: z.number().int().min(1) })
  .meta({ id: "RemoveEscalationPolicyLink" });
export type RemoveEscalationPolicyLink = z.infer<typeof RemoveEscalationPolicyLink>;
