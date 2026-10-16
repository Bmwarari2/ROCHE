import { z } from "zod";

/**
 * The family feed (comms.md rules 1 to 12 and section 5; COMMS-001; ADR-0061; hazard HZ-022).
 * Family members see only what a sharing decision opens; staff link portal accounts to contacts
 * and take updates down. No ids of decisions reach the family.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });

export const FeedItemKind = z
  .enum([
    "activity",
    "visit",
    "appointment",
    "shared_note",
    "photo",
    "care_plan_update",
    "finance_statement",
  ])
  .meta({ id: "FeedItemKind" });

export const FamilyFeedEntry = z
  .object({
    itemId: uuid,
    kind: FeedItemKind,
    /** `withdrawn_notice`: only that an update this viewer saw was taken down. */
    display: z.enum(["item", "withdrawn_notice"]),
    text: z.string(),
    /** "11/10/2026 14:00", UK time: when it happened. */
    happened: z.string(),
    /** When it was written, only when that was on a later day. */
    addedLater: z.string().nullable(),
    corrects: uuid.nullable(),
  })
  .meta({ id: "FamilyFeedEntry" });

export const FamilyFeed = z
  .object({
    personId: uuid,
    contactId: uuid,
    /** The same words whether the feed is open or closed, so it never says why it is closed. */
    statement: z.string(),
    lastUpdateAt: isoDateTime.nullable(),
    entries: z.array(FamilyFeedEntry),
  })
  .meta({ id: "FamilyFeed" });

export const FamilyFeedList = z
  .object({ items: z.array(FamilyFeed) })
  .meta({ id: "FamilyFeedList" });

export const FeedWithdrawalReason = z
  .enum(["source_corrected", "published_in_error", "person_asked", "photo_consent_withdrawn"])
  .meta({ id: "FeedWithdrawalReason" });

export const StaffFeedItem = z
  .object({
    id: uuid,
    personId: uuid,
    kind: FeedItemKind,
    section: z.string(),
    carePlanDomain: z.string().nullable(),
    occurredAt: isoDateTime,
    composedAt: isoDateTime,
    text: z.string(),
    composedBy: uuid,
    withdrawn: z.object({ reason: FeedWithdrawalReason, by: uuid, at: isoDateTime }).nullable(),
  })
  .meta({ id: "StaffFeedItem" });

export const StaffFeedItemList = z
  .object({ items: z.array(StaffFeedItem) })
  .meta({ id: "StaffFeedItemList" });

export const WithdrawFeedItem = z
  .object({ reason: FeedWithdrawalReason })
  .meta({ id: "WithdrawFeedItem" });

export const FamilyPortalLink = z
  .object({
    id: uuid,
    personId: uuid,
    contactId: uuid,
    tenantUserId: uuid,
    revokedAt: isoDateTime.nullable(),
    version: z.number().int(),
  })
  .meta({ id: "FamilyPortalLink" });

export const FamilyPortalLinkList = z
  .object({ items: z.array(FamilyPortalLink) })
  .meta({ id: "FamilyPortalLinkList" });

export const CreateFamilyPortalLink = z
  .object({ tenantUserId: uuid, contactId: uuid })
  .meta({ id: "CreateFamilyPortalLink" });

export const RevokeFamilyPortalLink = z
  .object({ reason: z.string().trim().min(1).max(500), version: z.number().int().min(1) })
  .meta({ id: "RevokeFamilyPortalLink" });

export type FamilyFeedList = z.infer<typeof FamilyFeedList>;
export type StaffFeedItem = z.infer<typeof StaffFeedItem>;
