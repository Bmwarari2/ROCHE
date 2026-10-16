import {
  CreateFamilyPortalLink,
  FamilyFeedList,
  FamilyPortalLink,
  FamilyPortalLinkList,
  RevokeFamilyPortalLink,
  StaffFeedItemList,
  WithdrawFeedItem,
} from "@harbour/contracts";
import {
  contact,
  familyPortalUser,
  feedItem,
  feedItemWithdrawal,
  feedView,
  person,
  type Transaction,
  tenantUser,
  withRequestContext,
} from "@harbour/db";
import {
  buildFamilyFeed,
  checkFeedWithdrawal,
  FEED_ITEM_SECTIONS,
  FEED_NOT_FULL_RECORD_STATEMENT,
  type FeedItem,
  type FeedItemKind,
  type FeedWithdrawalReason,
  type PersonStatus,
  rolePermissionMix,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { AuditedRefusal, withAuditedRefusal } from "../http/audit";
import { type AppEnv, requireAnyPermission, requirePermission, withTenant } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { publish } from "../outbox";
import { accessRowsOf } from "../services/access-rows";
import { photoBasisOf } from "../services/feed-publish";
import { loadPerson, requireVersion, requireWrite } from "../services/people";
import { decisionsWithLinks, sharingContext } from "../services/sharing";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { audit, dbCode, invalidOnForeignKey, PersonParam } from "./people-shared";

/**
 * The family feed, part 1 (comms.md rules 1 to 4 and section 5; COMMS-001; ADR-0061; HZ-022).
 * A family member reads the updates a sharing decision opens, in a portal session: the database
 * shows them only what `app.family_can_see` allows (migration 0061), and `buildFamilyFeed` applies
 * the same rule again with the photo basis. Staff link a portal account to the contact the
 * sharing decisions name (the decisions themselves are the people-sharing routes), list a
 * person's updates and take one down. Publishing updates from source records is part 1b.
 */

type ItemRow = typeof feedItem.$inferSelect;
type WithdrawalRow = typeof feedItemWithdrawal.$inferSelect;
type LinkRow = typeof familyPortalUser.$inferSelect;

const asFeedItem = (row: ItemRow, withdrawal: WithdrawalRow | undefined): FeedItem => ({
  id: row.id,
  personId: row.personId,
  kind: row.kind as FeedItemKind,
  carePlanDomain: row.carePlanDomain,
  occurredAt: row.occurredAt,
  composedAt: row.composedAt,
  text: row.text,
  photoDocumentId: row.photoDocumentId,
  supersedesItemId: row.supersedesItemId,
  withdrawnAt: withdrawal?.withdrawnAt ?? null,
  withdrawnReason: (withdrawal?.reason ?? null) as FeedWithdrawalReason | null,
});

const linkOut = (row: LinkRow) => ({
  id: row.id,
  personId: row.personId,
  contactId: row.contactId,
  tenantUserId: row.tenantUserId,
  revokedAt: row.revokedAt?.toISOString() ?? null,
  version: row.version,
});

/**
 * What the sharing rules need about each linked person: the status, every decision with its
 * suspension periods, and the capacity finding now. A family session cannot read these (no person
 * scope, ADR-0061), so they are read in the system's view; they decide what is shown and are never
 * returned. The person ids come only from the caller's own `family_portal_user` links, read in the
 * family session, never from the request: the system's view is never pointed at a person the
 * caller chose (a test sends another person's id and finds nothing of them).
 */
async function viewerContexts(c: Context<AppEnv>, personIds: readonly string[], now: Date) {
  const { tenantId } = c.get("access");
  return withRequestContext(
    c.get("services").db,
    { tenantId, userId: null, scope: "tenant", locationIds: [] },
    async (tx) => {
      const out = new Map<string, Awaited<ReturnType<typeof viewerContextOf>>>();
      for (const id of personIds) out.set(id, await viewerContextOf(tx, id, now));
      return out;
    },
  );
}

async function viewerContextOf(tx: Transaction, personId: string, now: Date) {
  const [row] = await tx
    .select({ status: person.status })
    .from(person)
    .where(and(eq(person.id, personId), isNull(person.deletedAt)));
  const context = await sharingContext(tx, personId, now);
  return {
    status: (row?.status ?? "archived") as PersonStatus,
    capacityNow: context.capacityNow,
    decisions: await decisionsWithLinks(tx, personId, context),
    // Photos are shown only while the person's consent to them holds (rule 6).
    photoBasis: await photoBasisOf(tx, personId, now),
  };
}

/**
 * Binding a portal account to a person rests on more than a member of staff's choice: the
 * account's verified email must be the contact's own email, or the link is refused and the refusal
 * audited (ids only). An invitation the contact accepts replaces this later (STATUS).
 */
async function requireAccountIsContact(
  c: Context<AppEnv>,
  tx: Transaction,
  personId: string,
  body: { readonly tenantUserId: string; readonly contactId: string },
) {
  const [member] = await tx
    .select({ authUserId: tenantUser.authUserId })
    .from(tenantUser)
    .where(eq(tenantUser.id, body.tenantUserId));
  const [holder] = await tx
    .select({ email: contact.email })
    .from(contact)
    .where(
      and(
        eq(contact.id, body.contactId),
        eq(contact.personId, personId),
        isNull(contact.deletedAt),
      ),
    );
  const account = member?.authUserId
    ? (
        await c
          .get("services")
          .authPool.query<{ email: string; email_verified: boolean }>(
            'SELECT email, email_verified FROM auth."user" WHERE id = $1',
            [member.authUserId],
          )
      ).rows[0]
    : undefined;
  const same = (a: string | null | undefined, b: string | null | undefined) =>
    !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
  if (!account?.email_verified || !same(account.email, holder?.email)) {
    throw new AuditedRefusal(
      new HttpProblem(
        422,
        "account_not_contact",
        "This account's confirmed email is not the contact's email. Check the contact's details, or ask the family member to sign up with that email.",
      ),
      {
        action: "comms.portal_link.create",
        outcome: "denied",
        resourceType: "person",
        resourceId: personId,
        reason: "account_not_contact",
        scope: { contactId: body.contactId, tenantUserId: body.tenantUserId },
      },
    );
  }
}

const FEED_PERMISSIONS = ["comms.feed.publish", "comms.feed.withdraw"] as const;
const LinkParams = PersonParam.extend({ linkId: z.uuid() });

export const familyFeedRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/family/feed",
      tags: ["comms"],
      summary: "The family member's feed for each person they are linked to (HZ-022)",
      description:
        "A portal session only. Closed by default: an update shows only under a sharing decision for the caller's contact that covers its section and was in force and not suspended when it happened and now. Every entry shown writes a feed_view; not cached.",
      security,
      responses: { 200: jsonBody(FamilyFeedList, "Feeds"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, "comms.feed.read");
      if (access.effective.session !== "portal") throw problems.forbidden();
      const now = new Date();
      const read = await withTenant(c, async (tx) => {
        const links = await tx
          .select()
          .from(familyPortalUser)
          .where(
            and(
              eq(familyPortalUser.tenantUserId, access.tenantUserId),
              isNull(familyPortalUser.revokedAt),
              isNull(familyPortalUser.deletedAt),
            ),
          );
        const people = [...new Set(links.map((l) => l.personId))];
        if (people.length === 0) return { links, items: [], withdrawals: [], seen: [] };
        const items = await tx.select().from(feedItem).where(inArray(feedItem.personId, people));
        const withdrawals = await tx
          .select()
          .from(feedItemWithdrawal)
          .where(inArray(feedItemWithdrawal.personId, people));
        const seen = await tx
          .select({ itemId: feedView.feedItemId })
          .from(feedView)
          .where(eq(feedView.viewedBy, access.tenantUserId));
        return { links, items, withdrawals, seen };
      });
      const contexts = await viewerContexts(
        c,
        [...new Set(read.links.map((l) => l.personId))],
        now,
      );
      const withdrawn = new Map(read.withdrawals.map((w) => [w.feedItemId, w]));
      // A feed closed by the person's status (discharge, death, archive) reads exactly like one
      // with no decision: no paused statement and nothing else that says why, so the portal never
      // tells a family about a death or a discharge before the home does (comms.md rule 3, H-110).
      const seen = new Set(read.seen.map((s) => s.itemId));
      const feeds = read.links.map((link) => {
        const viewer = contexts.get(link.personId);
        const feed = buildFamilyFeed(
          read.items
            .filter((i) => i.personId === link.personId)
            .map((i) => asFeedItem(i, withdrawn.get(i.id))),
          {
            person: { id: link.personId, status: viewer?.status ?? "archived" },
            contactId: link.contactId,
            decisions: viewer?.decisions ?? [],
            capacityForSharingNow: viewer?.capacityNow ?? "presumed",
            photoBasis: viewer?.photoBasis ?? null,
            now,
          },
          seen,
        );
        return { link, viewer, feed };
      });
      await withTenant(c, async (tx) => {
        for (const { link, viewer, feed } of feeds) {
          if (feed.entries.length > 0) {
            await tx.insert(feedView).values(
              feed.entries.map((e) => ({
                personId: link.personId,
                feedItemId: e.itemId,
                contactId: link.contactId,
                sharingDecisionId: e.decisionId,
                section: FEED_ITEM_SECTIONS[e.kind],
                personStatus: viewer?.status ?? "archived",
                capacityForSharing: viewer?.capacityNow ?? "presumed",
              })),
            );
          }
          await audit(c, tx, access, {
            action: "comms.feed.viewed",
            resourceType: "person",
            resourceId: link.personId,
            scope: {
              contactId: link.contactId,
              closed: feed.state === "paused",
              entries: feed.entries.length,
            },
          });
        }
      });
      c.header("Cache-Control", "no-store");
      return c.json(
        {
          items: feeds.map(({ link, feed }) => ({
            personId: link.personId,
            contactId: link.contactId,
            statement: FEED_NOT_FULL_RECORD_STATEMENT,
            lastUpdateAt:
              feed.state === "paused" ? null : (feed.lastUpdateAt?.toISOString() ?? null),
            entries:
              feed.state === "paused"
                ? []
                : feed.entries.map(({ decisionId: _staffOnly, ...entry }) => entry),
          })),
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/family-portal-links",
      tags: ["comms"],
      summary: "The family portal accounts linked to the person's contacts",
      security,
      request: { params: PersonParam },
      responses: {
        200: jsonBody(FamilyPortalLinkList, "Links"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.sharing.manage");
      const { id } = c.req.valid("param");
      const items = await withTenant(c, async (tx) => {
        await loadPerson(tx, id);
        const rows = await tx
          .select()
          .from(familyPortalUser)
          .where(and(eq(familyPortalUser.personId, id), isNull(familyPortalUser.deletedAt)));
        await audit(c, tx, access, {
          action: "comms.portal_link.list",
          resourceType: "person",
          resourceId: id,
          scope: { count: rows.length },
        });
        return rows.map(linkOut);
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/family-portal-links",
      tags: ["comms"],
      summary: "Link a family portal account to one of the person's contacts",
      description:
        "The account must hold portal roles only, never a person assignment (the database refuses one), and its verified email must be the contact's email; otherwise 422 account_not_contact, audited. What it sees is still decided by the sharing decisions for that contact.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: CreateFamilyPortalLink } } },
      },
      responses: {
        201: jsonBody(FamilyPortalLink, "Linked"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.sharing.manage");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          const p = await loadPerson(tx, id);
          requireWrite(p, "sharing_decision");
          await requireAccountIsContact(c, tx, id, body);
          const held = (await accessRowsOf(tx, [body.tenantUserId])).get(body.tenantUserId);
          const roles = held?.assignments ?? [];
          if (
            roles.length === 0 ||
            roles.some((r) => rolePermissionMix(r.permissions) !== "portal")
          ) {
            throw problems.invalid(
              "A family member needs a portal account holding the family role only, not a staff account.",
            );
          }
          const [row] = await tx
            .insert(familyPortalUser)
            .values({ personId: id, contactId: body.contactId, tenantUserId: body.tenantUserId })
            .returning()
            .catch((error: unknown) => {
              if (dbCode(error) === "23505") throw problems.conflict();
              if (dbCode(error) === "23514") {
                throw problems.invalid("A family portal account cannot be assigned to people.");
              }
              return invalidOnForeignKey("contact or account")(error);
            });
          if (!row) throw problems.conflict();
          await audit(c, tx, access, {
            action: "comms.portal_link.create",
            resourceType: "family_portal_user",
            resourceId: row.id,
            scope: { personId: id, contactId: body.contactId },
          });
          return linkOut(row);
        }),
      );
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/family-portal-links/{linkId}/revoke",
      tags: ["comms"],
      summary: "Revoke a family portal link: the feed closes on the next request",
      security,
      request: {
        params: LinkParams,
        body: { content: { "application/json": { schema: RevokeFamilyPortalLink } } },
      },
      responses: {
        200: jsonBody(FamilyPortalLink, "Revoked"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.sharing.manage");
      const { id, linkId } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await withTenant(c, async (tx) => {
        await loadPerson(tx, id);
        const [row] = await tx
          .select()
          .from(familyPortalUser)
          .where(and(eq(familyPortalUser.id, linkId), eq(familyPortalUser.personId, id)));
        if (!row) throw problems.notFound();
        requireVersion(row.version, body.version);
        if (row.revokedAt) throw problems.invalid("This link has already been revoked.");
        const [updated] = await tx
          .update(familyPortalUser)
          .set({
            revokedAt: new Date(),
            revokedBy: access.tenantUserId,
            revokedReason: body.reason,
          })
          .where(and(eq(familyPortalUser.id, linkId), eq(familyPortalUser.version, body.version)))
          .returning();
        if (!updated) throw problems.conflict();
        await audit(c, tx, access, {
          action: "comms.portal_link.revoke",
          resourceType: "family_portal_user",
          resourceId: linkId,
        });
        return linkOut(updated);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/feed",
      tags: ["comms"],
      summary: "The person's family updates, with any taken down, for staff",
      security,
      request: { params: PersonParam },
      responses: {
        200: jsonBody(StaffFeedItemList, "Updates"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, FEED_PERMISSIONS);
      const { id } = c.req.valid("param");
      const items = await withTenant(c, async (tx) => {
        await loadPerson(tx, id);
        const rows = await tx.select().from(feedItem).where(eq(feedItem.personId, id));
        const withdrawals = await tx
          .select()
          .from(feedItemWithdrawal)
          .where(eq(feedItemWithdrawal.personId, id));
        await audit(c, tx, access, {
          action: "comms.feed.listed",
          resourceType: "person",
          resourceId: id,
          scope: { count: rows.length },
        });
        const byItem = new Map(withdrawals.map((w) => [w.feedItemId, w]));
        return rows
          .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
          .map((r) => {
            const w = byItem.get(r.id);
            return {
              id: r.id,
              personId: r.personId,
              kind: r.kind as FeedItemKind,
              section: r.section,
              carePlanDomain: r.carePlanDomain,
              occurredAt: r.occurredAt.toISOString(),
              composedAt: r.composedAt.toISOString(),
              text: r.text,
              composedBy: r.composedBy,
              withdrawn: w
                ? {
                    reason: w.reason as FeedWithdrawalReason,
                    by: w.withdrawnBy,
                    at: w.withdrawnAt.toISOString(),
                  }
                : null,
            };
          });
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/feed-items/{id}/withdraw",
      tags: ["comms"],
      summary: "Take an update down: it disappears for anyone who had not seen it (HZ-061)",
      security,
      request: {
        params: z.object({ id: z.uuid() }),
        body: { content: { "application/json": { schema: WithdrawFeedItem } } },
      },
      responses: {
        204: { description: "Taken down" },
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "comms.feed.withdraw");
      const { id } = c.req.valid("param");
      const { reason } = c.req.valid("json");
      const now = new Date();
      await withTenant(c, async (tx) => {
        const [item] = await tx.select().from(feedItem).where(eq(feedItem.id, id));
        if (!item) throw problems.notFound();
        const [existing] = await tx
          .select()
          .from(feedItemWithdrawal)
          .where(eq(feedItemWithdrawal.feedItemId, id));
        const found = checkFeedWithdrawal(
          { composedAt: item.composedAt, withdrawnAt: existing?.withdrawnAt ?? null },
          { reason, by: access.tenantUserId, at: now },
          now,
        );
        if (found.includes("already_withdrawn")) throw problems.conflict();
        if (found.length > 0) throw problems.invalid("This update cannot be taken down.");
        await tx
          .insert(feedItemWithdrawal)
          .values({ personId: item.personId, feedItemId: id, reason })
          .catch((error: unknown) => {
            if (dbCode(error) === "23505") throw problems.conflict();
            throw error;
          });
        await audit(c, tx, access, {
          action: "comms.feed.item_withdrawn",
          resourceType: "feed_item",
          resourceId: id,
          scope: { personId: item.personId, reason },
        });
        await publish(tx, {
          context: "comms",
          aggregateType: "feed_item",
          aggregateId: id,
          type: "comms.feed.item_withdrawn",
          payload: { personId: item.personId, feedItemId: id, reason },
        });
      });
      return c.body(null, 204);
    },
  );
