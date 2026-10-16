import { z } from "zod";

/**
 * The sub-processors an organisation's configuration uses, and Thapsus's notices of new or
 * replacement ones (UK GDPR Art 28; DPA clause 6; platform-completions.md rules 23 to 25). The
 * named data protection lead acknowledges each, or objects to a notice within its window.
 */

const isoDateTime = z.iso.datetime({ offset: true });

export const SubProcessorObjection = z
  .object({
    at: isoDateTime,
    grounds: z.string(),
    resolvedAt: isoDateTime.nullable(),
    resolution: z.enum(["objection_withdrawn", "not_used_for_tenant", "services_ended"]).nullable(),
  })
  .meta({ id: "SubProcessorObjection" });

export const SubProcessorOverview = z
  .object({
    /** The organisation's notice and objection period, in days (its DPA; rate table). */
    noticeDays: z.number().int().min(0),
    /** Whether the viewer may answer: the named lead holding platform.dpia.sign. */
    mayRespond: z.boolean(),
    inUse: z.array(
      z.object({
        key: z.string(),
        name: z.string(),
        service: z.string(),
        purpose: z.string(),
        location: z.string(),
        outsideUk: z.boolean(),
        acknowledgedAt: isoDateTime.nullable(),
        /** When its entry last changed by notice, if ever. */
        changedAt: isoDateTime.nullable(),
        acknowledged: z.boolean(),
      }),
    ),
    notices: z.array(
      z.object({
        id: z.uuid(),
        subProcessorKey: z.string(),
        kind: z.enum(["new", "replacement"]),
        announcedAt: isoDateTime,
        effectiveFrom: isoDateTime,
        windowEndsAt: isoDateTime,
        state: z.enum([
          "not_applicable",
          "awaiting_response",
          "acknowledged",
          "objected",
          "objection_resolved",
          "deemed_accepted",
        ]),
        acknowledgedAt: isoDateTime.nullable(),
        objection: SubProcessorObjection.nullable(),
      }),
    ),
  })
  .meta({ id: "SubProcessorOverview" });
export type SubProcessorOverview = z.infer<typeof SubProcessorOverview>;

export const AcknowledgeSubProcessor = z
  .object({
    /** The notice acknowledged; omitted to acknowledge the register entry at onboarding. */
    noticeId: z.uuid().optional(),
  })
  .meta({ id: "AcknowledgeSubProcessor" });

export const ObjectToNotice = z
  .object({
    /** The data protection grounds (20 characters or more). */
    grounds: z.string().trim().max(4000),
  })
  .meta({ id: "ObjectToNotice" });

export const SubProcessorResponseRecorded = z
  .object({ id: z.uuid(), respondedAt: isoDateTime })
  .meta({ id: "SubProcessorResponseRecorded" });
