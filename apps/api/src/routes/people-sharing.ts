import {
  CloseSharingDecision,
  CreateSharingDecision,
  SharingDecisionList,
  type SharingDecisionOut,
  SharingVisibility,
} from "@harbour/contracts";
import {
  aboutMeShareLink,
  capacityAssessment,
  contact,
  sharingDecision,
  sharingDecisionSuspension,
  type Transaction,
  tenantUser,
} from "@harbour/db";
import {
  AUTHORITY_CONTACT_ROLES,
  type AuthorityRole,
  authorityHeldNow,
  checkSectionVisibility,
  checkSharingDecision,
  DEPUTY_SCOPES,
  FINANCE_SECTIONS,
  type PersonStatus,
  SHARING_SECTIONS,
  type SharingDecision,
  type SharingDecisionProblem,
  type SharingRecipient,
  type SharingSection,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { AuditedRefusal, withAuditedRefusal } from "../http/audit";
import { type AppEnv, requirePermission, type TenantAccess, withTenant } from "../http/context";
import { problems } from "../http/problem";
import { publish } from "../outbox";
import { loadPerson, requireVersion, requireWrite } from "../services/people";
import {
  decisionsWithLinks,
  personDecisions,
  sharingContext,
  sharingDecisionOut,
} from "../services/sharing";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { audit, invalidOnForeignKey, PersonParam, requireOwnDocument } from "./people-shared";

/**
 * Sharing decisions (people.md rule 13; HZ-022; Caldicott principle 7). Every section of a
 * person's record is closed to family members, professionals and share links until a decision in
 * force covers it: `checkSharingDecision` refuses a decision without a valid basis, and
 * `checkSectionVisibility` decides what a recipient may see now. Every decision expires; a
 * withdrawn or suspended one closes at once; sharing closes when the person leaves or dies.
 */

const DecisionParams = PersonParam.extend({ decisionId: z.uuid() });

const SHARING_MESSAGES: Record<SharingDecisionProblem, string> = {
  no_sections: "Choose what is shared.",
  unknown_section: "That is not a section that can be shared.",
  duplicate_section: "Each section is listed once.",
  care_plan_domains_without_care_plan: "Care plan domains are shared only with the care plan.",
  expiry_before_start: "The decision must end after it starts.",
  expiry_in_past: "The decision must end in the future.",
  person_record_not_live: "Nothing is shared once the person has left the service or died.",
  consent_giver_required: "Say who gave consent: the person, or someone with authority for them.",
  person_lacks_capacity:
    "The person has been assessed as lacking capacity for this decision, so their consent cannot be the basis.",
  authority_required:
    "Record the lasting power of attorney, deputyship or appointeeship relied on.",
  authority_not_recipient:
    "The authority must be held by the family member receiving the information.",
  authority_evidence_required: "Record the reference or the evidence of the authority.",
  authority_expired: "The authority has ended.",
  authority_does_not_cover_section:
    "The authority does not cover every section chosen: a property and finance authority covers finance and benefits, a DWP appointee benefits only, a welfare authority everything else, and a deputy only what their order covers.",
  authority_needs_lack_of_capacity:
    "A health and welfare attorney or deputy acts only when the person lacks capacity for the decision.",
  deputy_order_scope_required: "Record the sections the deputy's Court of Protection order covers.",
  best_interests_decision_required: "Name the best-interests decision relied on.",
  best_interests_needs_lack_of_capacity:
    "A best-interests decision applies only when the person lacks capacity for the decision.",
  direct_care_professionals_only: "Direct care is a basis for sharing with professionals only.",
  direct_care_section_not_clinical: "Direct care covers clinical sections only.",
  link_only_about_me: "A share link carries About Me only.",
  link_not_direct_care: "A share link cannot rest on direct care.",
  suspension_ends_before_start: "A suspension must end after it starts.",
};

/**
 * The authority as recorded on the contact who holds it: the contact must hold that kind of
 * authority, a deputy's order must be of that kind (`contact.authority_scope`) and cover only
 * sections of that kind, and a reference, evidence or end date left out is taken from the
 * contact.
 */
async function authorityFromContact(
  tx: Transaction,
  personId: string,
  authority: NonNullable<CreateSharingDecision["authority"]>,
): Promise<NonNullable<SharingDecision["authority"]>> {
  const [holder] = await tx
    .select({
      role: contact.role,
      scope: contact.authorityScope,
      reference: contact.authorityReference,
      documentId: contact.authorityDocumentId,
      validUntil: contact.validUntil,
    })
    .from(contact)
    .where(
      and(
        eq(contact.id, authority.contactId),
        eq(contact.personId, personId),
        isNull(contact.deletedAt),
      ),
    );
  if (!holder) throw problems.invalid("The contact who holds the authority was not found.");
  if (holder.role !== AUTHORITY_CONTACT_ROLES[authority.role]) {
    throw problems.invalid("The contact does not hold that kind of authority.");
  }
  const scopes = DEPUTY_SCOPES[authority.role];
  if (scopes) {
    if (!holder.scope || !scopes.includes(holder.scope)) {
      throw problems.invalid("The deputy's order is not of that kind.");
    }
    const finance = authority.role === "deputy_property_affairs";
    if (
      (authority.orderSections ?? []).some(
        (section) => FINANCE_SECTIONS.includes(section as SharingSection) !== finance,
      )
    ) {
      throw problems.invalid("The order sections are outside the deputyship.");
    }
  }
  return {
    role: authority.role,
    contactId: authority.contactId,
    reference: authority.reference ?? holder.reference ?? null,
    evidenceDocumentId: authority.evidenceDocumentId ?? holder.documentId ?? null,
    validUntil: authority.validUntil ?? holder.validUntil ?? null,
    orderSections: authority.orderSections ?? null,
  };
}

export const peopleSharingRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/sharing-decisions",
      tags: ["people"],
      summary: "Sharing decisions, with whether each is in force now",
      security,
      request: { params: PersonParam },
      responses: {
        200: jsonBody(SharingDecisionList, "Decisions"),
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
        const rows = await personDecisions(tx, id);
        const context = await sharingContext(tx, id, now);
        await audit(c, tx, access, {
          action: "people.sharing.list",
          resourceType: "person",
          resourceId: id,
          scope: { count: rows.length },
        });
        return rows
          .sort((a, b) => b.validFrom.getTime() - a.validFrom.getTime())
          .map((r) => sharingDecisionOut(r, p.status as PersonStatus, now, context));
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/sharing-decisions",
      tags: ["people"],
      summary: "Record a decision to share sections with one recipient (HZ-022)",
      description:
        "checkSharingDecision: known sections, an expiry, and a valid basis: the person's consent (unless assessed as lacking capacity for it), consent by an attorney or deputy whose authority covers the sections, a legal authority held by the recipient with evidence, a best-interests decision, or direct care for professionals and clinical sections only. The authority must be held by the contact named (a deputy within their deputyship and the sections their order covers; an appointee benefits only); a reference, evidence or end date left out is taken from the contact. A capacity finding names an assessment of the sharing decision. Publishes people.sharing.changed.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: CreateSharingDecision } } },
      },
      responses: {
        201: jsonBody(SharingDecisionList.shape.items.element, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.sharing.manage");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const validFrom = body.validFrom ? new Date(body.validFrom) : now;
      const out = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id);
        requireWrite(p, "sharing_decision");
        if (body.capacity !== "presumed") {
          if (!body.capacityAssessmentId) {
            throw problems.invalid("Name the capacity assessment for this decision.");
          }
          const [assessment] = await tx
            .select({
              personId: capacityAssessment.personId,
              outcome: capacityAssessment.outcome,
              decisionKind: capacityAssessment.decisionKind,
            })
            .from(capacityAssessment)
            .where(eq(capacityAssessment.id, body.capacityAssessmentId));
          const expected =
            body.capacity === "assessed_lacks_capacity" ? "lacks_capacity" : "has_capacity";
          if (assessment?.personId !== id || assessment.outcome !== expected) {
            throw problems.invalid("The capacity assessment named does not show that finding.");
          }
          // Capacity is decision-specific: only an assessment of the sharing decision counts.
          if (assessment.decisionKind !== "sharing") {
            throw problems.invalid(
              "Name an assessment of the person's capacity to decide about sharing their information.",
            );
          }
        }
        if (body.recipient.kind === "professional") {
          const [user] = await tx
            .select({ id: tenantUser.id })
            .from(tenantUser)
            .where(eq(tenantUser.id, body.recipient.tenantUserId));
          if (!user) throw problems.invalid("The professional was not found.");
        }
        const recipient: SharingRecipient =
          body.recipient.kind === "link" ? { kind: "link", linkId: "new" } : body.recipient;
        const authority = body.authority
          ? await authorityFromContact(tx, id, body.authority)
          : null;
        const decision: SharingDecision = {
          id: "new",
          personId: id,
          recipient,
          sections: body.sections,
          carePlanDomains: body.carePlanDomains ?? "all",
          basis: body.basis,
          consentGivenBy: body.consentGivenBy ?? null,
          capacity: body.capacity,
          bestInterestsDecisionId: body.bestInterestsDecisionId ?? null,
          authority,
          validFrom,
          validTo: new Date(body.validTo),
          withdrawnAt: null,
          suspendedAt: null,
        };
        const check = checkSharingDecision(decision, {
          personStatus: p.status as PersonStatus,
          now,
        });
        if (!check.ok) {
          throw problems.invalid(
            [...new Set(check.problems.map((pr) => SHARING_MESSAGES[pr]))].join(" "),
          );
        }
        await requireOwnDocument(
          tx,
          id,
          authority?.evidenceDocumentId,
          "evidence of the authority",
          // A document about the person, never a photo or a care attachment (#119 review L2).
          ["person_document"],
        );
        const [row] = await tx
          .insert(sharingDecision)
          .values({
            personId: id,
            recipientKind: body.recipient.kind,
            recipientContactId: body.recipient.kind === "family" ? body.recipient.contactId : null,
            recipientTenantUserId:
              body.recipient.kind === "professional" ? body.recipient.tenantUserId : null,
            sections: body.sections,
            carePlanDomains: body.carePlanDomains ?? null,
            basis: body.basis,
            consentGivenBy: body.consentGivenBy ?? null,
            capacity: body.capacity,
            capacityAssessmentId: body.capacityAssessmentId ?? null,
            bestInterestsDecisionId: body.bestInterestsDecisionId ?? null,
            authorityRole: authority?.role ?? null,
            authorityContactId: authority?.contactId ?? null,
            authorityReference: authority?.reference ?? null,
            authorityEvidenceDocumentId: authority?.evidenceDocumentId ?? null,
            authorityValidUntil: authority?.validUntil ?? null,
            authorityOrderSections: authority?.orderSections ? [...authority.orderSections] : null,
            validFrom,
            validTo: decision.validTo,
          })
          .returning()
          .catch(invalidOnForeignKey("contact, document, assessment or best-interests decision"));
        if (!row) throw problems.conflict();
        await audit(c, tx, access, {
          action: "people.sharing.create",
          resourceType: "sharing_decision",
          resourceId: row.id,
          scope: { recipient: body.recipient.kind, basis: body.basis, sections: body.sections },
        });
        await publish(tx, {
          context: "people",
          aggregateType: "person",
          aggregateId: id,
          type: "people.sharing.changed",
          payload: { personId: id, reason: "decision_recorded", decisionId: row.id },
        });
        return sharingDecisionOut(
          row,
          p.status as PersonStatus,
          now,
          await sharingContext(tx, id, now),
        );
      });
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/sharing-decisions/{decisionId}/withdraw",
      tags: ["people"],
      summary: "Withdraw a sharing decision: the sections close at once",
      security,
      request: {
        params: DecisionParams,
        body: { content: { "application/json": { schema: CloseSharingDecision } } },
      },
      responses: {
        200: jsonBody(SharingDecisionList.shape.items.element, "Withdrawn"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.sharing.manage");
      const out = await closeDecision(
        c,
        access,
        c.req.valid("param"),
        c.req.valid("json"),
        "withdraw",
      );
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/sharing-decisions/{decisionId}/suspend",
      tags: ["people"],
      summary: "Suspend a sharing decision (for example during a safeguarding enquiry)",
      security,
      request: {
        params: DecisionParams,
        body: { content: { "application/json": { schema: CloseSharingDecision } } },
      },
      responses: {
        200: jsonBody(SharingDecisionList.shape.items.element, "Suspended"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.sharing.manage");
      const out = await closeDecision(
        c,
        access,
        c.req.valid("param"),
        c.req.valid("json"),
        "suspend",
      );
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/sharing-decisions/{decisionId}/lift-suspension",
      tags: ["people"],
      summary:
        "Lift a suspension: the sections reopen, but what happened while suspended stays closed",
      description:
        "Ends the open suspension period with the reason. The decision covers only what happened while it was in force and not suspended (decisionInForceAt; comms.md rule 2). A decision that rests on an authority is lifted only while the contact still holds it as the decision recorded (authorityHeldNow: the same kind of authority, a deputy's order of that kind, no earlier end); otherwise it is refused and the refusal audited with the reason `authority_changed` (HZ-022).",
      security,
      request: {
        params: DecisionParams,
        body: { content: { "application/json": { schema: CloseSharingDecision } } },
      },
      responses: {
        200: jsonBody(SharingDecisionList.shape.items.element, "Suspension lifted"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.sharing.manage");
      const out = await withAuditedRefusal(c, access, () =>
        closeDecision(c, access, c.req.valid("param"), c.req.valid("json"), "lift_suspension"),
      );
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/sharing-decisions/visibility",
      tags: ["people"],
      summary: "What one recipient may see now, section by section (closed by default, HZ-022)",
      security,
      request: {
        params: PersonParam,
        query: z.object({
          contactId: z.uuid().optional(),
          tenantUserId: z.uuid().optional(),
          linkId: z.uuid().optional(),
        }),
      },
      responses: {
        200: jsonBody(SharingVisibility, "Visibility"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.sharing.manage");
      const { id } = c.req.valid("param");
      const query = c.req.valid("query");
      const named = [query.contactId, query.tenantUserId, query.linkId].filter(Boolean);
      if (named.length !== 1) throw problems.invalid("Name one recipient.");
      const recipient: SharingRecipient = query.contactId
        ? { kind: "family", contactId: query.contactId }
        : query.tenantUserId
          ? { kind: "professional", tenantUserId: query.tenantUserId }
          : { kind: "link", linkId: query.linkId ?? "" };
      const now = new Date();
      const visibility = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id);
        const context = await sharingContext(tx, id, now);
        const decisions = await decisionsWithLinks(tx, id, context);
        await audit(c, tx, access, {
          action: "people.sharing.visibility",
          resourceType: "person",
          resourceId: id,
          scope: { recipient: recipient.kind },
        });
        return {
          personId: id,
          recipient:
            recipient.kind === "link"
              ? ({ kind: "link" } as const)
              : recipient.kind === "family"
                ? ({ kind: "family", contactId: recipient.contactId } as const)
                : ({ kind: "professional", tenantUserId: recipient.tenantUserId } as const),
          capacityForSharing: context.capacityNow,
          sections: SHARING_SECTIONS.map((section) => {
            const result = checkSectionVisibility(decisions, {
              personId: id,
              personStatus: p.status as PersonStatus,
              recipient,
              section,
              capacityNow: context.capacityNow,
              now,
            });
            return result.visible
              ? {
                  section,
                  visible: true,
                  decisionId: result.decisionId,
                  expiresAt: result.expiresAt.toISOString(),
                  reason: null,
                }
              : {
                  section,
                  visible: false,
                  decisionId: null,
                  expiresAt: null,
                  reason: result.reason,
                };
          }),
        };
      });
      return c.json(visibility, 200);
    },
  );

/** The message for a suspension that cannot be lifted because its authority has gone. */
const AUTHORITY_GONE =
  "The authority this decision rests on has changed or ended since it was recorded. Withdraw the decision and record a new one if sharing should go on.";

/**
 * Before a suspension is lifted: the contact the decision's authority rests on must still hold it
 * as recorded (HZ-022; #119 review round 2). A decision suspended for a safeguarding enquiry, whose
 * attorney was then changed or removed, stays closed; the refusal is audited after the
 * transaction (`withAuditedRefusal`), never on a second connection while this one is held.
 */
async function requireAuthorityHeld(
  tx: Transaction,
  row: typeof sharingDecision.$inferSelect,
): Promise<void> {
  if (!row.authorityRole || !row.authorityContactId) return;
  const [holder] = await tx
    .select()
    .from(contact)
    .where(and(eq(contact.id, row.authorityContactId), eq(contact.personId, row.personId)));
  const changes = authorityHeldNow(
    {
      basis: row.basis as SharingDecision["basis"],
      consentGivenBy: row.consentGivenBy as SharingDecision["consentGivenBy"],
      authority: {
        role: row.authorityRole as AuthorityRole,
        contactId: row.authorityContactId,
        reference: row.authorityReference,
        evidenceDocumentId: row.authorityEvidenceDocumentId,
        validUntil: row.authorityValidUntil,
      },
    },
    row.authorityContactId,
    holder
      ? {
          role: holder.role,
          authorityScope: holder.authorityScope,
          reference: holder.authorityReference,
          documentId: holder.authorityDocumentId,
          validUntil: holder.validUntil,
          removed: holder.deletedAt !== null,
        }
      : {
          role: "",
          authorityScope: null,
          reference: null,
          documentId: null,
          validUntil: null,
          removed: true,
        },
  );
  if (changes.length === 0) return;
  throw new AuditedRefusal(problems.invalid(AUTHORITY_GONE), {
    action: "people.sharing.lift_suspension",
    outcome: "denied",
    reason: "authority_changed",
    resourceType: "sharing_decision",
    resourceId: row.id,
    scope: { changes },
  });
}

async function closeDecision(
  c: Context<AppEnv>,
  access: TenantAccess,
  { id, decisionId }: { id: string; decisionId: string },
  body: CloseSharingDecision,
  how: "withdraw" | "suspend" | "lift_suspension",
): Promise<SharingDecisionOut> {
  const now = new Date();
  return withTenant(c, async (tx) => {
    const p = await loadPerson(tx, id);
    const [row] = await tx
      .select()
      .from(sharingDecision)
      .where(and(eq(sharingDecision.id, decisionId), isNull(sharingDecision.deletedAt)));
    if (row?.personId !== id) throw problems.notFound();
    requireVersion(row.version, body.version);
    if (row.withdrawnAt) throw problems.invalid("This decision has already been withdrawn.");
    if (how === "suspend" && row.suspendedAt) {
      throw problems.invalid("This decision is already suspended.");
    }
    if (how === "lift_suspension" && !row.suspendedAt) {
      throw problems.invalid("This decision is not suspended.");
    }
    if (how === "lift_suspension") await requireAuthorityHeld(tx, row);
    const [updated] = await tx
      .update(sharingDecision)
      .set(
        how === "withdraw"
          ? { withdrawnAt: now, withdrawnReason: body.reason }
          : how === "suspend"
            ? { suspendedAt: now, suspendedReason: body.reason }
            : { suspendedAt: null, suspendedReason: null },
      )
      .where(and(eq(sharingDecision.id, decisionId), eq(sharingDecision.version, body.version)))
      .returning();
    if (!updated) throw problems.conflict();
    if (how === "suspend") {
      // Each suspension is a period, so what happens while it lasts stays closed afterwards.
      await tx.insert(sharingDecisionSuspension).values({
        personId: id,
        sharingDecisionId: decisionId,
        suspendedAt: now,
        reason: body.reason,
      });
    }
    if (how === "lift_suspension") {
      const [open] = await tx
        .select()
        .from(sharingDecisionSuspension)
        .where(
          and(
            eq(sharingDecisionSuspension.sharingDecisionId, decisionId),
            isNull(sharingDecisionSuspension.liftedAt),
            isNull(sharingDecisionSuspension.deletedAt),
          ),
        );
      const since = open?.suspendedAt ?? row.suspendedAt ?? now;
      // A period ends after it starts, even when lifted within the same millisecond.
      const liftedAt = new Date(Math.max(now.getTime(), since.getTime() + 1));
      if (open) {
        await tx
          .update(sharingDecisionSuspension)
          .set({ liftedAt, liftedBy: access.tenantUserId, liftedReason: body.reason })
          .where(eq(sharingDecisionSuspension.id, open.id));
      } else {
        await tx.insert(sharingDecisionSuspension).values({
          personId: id,
          sharingDecisionId: decisionId,
          suspendedAt: since,
          reason: row.suspendedReason ?? "Suspended",
          liftedAt,
          liftedBy: access.tenantUserId,
          liftedReason: body.reason,
        });
      }
    }
    if (how === "withdraw") {
      await tx
        .update(aboutMeShareLink)
        .set({ revokedAt: now, revokedReason: "The sharing decision was withdrawn" })
        .where(
          and(
            eq(aboutMeShareLink.sharingDecisionId, decisionId),
            isNull(aboutMeShareLink.revokedAt),
          ),
        );
    }
    await audit(c, tx, access, {
      action: `people.sharing.${how}`,
      resourceType: "sharing_decision",
      resourceId: decisionId,
      reason: body.reason,
    });
    await publish(tx, {
      context: "people",
      aggregateType: "person",
      aggregateId: id,
      type: "people.sharing.changed",
      payload: {
        personId: id,
        reason:
          how === "withdraw" ? "withdrawn" : how === "suspend" ? "suspended" : "suspension_lifted",
        decisionId,
      },
    });
    return sharingDecisionOut(
      updated,
      p.status as PersonStatus,
      now,
      await sharingContext(tx, id, now),
    );
  });
}
