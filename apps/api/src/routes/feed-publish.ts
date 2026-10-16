import { PublishedFeedItem, PublishFeedItem } from "@harbour/contracts";
import {
  activityRecord,
  careNote,
  document,
  feedItem,
  type Transaction,
  withRequestContext,
} from "@harbour/db";
import {
  type ActivityAttendance,
  type ActivityEngagement,
  composeFeedItem,
  type FeedItemKind,
  type FeedSource,
  type PersonStatus,
} from "@harbour/domain";
import { createRoute, type z } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import { AuditedRefusal, withAuditedRefusal } from "../http/audit";
import { requirePermission, usablePermissions, withTenant } from "../http/context";
import { type HttpProblem, problems } from "../http/problem";
import { publish } from "../outbox";
import { composeFacts } from "../services/feed-publish";
import { loadPerson } from "../services/people";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { audit, dbCode, PersonParam } from "./people-shared";

/**
 * Publishing family updates from records (comms.md rules 6 to 12 and section 5; COMMS-001,
 * part 1b; HZ-022, HZ-060, HZ-061). A holder of `comms.feed.publish` where the person lives turns
 * one record into one update: a note they mark as shareable by writing words for the family (the
 * note itself never passes through), an activity in approved phrasing, or a photo they chose, which
 * needs the person's consent to photos (master prompt 5.1: consent covers this optional processing
 * only). `composeFeedItem` refuses other people's names, contact details, clinical words, closed
 * records and the publishing holds; event and wellbeing words need a confirmation with a reason.
 * Publishing decides nothing about who sees it: the sharing decisions do, in the database
 * (`app.family_can_see`) and in `buildFamilyFeed`. The update's id comes from the form, so a retry
 * returns the update already published.
 */

type ItemRow = typeof feedItem.$inferSelect;

const itemOut = (row: ItemRow) => ({
  id: row.id,
  personId: row.personId,
  kind: row.kind as FeedItemKind,
  section: row.section,
  carePlanDomain: row.carePlanDomain,
  occurredAt: row.occurredAt.toISOString(),
  composedAt: row.composedAt.toISOString(),
  text: row.text,
  composedBy: row.composedBy,
  withdrawn: null,
});

type SourceRead =
  | { readonly ok: true; readonly source: FeedSource }
  | {
      readonly ok: false;
      readonly reason: "source_not_found" | "source_corrected" | "photo_not_for_feed";
    };

const SOURCE_REFUSALS = {
  source_corrected:
    "This record has been corrected. Publish from the corrected record, if it is still right to share.",
  photo_not_for_feed:
    "Only a photo added for the family feed can be published. Identification photos, wound photos, care attachments and other documents never go to the family.",
} as const;

/** The id of the record a request names. */
const sourceIdOf = (body: z.infer<typeof PublishFeedItem>) =>
  body.source.kind === "shared_note"
    ? body.source.noteId
    : body.source.kind === "activity"
      ? body.source.activityId
      : body.source.documentId;

/**
 * The record the update is made from, as the compose rule reads it: one of this person's own,
 * not since corrected (a correction is a new row that supersedes it), and for a photo only one in
 * the `feed_photo` category (HZ-022, HZ-060).
 */
async function sourceOf(
  tx: Transaction,
  personId: string,
  body: z.infer<typeof PublishFeedItem>,
  by: string,
  now: Date,
): Promise<SourceRead> {
  const source = body.source;
  const missing = { ok: false, reason: "source_not_found" } as const;
  const corrected = { ok: false, reason: "source_corrected" } as const;
  if (source.kind === "shared_note") {
    const [note] = await tx
      .select({ id: careNote.id, occurredAt: careNote.occurredAt })
      .from(careNote)
      .where(and(eq(careNote.id, source.noteId), eq(careNote.personId, personId)));
    if (!note) return missing;
    const [later] = await tx
      .select({ id: careNote.id })
      .from(careNote)
      .where(eq(careNote.supersedesId, note.id))
      .limit(1);
    if (later) return corrected;
    // Publishing with words for the family is the marking (rule 8): by this member of staff, now.
    return {
      ok: true,
      source: {
        kind: "shared_note",
        id: note.id,
        personId,
        occurredAt: note.occurredAt,
        text: source.text,
        markedShareableBy: by,
        markedShareableAt: now,
      },
    };
  }
  if (source.kind === "activity") {
    const [row] = await tx
      .select()
      .from(activityRecord)
      .where(and(eq(activityRecord.id, source.activityId), eq(activityRecord.personId, personId)));
    if (!row) return missing;
    const [later] = await tx
      .select({ id: activityRecord.id })
      .from(activityRecord)
      .where(eq(activityRecord.supersedesId, row.id))
      .limit(1);
    if (later) return corrected;
    return {
      ok: true,
      source: {
        kind: "activity",
        id: row.id,
        personId,
        occurredAt: row.occurredAt,
        activityName: row.activity,
        attendance: row.attendance as ActivityAttendance,
        engagement: (row.engagement ?? null) as ActivityEngagement | null,
      },
    };
  }
  const [photo] = await tx
    .select({
      id: document.id,
      createdAt: document.createdAt,
      type: document.contentType,
      category: document.category,
    })
    .from(document)
    .where(
      and(
        eq(document.id, source.documentId),
        eq(document.personId, personId),
        eq(document.status, "available"),
        isNull(document.deletedAt),
      ),
    );
  if (!photo) return missing;
  if (photo.category !== "feed_photo" || !photo.type.startsWith("image/")) {
    return { ok: false, reason: "photo_not_for_feed" };
  }
  return {
    ok: true,
    source: {
      kind: "photo",
      id: photo.id,
      personId,
      // No time taken is recorded: the update is dated when the photo was added ("A new photo").
      occurredAt: photo.createdAt,
      documentId: photo.id,
      caption: source.caption,
      // The publisher's check that only this person can be recognised; `composed_by` records who.
      otherPeopleIdentifiable: !source.onlyThisPerson,
      markedForFeedBy: by,
    },
  };
}

