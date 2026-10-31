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

/**
 * Publish one update from one record (comms.md rules 7 to 12). `id` is the update's own UUIDv7,
 * made by the form and sent with every attempt, so a retry never publishes twice.
 */
export const PublishFeedItem = z
  .object({
    id: uuid,
    source: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("shared_note"),
        noteId: uuid,
        /** The words written for the family; the note itself never passes through (rule 8). */
        text: z.string().trim().min(1).max(1000),
      }),
      z.object({ kind: z.literal("activity"), activityId: uuid }),
      z.object({
        kind: z.literal("photo"),
        documentId: uuid,
        caption: z.string().trim().max(1000).nullable(),
        /** The publisher checked that nobody else can be recognised in it (rule 6). */
        onlyThisPerson: z.boolean(),
      }),
    ]),
    /** For staff words that announce an event or claim how the person is (rule 12). */
    confirmationReason: z.string().trim().min(1).max(500).optional(),
  })
  .meta({ id: "PublishFeedItem" });

export const PublishedFeedItem = z
  .object({
    item: StaffFeedItem,
    /** Plain-English suggestions on the words (reading age); nothing is blocked (rule 11). */
    lint: z.array(z.string()),
  })
  .meta({ id: "PublishedFeedItem" });

/** What publishing would make, or each problem with its code (nothing is stored). */
export const FeedPreview = z
  .object({
    ok: z.boolean(),
    kind: FeedItemKind.nullable(),
    /** The words the family would see. */
    text: z.string().nullable(),
    problems: z.array(z.object({ problem: z.string(), message: z.string() })),
    lint: z.array(z.string()),
  })
  .meta({ id: "FeedPreview" });

export type FeedPreview = z.infer<typeof FeedPreview>;
export type FamilyFeedList = z.infer<typeof FamilyFeedList>;
export type StaffFeedItem = z.infer<typeof StaffFeedItem>;
