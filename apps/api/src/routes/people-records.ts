import { createHash, randomBytes } from "node:crypto";
import {
  type AboutMeDocument as AboutMeDocumentOut,
  AboutMeOut,
  AboutMeShareLinkCreated,
  AboutMeShareLinkList,
  type AboutMeShareLinkOut,
  CarePlanChangeList,
  type CarePlanChangeOut,
  CreateAboutMeShareLink,
  CreateCarePlanChange,
  CreateReviewRecord,
  LocationReviews,
  type ReviewDue as ReviewDueOut,
  type ReviewRecordOut,
  ReviewSchedule,
  RevokeShareLink,
  UpdateAboutMe,
} from "@harbour/contracts";
import {
  aboutMe,
  aboutMeShareLink,
  carePlanChange,
  document,
  location,
  person,
  placement,
  reviewRecord,
  sharingDecision,
  type Transaction,
} from "@harbour/db";
import {
  type AboutMeDocument,
  type AboutMeIssue,
  checkAboutMeShareLink,
  checkSectionVisibility,
  LIVE_PERSON_STATUSES,
  type PersonStatus,
  type ReviewDue,
  summariseAboutMe,
  ukIsoDate,
  validateAboutMe,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import { requirePermission, withTenant } from "../http/context";
import { problems } from "../http/problem";
import { publish } from "../outbox";
import {
  completeReviewTask,
  currentPlacement,
  loadPerson,
  recordCarePlanChange,
  requireVersion,
  requireWrite,
  reviewScheduleFor,
} from "../services/people";
import { toSharingDecision } from "../services/sharing";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import {
  audit,
  invalidOnForeignKey,
  iso,
  PersonParam,
  requireAnyPermission,
  requireOwnDocument,
  requireStepUp,
} from "./people-shared";

/**
 * About Me and its share links (people.md rules 9 and 13), and the review scheduler with its
 * records and the changes that bring the care plan review forward (rule 8, HZ-008). Every rule
 * is the domain's; reads and writes are audited by record id, never content.
 */

const LinkParams = PersonParam.extend({ linkId: z.uuid() });

const ABOUT_ME_MESSAGES: Record<AboutMeIssue["kind"], string> = {
  unknown_section: "That is not an About Me section.",
  inline_media: "Add pictures and recordings as documents, not inside the text.",
  supporter_required: "Say who supported the person to write this.",
  invalid_update_time: "The date it was last updated is not a real date.",
};

function aboutMeOut(personId: string, row: typeof aboutMe.$inferSelect | undefined): AboutMeOut {
  const sections = (row?.sections ?? {}) as AboutMeDocument;
  const summary = summariseAboutMe(row ? sections : null);
  return {
    personId,
    sections: sections as AboutMeDocumentOut,
    authoredByPerson: row?.authoredByPerson ?? false,
    summary: {
      filled: [...summary.filled],
      missing: [...summary.missing],
      dateLastUpdated: iso(summary.dateLastUpdated),
      hasContent: summary.hasContent,
    },
    updatedAt: iso(row?.updatedAt),
    version: row?.version ?? 0,
  };
}

type LinkRow = typeof aboutMeShareLink.$inferSelect;
type DecisionRow = typeof sharingDecision.$inferSelect;

function linkOut(
  row: LinkRow,
  decision: DecisionRow | undefined,
  status: PersonStatus,
  now: Date,
): AboutMeShareLinkOut {
  const visible =
    decision !== undefined &&
    checkSectionVisibility([toSharingDecision(decision, row.id)], {
      personId: row.personId,
      personStatus: status,
      recipient: { kind: "link", linkId: row.id },
      section: "about_me",
      now,
    }).visible;
  return {
    id: row.id,
    personId: row.personId,
    sharingDecisionId: row.sharingDecisionId,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: iso(row.revokedAt),
    revokedReason: row.revokedReason,
    lastOpenedAt: iso(row.lastOpenedAt),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    active: visible && row.revokedAt === null && row.expiresAt.getTime() > now.getTime(),
  };
}

function reviewOut(
  row: typeof reviewRecord.$inferSelect,
  superseded: ReadonlySet<string>,
): ReviewRecordOut {
  return {
    id: row.id,
    personId: row.personId,
    kind: row.kind as ReviewRecordOut["kind"],
    heldOn: row.heldOn,
    participants: row.participants as ReviewRecordOut["participants"],
    familyInvolvementKind: row.familyInvolvementKind as ReviewRecordOut["familyInvolvementKind"],
    laReference: row.laReference,
    changesCovered: row.changesCovered,
    outcome: row.outcome,
    documentId: row.documentId,
    supersedesId: row.supersedesId,
    correctionReason: row.correctionReason,
    superseded: superseded.has(row.id),
    recordedBy: row.createdBy,
    recordedAt: row.createdAt.toISOString(),
  };
}

function changeOut(row: typeof carePlanChange.$inferSelect): CarePlanChangeOut {
  return {
    id: row.id,
    personId: row.personId,
    kind: row.kind as CarePlanChangeOut["kind"],
    occurredOn: row.occurredOn,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    reviewedOn: row.reviewedOn,
    reviewRecordId: row.reviewRecordId,
    version: row.version,
  };
}

function dueOut(item: ReviewDue): ReviewDueOut {
  return {
    kind: item.kind,
    dueOn: item.dueOn,
    windowOpensOn: item.windowOpensOn,
    dueAt: iso(item.dueAt),
    state: item.state,
    changeIds: [...item.changeIds],
    basis: [...item.basis],
  };
}

async function changesFor(tx: Transaction, personId: string) {
  return tx
    .select()
    .from(carePlanChange)
    .where(and(eq(carePlanChange.personId, personId), isNull(carePlanChange.deletedAt)))
    .orderBy(desc(carePlanChange.occurredOn));
}

export const peopleRecordsRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/about-me",
      tags: ["people"],
      summary: "About Me (PRSB v2.01), with the sections filled and missing",
      security,
      request: { params: PersonParam },
      responses: { 200: jsonBody(AboutMeOut, "About Me"), ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.person.read");
      const { id } = c.req.valid("param");
      const out = await withTenant(c, async (tx) => {
        await loadPerson(tx, id);
        const [row] = await tx.select().from(aboutMe).where(eq(aboutMe.personId, id));
        await audit(c, tx, access, {
          action: "people.about_me.view",
          resourceType: "about_me",
          resourceId: row?.id ?? id,
        });
        return aboutMeOut(id, row);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/people/{id}/about-me",
      tags: ["people"],
      summary: "Write About Me with the person (rule 9)",
      description:
        "validateAboutMe: the seven PRSB sections, each optional; media as document references only; and when the person did not write it alone, who supported them. The date last updated is set on saving.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: UpdateAboutMe } } },
      },
      responses: {
        200: jsonBody(AboutMeOut, "Saved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [
        "people.person.update",
        "care.plan.write",
        "comms.portal.self",
      ]);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const sections = { ...body.sections, date_last_updated: now.toISOString() } as Record<
        string,
        unknown
      >;
      const issues = validateAboutMe(sections, { authoredByPerson: body.authoredByPerson });
      if (issues.length > 0) {
        throw problems.invalid(
          [...new Set(issues.map((i) => ABOUT_ME_MESSAGES[i.kind]))].join(" "),
        );
      }
      const out = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id);
        requireWrite(p, "about_me");
        const mediaIds = Object.values(body.sections).flatMap((section) =>
          section &&
          typeof section === "object" &&
          "media" in section &&
          Array.isArray(section.media)
            ? section.media.map((m: { documentId: string }) => m.documentId)
            : [],
        );
        if (mediaIds.length > 0) {
          const docs = await tx
            .select({ id: document.id, personId: document.personId })
            .from(document)
            .where(inArray(document.id, mediaIds));
          if (docs.length !== new Set(mediaIds).size || docs.some((d) => d.personId !== id)) {
            throw problems.invalid(
              "A picture or recording was not found in this person's documents.",
            );
          }
        }
        const [existing] = await tx.select().from(aboutMe).where(eq(aboutMe.personId, id));
        requireVersion(existing?.version ?? 0, body.version);
        const [saved] = existing
          ? await tx
              .update(aboutMe)
              .set({ sections, authoredByPerson: body.authoredByPerson })
              .where(and(eq(aboutMe.id, existing.id), eq(aboutMe.version, body.version)))
              .returning()
          : await tx
              .insert(aboutMe)
              .values({ personId: id, sections, authoredByPerson: body.authoredByPerson })
              .onConflictDoNothing()
              .returning();
        if (!saved) throw problems.conflict();
        await audit(c, tx, access, {
          action: "people.about_me.update",
          resourceType: "about_me",
          resourceId: saved.id,
          scope: { authoredByPerson: body.authoredByPerson },
        });
        return aboutMeOut(id, saved);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/about-me/links",
      tags: ["people"],
      summary: "About Me share links (never the tokens)",
      security,
      request: { params: PersonParam },
      responses: {
        200: jsonBody(AboutMeShareLinkList, "Links"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.sharing.manage");
      const { id } = c.req.valid("param");
      const now = new Date();
      const items = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id);
        const links = await tx
          .select()
          .from(aboutMeShareLink)
          .where(and(eq(aboutMeShareLink.personId, id), isNull(aboutMeShareLink.deletedAt)))
          .orderBy(desc(aboutMeShareLink.createdAt));
        const decisions = await tx
          .select()
          .from(sharingDecision)
          .where(eq(sharingDecision.personId, id));
        await audit(c, tx, access, {
          action: "people.about_me_link.list",
          resourceType: "person",
          resourceId: id,
          scope: { count: links.length },
        });
        return links.map((l) =>
          linkOut(
            l,
            decisions.find((d) => d.id === l.sharingDecisionId),
            p.status as PersonStatus,
            now,
          ),
        );
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/about-me/links",
      tags: ["people"],
      summary: "Make an expiring link to About Me under a sharing decision",
      description:
        "checkAboutMeShareLink: a decision for a share link that covers About Me and is in force, and an expiry in the future that never outlives the decision. The token is returned once; only its SHA-256 hash is stored.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: CreateAboutMeShareLink } } },
      },
      responses: {
        201: jsonBody(AboutMeShareLinkCreated, "Made"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.sharing.manage");
      // A link opens About Me to whoever holds it: it needs a fresh sign-in (step-up).
      await requireStepUp(c, access, "people.about_me.link.create");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const expiresAt = new Date(body.expiresAt);
      const created = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id);
        requireWrite(p, "sharing_decision");
        const [decision] = await tx
          .select()
          .from(sharingDecision)
          .where(
            and(eq(sharingDecision.id, body.sharingDecisionId), eq(sharingDecision.personId, id)),
          );
        if (!decision) throw problems.invalid("The sharing decision was not found.");
        const check = checkAboutMeShareLink(toSharingDecision(decision, "new"), {
          personStatus: p.status as PersonStatus,
          linkExpiresAt: expiresAt,
          now,
        });
        if (!check.ok) {
          const messages: Record<(typeof check.problems)[number], string> = {
            not_a_link_decision: "The decision is not for a share link.",
            about_me_not_covered: "The decision does not cover About Me.",
            decision_not_in_force: "The decision is not in force.",
            link_expiry_in_past: "The link must expire in the future.",
            link_outlives_decision: "The link cannot last longer than the decision.",
          };
          throw problems.invalid(check.problems.map((pr) => messages[pr]).join(" "));
        }
        const token = randomBytes(32).toString("base64url");
        const tokenHash = createHash("sha256").update(token).digest("hex");
        const [row] = await tx
          .insert(aboutMeShareLink)
          .values({ personId: id, sharingDecisionId: decision.id, tokenHash, expiresAt })
          .returning();
        if (!row) throw problems.conflict();
        await audit(c, tx, access, {
          action: "people.about_me_link.create",
          resourceType: "about_me_share_link",
          resourceId: row.id,
          scope: { sharingDecisionId: decision.id, expiresAt: expiresAt.toISOString() },
        });
        await publish(tx, {
          context: "people",
          aggregateType: "person",
          aggregateId: id,
          type: "people.sharing.changed",
          payload: { personId: id, reason: "link_created", linkId: row.id },
        });
        return { ...linkOut(row, decision, p.status as PersonStatus, now), token };
      });
      return c.json(created, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/about-me/links/{linkId}/revoke",
      tags: ["people"],
      summary: "Revoke an About Me share link",
      security,
      request: {
        params: LinkParams,
        body: { content: { "application/json": { schema: RevokeShareLink } } },
      },
      responses: {
        200: jsonBody(AboutMeShareLinkList.shape.items.element, "Revoked"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.sharing.manage");
      const { id, linkId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const out = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id);
        const [row] = await tx
          .select()
          .from(aboutMeShareLink)
          .where(eq(aboutMeShareLink.id, linkId));
        if (row?.personId !== id) throw problems.notFound();
        requireVersion(row.version, body.version);
        if (row.revokedAt) throw problems.invalid("This link has already been revoked.");
        const [updated] = await tx
          .update(aboutMeShareLink)
          .set({ revokedAt: now, revokedReason: body.reason })
          .where(and(eq(aboutMeShareLink.id, linkId), eq(aboutMeShareLink.version, body.version)))
          .returning();
        if (!updated) throw problems.conflict();
        const [decision] = await tx
          .select()
          .from(sharingDecision)
          .where(eq(sharingDecision.id, updated.sharingDecisionId));
        await audit(c, tx, access, {
          action: "people.about_me_link.revoke",
          resourceType: "about_me_share_link",
          resourceId: linkId,
          reason: body.reason,
        });
        await publish(tx, {
          context: "people",
          aggregateType: "person",
          aggregateId: id,
          type: "people.sharing.changed",
          payload: { personId: id, reason: "link_revoked", linkId },
        });
        return linkOut(updated, decision, p.status as PersonStatus, now);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/reviews",
      tags: ["people"],
      summary: "When each review falls due, with the review records and changes in need (rule 8)",
      description:
        "scheduleReviews with the rate-table figures and the location's bank holidays: the first care plan, the regular review and one review on change covering every unreviewed change (HZ-008), paused while the person is in hospital; the local authority review for council-funded placements; family involvement; and a trial's review. Empty for people not receiving care; `available` is false where the nation has no figures yet.",
      security,
      request: { params: PersonParam },
      responses: {
        200: jsonBody(ReviewSchedule, "Schedule"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, ["care.plan.read", "people.person.read"]);
      const { id } = c.req.valid("param");
      const now = new Date();
      const schedule = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id);
        const { schedule: due, available } = await reviewScheduleFor(tx, access.tenantId, p, now);
        const rows = await tx
          .select()
          .from(reviewRecord)
          .where(eq(reviewRecord.personId, id))
          .orderBy(desc(reviewRecord.heldOn));
        const superseded = new Set(rows.flatMap((r) => (r.supersedesId ? [r.supersedesId] : [])));
        await audit(c, tx, access, {
          action: "people.reviews.view",
          resourceType: "person",
          resourceId: id,
        });
        return {
          personId: id,
          available,
          items: due.items.map(dueOut),
          familyInvolvement: due.familyInvolvement,
          records: rows.map((r) => reviewOut(r, superseded)),
          changes: (await changesFor(tx, id)).map(changeOut),
        };
      });
      return c.json(schedule, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/reviews",
      tags: ["people"],
      summary: "Record a review: care plan, local authority, family involvement or trial",
      description:
        "Append-only (a correction supersedes with a reason). A care plan review covers the changes it names, or every unreviewed change up to the day it was held (HZ-008); a trial review records the placement's trial as reviewed; the open review task of the kind is completed with the record as evidence.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: CreateReviewRecord } } },
      },
      responses: {
        201: jsonBody(ReviewSchedule.shape.records.element, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.plan.write");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      if (body.heldOn > ukIsoDate(now))
        throw problems.invalid("A review cannot be held in the future.");
      if ((body.kind === "family_involvement") !== (body.familyInvolvementKind !== undefined)) {
        throw problems.invalid(
          body.kind === "family_involvement"
            ? "Say how the family or representative was involved."
            : "Family involvement is recorded with a family involvement review only.",
        );
      }
      if (body.supersedesId && !body.correctionReason) {
        throw problems.invalid("Say why the earlier review record is being corrected.");
      }
      const out = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id);
        requireWrite(p, "care_plan");
        if (body.supersedesId) {
          const [original] = await tx
            .select({ personId: reviewRecord.personId, kind: reviewRecord.kind })
            .from(reviewRecord)
            .where(eq(reviewRecord.id, body.supersedesId));
          if (original?.personId !== id || original.kind !== body.kind) {
            throw problems.invalid("The review record being corrected was not found.");
          }
        }
        const open = await tx
          .select()
          .from(carePlanChange)
          .where(
            and(
              eq(carePlanChange.personId, id),
              isNull(carePlanChange.reviewedOn),
              isNull(carePlanChange.deletedAt),
              lte(carePlanChange.occurredOn, body.heldOn),
            ),
          );
        const covered =
          body.kind === "care_plan"
            ? (body.changesCovered ?? open.map((x) => x.id))
            : (body.changesCovered ?? []);
        if (covered.some((changeId) => !open.some((x) => x.id === changeId))) {
          throw problems.invalid("A change named was not found, or has already been reviewed.");
        }
        await requireOwnDocument(tx, id, body.documentId, "review document");
        const [row] = await tx
          .insert(reviewRecord)
          .values({
            personId: id,
            kind: body.kind,
            heldOn: body.heldOn,
            participants: body.participants,
            familyInvolvementKind: body.familyInvolvementKind ?? null,
            laReference: body.laReference ?? null,
            changesCovered: covered,
            outcome: body.outcome ?? null,
            documentId: body.documentId ?? null,
            supersedesId: body.supersedesId ?? null,
            correctionReason: body.correctionReason ?? null,
          })
          .returning()
          .catch(invalidOnForeignKey("document"));
        if (!row) throw problems.conflict();
        if (covered.length > 0) {
          await tx
            .update(carePlanChange)
            .set({ reviewedOn: body.heldOn, reviewRecordId: row.id })
            .where(inArray(carePlanChange.id, covered));
        }
        if (body.kind === "trial_review") {
          const current = await currentPlacement(tx, id);
          if (current?.type === "trial") {
            await tx
              .update(placement)
              .set({ trialReviewedOn: body.heldOn })
              .where(eq(placement.id, current.id));
          }
        }
        if (body.kind !== "care_plan") {
          await completeReviewTask(tx, {
            personId: id,
            kind: body.kind,
            recordId: row.id,
            actor: access.tenantUserId,
            now,
          });
        }
        await audit(c, tx, access, {
          action: body.supersedesId ? "people.review.correct" : "people.review.create",
          resourceType: "review_record",
          resourceId: row.id,
          reason: body.correctionReason,
          scope: { kind: body.kind, changesCovered: covered.length },
        });
        return reviewOut(row, new Set());
      });
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/care-plan-changes",
      tags: ["people"],
      summary: "Changes in need that bring the care plan review forward",
      security,
      request: { params: PersonParam },
      responses: {
        200: jsonBody(CarePlanChangeList, "Changes"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, ["care.plan.read", "people.person.read"]);
      const { id } = c.req.valid("param");
      const items = await withTenant(c, async (tx) => {
        await loadPerson(tx, id);
        await audit(c, tx, access, {
          action: "people.care_plan_change.list",
          resourceType: "person",
          resourceId: id,
        });
        return (await changesFor(tx, id)).map(changeOut);
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/care-plan-changes",
      tags: ["people"],
      summary: "Record a change in need: the care plan review comes forward, once (HZ-008)",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: CreateCarePlanChange } } },
      },
      responses: {
        201: jsonBody(CarePlanChangeList.shape.items.element, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.plan.write");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      if (body.occurredOn > ukIsoDate(now))
        throw problems.invalid("A change cannot be in the future.");
      if ((body.sourceType === undefined) !== (body.sourceId === undefined)) {
        throw problems.invalid("Name both the kind of source record and its id, or neither.");
      }
      const out = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id);
        requireWrite(p, "care_plan");
        const row = await recordCarePlanChange(
          tx,
          p,
          {
            kind: body.kind,
            occurredOn: body.occurredOn,
            sourceType: body.sourceType ?? null,
            sourceId: body.sourceId ?? null,
          },
          now,
        );
        const saved =
          row ??
          (
            await tx
              .select()
              .from(carePlanChange)
              .where(
                and(
                  eq(carePlanChange.personId, id),
                  eq(carePlanChange.sourceId, body.sourceId ?? ""),
                  eq(carePlanChange.kind, body.kind),
                ),
              )
          )[0];
        if (!saved) throw problems.conflict();
        await audit(c, tx, access, {
          action: "people.care_plan_change.create",
          resourceType: "care_plan_change",
          resourceId: saved.id,
          scope: { kind: body.kind },
        });
        return changeOut(saved);
      });
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/locations/{id}/reviews",
      tags: ["people"],
      summary: "Reviews due and overdue at a location, soonest first",
      security,
      request: { params: z.object({ id: z.uuid() }) },
      responses: {
        200: jsonBody(LocationReviews, "Reviews"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, ["care.plan.read", "people.person.read"]);
      const { id } = c.req.valid("param");
      const now = new Date();
      const result = await withTenant(c, async (tx) => {
        const [loc] = await tx
          .select({ id: location.id })
          .from(location)
          .where(eq(location.id, id));
        if (!loc) throw problems.notFound();
        const people = await tx
          .select({ id: person.id })
          .from(person)
          .where(
            and(
              eq(person.locationId, id),
              isNull(person.deletedAt),
              inArray(person.status, [...LIVE_PERSON_STATUSES]),
            ),
          )
          .orderBy(asc(person.familyName));
        const items: (ReviewDueOut & { personId: string })[] = [];
        for (const { id: personId } of people) {
          const p = await loadPerson(tx, personId);
          const { schedule } = await reviewScheduleFor(tx, access.tenantId, p, now);
          for (const item of schedule.items) {
            if (item.state === "due" || item.state === "overdue") {
              items.push({ ...dueOut(item), personId });
            }
          }
        }
        items.sort((a, b) => (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : 0));
        await audit(c, tx, access, {
          action: "people.reviews.location_view",
          resourceType: "location",
          resourceId: id,
          scope: { count: items.length },
        });
        return { locationId: id, items };
      });
      return c.json(result, 200);
    },
  );
