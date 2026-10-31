import {
  ContactList,
  ContactOut,
  ContactSaved,
  CreateContact,
  PersonDetails,
  UpdateContact,
  UpdatePersonDetails,
} from "@harbour/contracts";
import {
  contact,
  familyPortalUser,
  person,
  sharingDecision,
  sharingDecisionSuspension,
  type Transaction,
  task,
  withRequestContext,
} from "@harbour/db";
import {
  type AuthorityHolder,
  type AuthorityRole,
  authorityChangeEffects,
  type SharingDecision,
  ukIsoDate,
  validateNhsNumber,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, gt, isNull, ne } from "drizzle-orm";
import type { Context } from "hono";
import { AuditedRefusal, withAuditedRefusal, writeAudit } from "../http/audit";
import {
  type AppEnv,
  permissionsReaching,
  requirePermission,
  stepUpRefusal,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { PerUserQuota, QuotaExceeded } from "../http/quota";
import { publish } from "../outbox";
import { loadPerson, type PersonRow, requireVersion, requireWrite } from "../services/people";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { audit, dbCode, PersonParam, requireOwnDocument } from "./people-shared";
import { stepUpFresh } from "./workflow-shared";

/**
 * Personal details and contacts (PEOP-001; people.md rule 15; data-standards.md `person` and
 * `contact`): the MODS-aligned demographics, the national data opt-out flag as the home records
 * it, and the person's key contacts and legal representatives with their authority, evidence and
 * end date. Reads need `people.person.read` and follow the person's scope; changes need
 * `people.person.update` where it reaches the person (ADR-0071), carry the version they were
 * made from, and are refused once the record is read-only (rule 1). Every earlier version is kept
 * by the database (`record_version`). Audited by record id and the names of the fields changed,
 * never their values.
 */

const ContactParams = PersonParam.extend({ contactId: z.uuid() });

/** Evidence of an authority is a document about the person, never a photo or a care attachment. */
const EVIDENCE_CATEGORIES = ["person_document"] as const;

/**
 * NHS numbers refused because they are on a record the caller cannot see, per member per hour:
 * each refusal says a number is in use somewhere, so probing is limited (#119 review M1). A product
 * setting, not a statutory figure, so it is not in the rate table.
 */
const NHS_IN_USE_REFUSALS = new PerUserQuota("people.nhs_number_in_use", 3, 60 * 60_000);

/** Said when a number is already on the record of someone the caller can see. */
const NHS_IN_USE_VISIBLE =
  "This NHS number is already recorded for someone else in this organisation. Check it.";
/**
 * Said when the number is on a record the caller cannot see: nothing about whose, or where. A
 * manager who works across the organisation is given a task to look for a duplicate record.
 */
const NHS_NOT_SAVED =
  "This NHS number could not be saved for this person. Check it against their documents. A manager has been asked to review it.";

/** A value Postgres would not store (SQLSTATE class 22, data exception), refused in words. */
function invalidOnDataException(error: unknown): never {
  if (dbCode(error)?.startsWith("22")) {
    throw problems.invalid("A detail could not be stored. Check what was entered and try again.");
  }
  throw error;
}

/** A missing document (a foreign key that points nowhere) or a value Postgres would not store. */
function invalidOnStore(error: unknown): never {
  if (dbCode(error) === "23503") throw problems.invalid("The evidence document was not found.");
  return invalidOnDataException(error);
}

/** The member's own view, whatever the route's scope (ADR-0071): their quota rows only. */
function ownView<T>(
  c: Context<AppEnv>,
  access: TenantAccess,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return withRequestContext(
    c.get("services").db,
    { ...access.context, scope: "none", locationIds: [] },
    fn,
  );
}

/** The kind of the task that asks someone across the organisation to look for a duplicate. */
const DUPLICATE_REVIEW_KIND = "people.duplicate_record_review";

/**
 * After an NHS number was refused because it is on a record the caller cannot see (the change
 * rolled back; the reservation against the member's hourly limit stands): audited as a refusal by
 * the person's id, without the number, and one open task for the owner (a role across the
 * organisation, which can see both records) to look for a duplicate. Each step is tried on its
 * own, logged by opaque ids if it fails, so the refusal is still answered.
 */
async function afterNhsNumberInUse(
  c: Context<AppEnv>,
  access: TenantAccess,
  personId: string,
  locationId: string,
): Promise<void> {
  const { appPool, logger } = c.get("services");
  const ids = { tenantId: access.tenantId, tenantUserId: access.tenantUserId, personId };
  try {
    await writeAudit(appPool, access, {
      action: "people.person.update",
      outcome: "denied",
      reason: "nhs_number_in_use",
      resourceType: "person",
      resourceId: personId,
      requestId: c.get("requestId"),
    });
  } catch {
    logger.error(ids, "refused NHS number change could not be audited");
  }
  try {
    const now = new Date();
    await withTenant(c, async (tx) => {
      const [open] = await tx
        .select({ id: task.id })
        .from(task)
        .where(
          and(
            eq(task.kind, DUPLICATE_REVIEW_KIND),
            eq(task.personId, personId),
            eq(task.status, "open"),
          ),
        );
      if (open) return;
      await tx.insert(task).values({
        kind: DUPLICATE_REVIEW_KIND,
        title: "Check for a duplicate record: an NHS number could not be saved",
        requiredPermission: "people.person.update",
        personId,
        locationId,
        sourceType: "person",
        sourceId: personId,
        assigneeRoleKey: "owner",
        dueAt: now,
        priority: "urgent",
      });
    });
  } catch {
    logger.error(ids, "duplicate record review task could not be raised");
  }
}

/** The contact as the sharing rules read its authority (people.md rule 13). */
function holderOf(row: typeof contact.$inferSelect): AuthorityHolder {
  return {
    role: row.role,
    authorityScope: row.authorityScope,
    reference: row.authorityReference,
    documentId: row.authorityDocumentId,
    validUntil: row.validUntil,
    removed: row.deletedAt !== null,
  };
}

/**
 * Suspends, in the caller's transaction, every sharing decision not yet ended whose authority
 * the change to this contact took away (HZ-022, fail closed; #119 review M3): each is audited with
 * the reason `authority_changed` and publishes people.sharing.changed, so the family feed and
 * share links close at once. A manager reviews each on the sharing tab and lifts or withdraws it.
 */
async function suspendDecisionsOnAuthority(
  c: Context<AppEnv>,
  tx: Transaction,
  access: TenantAccess,
  personId: string,
  contactId: string,
  before: AuthorityHolder,
  after: AuthorityHolder,
  now: Date,
): Promise<number> {
  const rows = await tx
    .select()
    .from(sharingDecision)
    .where(
      and(
        eq(sharingDecision.personId, personId),
        eq(sharingDecision.authorityContactId, contactId),
        isNull(sharingDecision.withdrawnAt),
        isNull(sharingDecision.deletedAt),
        gt(sharingDecision.validTo, now),
      ),
    );
  let suspended = 0;
  for (const row of rows) {
    const decision: Pick<SharingDecision, "basis" | "consentGivenBy" | "authority"> = {
      basis: row.basis as SharingDecision["basis"],
      consentGivenBy: row.consentGivenBy as SharingDecision["consentGivenBy"],
      authority:
        row.authorityRole && row.authorityContactId
          ? {
              role: row.authorityRole as AuthorityRole,
              contactId: row.authorityContactId,
              reference: row.authorityReference,
              evidenceDocumentId: row.authorityEvidenceDocumentId,
              validUntil: row.authorityValidUntil,
            }
          : null,
    };
    const effects = authorityChangeEffects(decision, contactId, before, after);
    if (effects.length === 0) continue;
    if (row.suspendedAt) {
      // Already suspended (for example during a safeguarding enquiry): it stays so, and lifting it
      // checks the authority again (authorityHeldNow), so it cannot reopen on what was taken away.
      await audit(c, tx, access, {
        action: "people.sharing.authority_changed",
        resourceType: "sharing_decision",
        resourceId: row.id,
        reason: "authority_changed",
        scope: { contactId, changes: effects, alreadySuspended: true },
      });
      continue;
    }
    const reason =
      "The authority it rests on was changed. Review it, then lift the suspension or withdraw it.";
    await tx
      .update(sharingDecision)
      .set({ suspendedAt: now, suspendedReason: reason })
      .where(eq(sharingDecision.id, row.id));
    await tx.insert(sharingDecisionSuspension).values({
      personId,
      sharingDecisionId: row.id,
      suspendedAt: now,
      reason,
    });
    await audit(c, tx, access, {
      action: "people.sharing.suspend",
      resourceType: "sharing_decision",
      resourceId: row.id,
      reason: "authority_changed",
      scope: { contactId, changes: effects },
    });
    await publish(tx, {
      context: "people",
      aggregateType: "person",
      aggregateId: personId,
      type: "people.sharing.changed",
      payload: { personId, reason: "suspended", decisionId: row.id },
    });
    suspended += 1;
  }
  return suspended;
}

/** The contact roles that are a legal authority to act for the person (rule 13). */
const AUTHORITY_ROLES: ReadonlySet<string> = new Set([
  "lpa_health_welfare",
  "lpa_property_finance",
  "deputy",
  "appointee",
]);

const POSTCODE = /^[A-Z]{1,2}[0-9][A-Z0-9]? [0-9][A-Z]{2}$/;

/** "zz993zz" as "ZZ99 3ZZ" (data-standards.md: upper case, single space), or null if it is not one. */
export function normalisePostcode(value: string): string | null {
  const compact = value.toUpperCase().replace(/\s+/g, "");
  if (compact.length < 5 || compact.length > 7) return null;
  const spaced = `${compact.slice(0, -3)} ${compact.slice(-3)}`;
  return POSTCODE.test(spaced) ? spaced : null;
}

function detailsOut(p: PersonRow): PersonDetails {
  return {
    personId: p.id,
    status: p.status as PersonDetails["status"],
    nhsNumber: p.nhsNumber,
    localIdentifier: p.localIdentifier,
    title: p.title,
    givenName: p.givenName,
    familyName: p.familyName,
    preferredName: p.preferredName,
    dateOfBirth: p.dateOfBirth,
    sexCode: p.sexCode,
    genderIdentity: p.genderIdentity,
    ethnicCategoryCode: p.ethnicCategoryCode,
    religion: p.religion,
    firstLanguage: p.firstLanguage,
    interpreterRequired: p.interpreterRequired,
    addressLine1: p.addressLine1,
    addressLine2: p.addressLine2,
    town: p.town,
    postcode: p.postcode,
    gpPracticeOdsCode: p.gpPracticeOdsCode,
    legalStatus: p.legalStatus,
    nationalDataOptOut: p.nationalDataOptOut,
    updatedAt: p.updatedAt.toISOString(),
    updatedBy: p.updatedBy,
    version: p.version,
  };
}

type ContactRow = typeof contact.$inferSelect;

function contactOut(row: ContactRow, today: string): ContactOut {
  return {
    id: row.id,
    personId: row.personId,
    role: row.role,
    givenName: row.givenName,
    familyName: row.familyName,
    relationship: row.relationship,
    phone: row.phone,
    email: row.email,
    addressLine1: row.addressLine1,
    town: row.town,
    postcode: row.postcode,
    isNextOfKin: row.isNextOfKin,
    authorityReference: row.authorityReference,
    authorityDocumentId: row.authorityDocumentId,
    validUntil: row.validUntil,
    authorityScope: row.authorityScope as ContactOut["authorityScope"],
    notes: row.notes,
    evidenceMissing:
      AUTHORITY_ROLES.has(row.role) && !row.authorityReference && !row.authorityDocumentId,
    expired: row.validUntil !== null && row.validUntil < today,
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}

/** Each field sent, trimmed; an empty text clears it. Undefined leaves the field as it is. */
function cleaned<T extends Record<string, unknown>>(body: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || key === "version") continue;
    out[key] = typeof value === "string" && value.trim() === "" ? null : value;
  }
  return out as Partial<T>;
}