export const feedPublishRouter = createRouter().openapi(
  createRoute({
    method: "post",
    path: "/v1/people/{id}/feed",
    tags: ["comms"],
    summary: "Publish a family update from a note, an activity or a photo (HZ-022, HZ-061)",
    description:
      "comms.feed.publish where the person lives. composeFeedItem: approved phrasing or the words written for the family, never the note itself; other people's names, contact details and clinical words refused; nothing while the person is in hospital, an incident waits for the next of kin or a candour step is open; event and wellbeing words only with confirmationReason; a photo only with the person's consent to photos and nobody else recognisable. Who sees it is decided by the sharing decisions. The id is the client's: a retry with the same id and source returns the update (200). Refusals are audited with problem codes only.",
    security,
    request: {
      params: PersonParam,
      body: { content: { "application/json": { schema: PublishFeedItem } } },
    },
    responses: {
      200: jsonBody(PublishedFeedItem, "Already published"),
      201: jsonBody(PublishedFeedItem, "Published"),
      ...errorResponses,
      ...notFoundResponse,
      ...conflictResponse,
    },
  }),
  async (c) => {
    const access = await requirePermission(c, "comms.feed.publish");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const now = new Date();
    const refuse = (problem: HttpProblem, reason: string) =>
      new AuditedRefusal(problem, {
        action: "comms.feed.publish_refused",
        outcome: "denied",
        resourceType: "person",
        resourceId: id,
        reason,
      });
    const out = await withAuditedRefusal(c, access, () =>
      withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id);
        // A retry of an update already published returns it, whatever has changed since.
        const [existing] = await tx.select().from(feedItem).where(eq(feedItem.id, body.id));
        if (existing) {
          // The same id for another person or another record is a different update: refused.
          if (existing.personId !== id || existing.sourceId !== sourceIdOf(body)) {
            throw problems.conflict();
          }
          return { status: 200 as const, item: itemOut(existing), lint: [] as string[] };
        }
        const read = await sourceOf(tx, id, body, access.tenantUserId, now);
        if (!read.ok) {
          throw refuse(
            read.reason === "source_not_found"
              ? problems.notFound()
              : problems.invalid(SOURCE_REFUSALS[read.reason]),
            read.reason,
          );
        }
        const source = read.source;
        const facts = await withRequestContext(
          c.get("services").db,
          { tenantId: access.tenantId, userId: null, scope: "tenant", locationIds: [] },
          (system) => composeFacts(system, { id, locationId: p.locationId }, now),
        );
        const result = composeFeedItem(source, {
          person: {
            id,
            status: p.status as PersonStatus,
            name: p.preferredName ?? p.givenName,
            givenName: p.givenName,
            familyName: p.familyName,
            preferredName: p.preferredName,
          },
          otherResidents: facts.otherResidents,
          staff: facts.staff,
          // The tenant setting for staff names is not built yet: first names only (H-107).
          staffNames: "first_name_only",
          photoBasis: facts.photoBasis,
          openIncidents: facts.openIncidents,
          candourStates: facts.candourStates,
          confirmation: body.confirmationReason
            ? {
                by: access.tenantUserId,
                permissions: usablePermissions(access),
                reason: body.confirmationReason,
              }
            : null,
          now,
        });
        if (!result.ok) {
          throw refuse(
            problems.invalid(result.problems.map((pr) => pr.message).join(" ")),
            result.problems.map((pr) => pr.problem).join(","),
          );
        }
        const composed = result.item;
        const [row] = await tx
          .insert(feedItem)
          .values({
            id: body.id,
            personId: id,
            kind: composed.kind,
            section: composed.section,
            carePlanDomain: composed.carePlanDomain,
            sourceKind: composed.sourceKind,
            sourceId: composed.sourceId,
            occurredAt: composed.occurredAt,
            text: composed.text,
            photoDocumentId: composed.photoDocumentId,
            phraseKey: composed.phraseKey,
            composedBy: access.tenantUserId,
            confirmedBy: composed.confirmation?.by ?? null,
            confirmationReason: composed.confirmation?.reason ?? null,
            otherPeopleIdentifiable: composed.kind === "photo" ? false : null,
          })
          .returning()
          .catch((error: unknown) => {
            if (dbCode(error) === "23505") throw problems.conflict();
            throw error;
          });
        if (!row) throw problems.conflict();
        // Ids and codes only: never the words, the caption or the confirmation reason.
        await audit(c, tx, access, {
          action: "comms.feed.item_published",
          resourceType: "feed_item",
          resourceId: row.id,
          scope: {
            personId: id,
            kind: row.kind,
            sourceKind: row.sourceKind,
            sourceId: row.sourceId,
            confirmed: row.confirmedBy !== null,
          },
        });
        await publish(tx, {
          context: "comms",
          aggregateType: "feed_item",
          aggregateId: row.id,
          type: "comms.feed.item_published",
          payload: { personId: id, feedItemId: row.id, section: row.section },
        });
        return {
          status: 201 as const,
          item: itemOut(row),
          lint: result.lint.map((finding) => finding.message),
        };
      }),
    );
    return c.json({ item: out.item, lint: out.lint }, out.status);
  },
);