/** A postcode sent is normalised, or refused in words. */
function postcodeOf(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value as null | undefined;
  const postcode = normalisePostcode(String(value));
  if (!postcode) throw problems.invalid("Enter a full UK postcode.");
  return postcode;
}

/**
 * The contact as it would be after a change, checked: a deputy says what their order covers, and
 * only a deputy has that; an end date is a real date.
 */
function checkContact(next: {
  readonly role: string;
  readonly authorityScope?: string | null | undefined;
}): void {
  if (next.role === "deputy" && !next.authorityScope) {
    throw problems.invalid("Say what the deputy's Court of Protection order covers.");
  }
  if (next.role !== "deputy" && next.authorityScope) {
    throw problems.invalid("Only a deputy has an order that covers welfare or property.");
  }
}

async function contactsOf(tx: Transaction, personId: string) {
  return tx
    .select()
    .from(contact)
    .where(and(eq(contact.personId, personId), isNull(contact.deletedAt)))
    .orderBy(asc(contact.familyName), asc(contact.givenName), asc(contact.id));
}

export const peopleDetailsRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/details",
      tags: ["people"],
      summary: "Personal details: demographics and the national data opt-out (PEOP-001)",
      security,
      request: { params: PersonParam },
      responses: {
        200: jsonBody(PersonDetails, "Personal details"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.person.read");
      const { id } = c.req.valid("param");
      const out = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id);
        await audit(c, tx, access, {
          action: "people.person.details_view",
          resourceType: "person",
          resourceId: id,
        });
        return detailsOut(p);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/v1/people/{id}/details",
      tags: ["people"],
      summary: "Change personal details or the national data opt-out (versioned)",
      description:
        "Only the fields sent change; null clears an optional one. The NHS number passes the modulus 11 check and is unique in the organisation: one already on the record of someone the caller can see is refused saying so; one on a record they cannot see is refused without saying whose, audited as denied (`nhs_number_in_use`, without the number), counted against an hourly limit per member, and a task asks the owner to look for a duplicate record. A person with no NHS number needs a local identifier; a date of birth is from 1900 to today; a postcode is a full UK postcode, stored upper case with one space; text with control characters is refused. Refused once the record is read-only (people.md rule 1). Audited with the names of the fields changed.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: UpdatePersonDetails } } },
      },
      responses: {
        200: jsonBody(PersonDetails, "Saved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
        429: jsonBody(z.object({ code: z.string() }), "Too many NHS numbers refused; wait"),
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.person.update");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const changes: Record<string, unknown> = cleaned(body);
      if (Object.keys(changes).length === 0) throw problems.invalid("Change at least one detail.");
      if (typeof changes.nhsNumber === "string") {
        const check = validateNhsNumber(changes.nhsNumber);
        if (!check.valid) {
          throw problems.invalid(
            check.problem === "not_ten_digits"
              ? "An NHS number has 10 digits."
              : "This is not a valid NHS number. Check each digit.",
          );
        }
        changes.nhsNumber = check.value;
      }
      if ("postcode" in changes) changes.postcode = postcodeOf(changes.postcode);
      if (typeof changes.dateOfBirth === "string" && changes.dateOfBirth > ukIsoDate(new Date())) {
        throw problems.invalid("A date of birth cannot be in the future.");
      }
      // An NHS number change is counted against the member's hourly limit before anything is
      // looked up, in its own committed transaction, so parallel requests cannot all pass a check
      // made before any of them was counted (#119 review round 2). The count is given back unless
      // the number turns out to be on a record the caller cannot see. If it cannot be counted, the
      // number is never looked up.
      const reservedAt = typeof changes.nhsNumber === "string" ? Date.now() : null;
      if (reservedAt !== null) {
        try {
          await ownView(c, access, (tx) =>
            NHS_IN_USE_REFUSALS.take(tx, access.tenantUserId, 1, reservedAt),
          );
        } catch (error) {
          if (error instanceof QuotaExceeded) throw error;
          throw new HttpProblem(503, "unavailable", "Try again in a moment.");
        }
      }
      // Set when the number is on a record the caller cannot see; acted on after the rollback.
      const refusal = { inUse: false, locationId: "" };
      const out = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id, true);
        requireVersion(p.version, body.version);
        requireWrite(p, "demographics");
        if (typeof changes.nhsNumber === "string" && changes.nhsNumber !== p.nhsNumber) {
          // Someone the caller can see (row-level security) already has it: say so plainly.
          const [holder] = await tx
            .select({ id: person.id })
            .from(person)
            .where(and(eq(person.nhsNumber, changes.nhsNumber), ne(person.id, id)));
          if (holder) throw problems.invalid(NHS_IN_USE_VISIBLE);
        }
        const nhs = "nhsNumber" in changes ? changes.nhsNumber : p.nhsNumber;
        const local = "localIdentifier" in changes ? changes.localIdentifier : p.localIdentifier;
        if (!nhs && !local) {
          throw problems.invalid("Give a local identifier when there is no NHS number.");
        }
        const changed = Object.keys(changes).filter(
          (key) => changes[key] !== (p as unknown as Record<string, unknown>)[key],
        );
        const [updated] = await tx
          .update(person)
          .set(changes)
          .where(and(eq(person.id, id), eq(person.version, body.version)))
          .returning({ id: person.id })
          .catch((error: unknown) => {
            // The unique key across the organisation: the number is on a record this member
            // cannot see. Never say whose or where (M1).
            if (dbCode(error) === "23505") {
              refusal.inUse = true;
              refusal.locationId = p.locationId;
              throw problems.invalid(NHS_NOT_SAVED);
            }
            return invalidOnDataException(error);
          });
        if (!updated) throw problems.conflict();
        await audit(c, tx, access, {
          action: "people.person.update",
          resourceType: "person",
          resourceId: id,
          scope: { fields: changed.sort() },
        });
        return detailsOut(await loadPerson(tx, id));
      })
        .catch(async (error: unknown) => {
          if (refusal.inUse) await afterNhsNumberInUse(c, access, id, refusal.locationId);
          throw error;
        })
        .finally(async () => {
          // Anything but a refusal on a record the caller cannot see gives the count back.
          if (reservedAt === null || refusal.inUse) return;
          try {
            await ownView(c, access, (tx) =>
              NHS_IN_USE_REFUSALS.release(tx, access.tenantUserId, reservedAt),
            );
          } catch {
            c.get("services").logger.error(
              { tenantId: access.tenantId, tenantUserId: access.tenantUserId, personId: id },
              "an NHS number change could not be given back to the hourly limit",
            );
          }
        });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/contacts",
      tags: ["people"],
      summary: "Key contacts and legal representatives, with their authority and end date",
      security,
      request: { params: PersonParam },
      responses: {
        200: jsonBody(ContactList, "Contacts"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.person.read");
      const { id } = c.req.valid("param");
      const today = ukIsoDate(new Date());
      const items = await withTenant(c, async (tx) => {
        await loadPerson(tx, id);
        const rows = await contactsOf(tx, id);
        await audit(c, tx, access, {
          action: "people.contact.list",
          resourceType: "person",
          resourceId: id,
          scope: { count: rows.length },
        });
        return rows.map((row) => contactOut(row, today));
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/contacts",
      tags: ["people"],
      summary: "Add a key contact or legal representative",
      description:
        "A deputy says what their order covers (personal welfare, property and affairs, or both). An attorney, deputy or appointee without a reference or evidence is saved, flagged as evidence missing: nothing is shared on their authority until one is recorded. Evidence is an available document already in this person's documents (category person_document). An end date is from 1900 to 2199; text with control characters is refused.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: CreateContact } } },
      },
      responses: {
        201: jsonBody(ContactOut, "Added"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.person.update");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const fields = cleaned(body);
      checkContact({ role: body.role, authorityScope: fields.authorityScope });
      const postcode = postcodeOf(fields.postcode);
      const today = ukIsoDate(new Date());
      const out = await withTenant(c, async (tx) => {
        // Locked, so a status change cannot slip in between the check and the write.
        const p = await loadPerson(tx, id, true);
        requireWrite(p, "contact");
        await requireOwnDocument(
          tx,
          id,
          fields.authorityDocumentId,
          "evidence of the authority",
          EVIDENCE_CATEGORIES,
        );
        const [row] = await tx
          .insert(contact)
          .values({
            personId: id,
            role: body.role,
            givenName: body.givenName,
            familyName: body.familyName,
            relationship: fields.relationship ?? null,
            phone: fields.phone ?? null,
            email: fields.email ?? null,
            addressLine1: fields.addressLine1 ?? null,
            town: fields.town ?? null,
            postcode: postcode ?? null,
            isNextOfKin: fields.isNextOfKin ?? false,
            authorityReference: fields.authorityReference ?? null,
            authorityDocumentId: fields.authorityDocumentId ?? null,
            validUntil: fields.validUntil ?? null,
            authorityScope: fields.authorityScope ?? null,
            notes: fields.notes ?? null,
          })
          .returning()
          .catch(invalidOnStore);
        if (!row) throw problems.conflict();
        await audit(c, tx, access, {
          action: "people.contact.create",
          resourceType: "contact",
          resourceId: row.id,
          scope: { role: row.role, evidenceRecorded: !contactOut(row, today).evidenceMissing },
        });
        return contactOut(row, today);
      });
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/v1/people/{id}/contacts/{contactId}",
      tags: ["people"],
      summary: "Change a contact or representative (versioned)",
      description:
        "Only the fields sent change; null clears an optional one. A change that takes away the authority a sharing decision rests on (the contact no longer holding that kind of authority, a deputy's order no longer of that kind, the last reference or evidence removed, or the authority now ending before the decision recorded) suspends that decision in the same transaction, audited with the reason `authority_changed` and publishing people.sharing.changed (HZ-022, fail closed); the answer says how many were suspended. Changing the email address of a family member with a portal account (which the account is matched by) needs `people.sharing.manage` and a fresh sign-in. Audited with the names of the fields changed.",
      security,
      request: {
        params: ContactParams,
        body: { content: { "application/json": { schema: UpdateContact } } },
      },
      responses: {
        200: jsonBody(ContactSaved, "Saved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.person.update");
      const { id, contactId } = c.req.valid("param");
      const body = c.req.valid("json");
      const changes: Record<string, unknown> = cleaned(body);
      if (Object.keys(changes).length === 0) throw problems.invalid("Change at least one detail.");
      if ("postcode" in changes) changes.postcode = postcodeOf(changes.postcode);
      const now = new Date();
      const today = ukIsoDate(now);
      const out = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          // Locked, so a status change cannot slip in between the check and the write.
          const p = await loadPerson(tx, id, true);
          requireWrite(p, "contact");
          const [row] = await tx
            .select()
            .from(contact)
            .where(and(eq(contact.id, contactId), isNull(contact.deletedAt)));
          if (row?.personId !== id) throw problems.notFound();
          requireVersion(row.version, body.version);
          checkContact({
            role: (changes.role as string | undefined) ?? row.role,
            authorityScope:
              "authorityScope" in changes
                ? (changes.authorityScope as string | null)
                : row.authorityScope,
          });
          await requireOwnDocument(
            tx,
            id,
            changes.authorityDocumentId as string | null | undefined,
            "evidence of the authority",
            EVIDENCE_CATEGORIES,
          );
          if ("email" in changes && changes.email !== row.email) {
            // A family member's portal account is matched to their contact by this address
            // (comms.md): changing it is a sharing decision in effect (#119 review L1).
            const [linked] = await tx
              .select({ id: familyPortalUser.id })
              .from(familyPortalUser)
              .where(
                and(
                  eq(familyPortalUser.contactId, contactId),
                  isNull(familyPortalUser.revokedAt),
                  isNull(familyPortalUser.deletedAt),
                ),
              );
            if (linked) {
              // Refused here, audited after the transaction has let go of its connection (S-L7).
              const refusedFor = (reason: string) => ({
                action: "people.contact.portal_email_change",
                outcome: "denied" as const,
                reason,
                resourceType: "contact",
                resourceId: contactId,
              });
              const reaching = await permissionsReaching(tx, access, id);
              if (!reaching.has("people.sharing.manage")) {
                throw new AuditedRefusal(
                  new HttpProblem(
                    403,
                    "missing_permission",
                    "You do not have access to this.",
                    "Only someone who manages sharing can change the email address of a family member who has a portal account.",
                  ),
                  refusedFor("missing_permission"),
                );
              }
              if (!stepUpFresh(c)) {
                throw new AuditedRefusal(stepUpRefusal(access), refusedFor("step_up_required"));
              }
            }
          }
          const changed = Object.keys(changes).filter(
            (key) => changes[key] !== (row as unknown as Record<string, unknown>)[key],
          );
          const [updated] = await tx
            .update(contact)
            .set(changes)
            .where(and(eq(contact.id, contactId), eq(contact.version, body.version)))
            .returning()
            .catch(invalidOnStore);
          if (!updated) throw problems.conflict();
          await audit(c, tx, access, {
            action: "people.contact.update",
            resourceType: "contact",
            resourceId: contactId,
            scope: { fields: changed.sort() },
          });
          const suspendedDecisions = await suspendDecisionsOnAuthority(
            c,
            tx,
            access,
            id,
            contactId,
            holderOf(row),
            holderOf(updated),
            now,
          );
          return { ...contactOut(updated, today), suspendedDecisions };
        }),
      );
      return c.json(out, 200);
    },
  );
