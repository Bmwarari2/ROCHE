import {
  ContactList,
  ContactOut,
  CreateContact,
  PersonDetails,
  UpdateContact,
  UpdatePersonDetails,
} from "@harbour/contracts";
import { contact, person, type Transaction } from "@harbour/db";
import { ukIsoDate, validateNhsNumber } from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, isNull } from "drizzle-orm";
import { requirePermission, withTenant } from "../http/context";
import { problems } from "../http/problem";
import { loadPerson, type PersonRow, requireVersion, requireWrite } from "../services/people";
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
  dbCode,
  invalidOnForeignKey,
  PersonParam,
  requireOwnDocument,
} from "./people-shared";

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
        "Only the fields sent change; null clears an optional one. The NHS number passes the modulus 11 check and is unique in the organisation; a person with no NHS number needs a local identifier; a date of birth is not in the future; a postcode is a full UK postcode, stored upper case with one space. Refused once the record is read-only (people.md rule 1). Audited with the names of the fields changed.",
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
      const out = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id, true);
        requireVersion(p.version, body.version);
        requireWrite(p, "demographics");
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
            if (dbCode(error) === "23505") {
              throw problems.invalid(
                "This NHS number is already recorded for someone else in this organisation. Check it.",
              );
            }
            throw error;
          });
        if (!updated) throw problems.conflict();
        await audit(c, tx, access, {
          action: "people.person.update",
          resourceType: "person",
          resourceId: id,
          scope: { fields: changed.sort() },
        });
        return detailsOut(await loadPerson(tx, id));
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
        "A deputy says what their order covers (personal welfare, property and affairs, or both). An attorney, deputy or appointee without a reference or evidence is saved, flagged as evidence missing: nothing is shared on their authority until one is recorded. Evidence is a document already in this person's documents.",
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
        const p = await loadPerson(tx, id);
        requireWrite(p, "contact");
        await requireOwnDocument(tx, id, fields.authorityDocumentId, "evidence of the authority");
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
          .catch(invalidOnForeignKey("evidence document"));
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
        "Only the fields sent change; null clears an optional one. A sharing decision that rests on this contact's authority checks it again every time, so an end date or a removed reference closes what it opened (people.md rule 13). Audited with the names of the fields changed.",
      security,
      request: {
        params: ContactParams,
        body: { content: { "application/json": { schema: UpdateContact } } },
      },
      responses: {
        200: jsonBody(ContactOut, "Saved"),
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
      const today = ukIsoDate(new Date());
      const out = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id);
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
        );
        const changed = Object.keys(changes).filter(
          (key) => changes[key] !== (row as unknown as Record<string, unknown>)[key],
        );
        const [updated] = await tx
          .update(contact)
          .set(changes)
          .where(and(eq(contact.id, contactId), eq(contact.version, body.version)))
          .returning()
          .catch(invalidOnForeignKey("evidence document"));
        if (!updated) throw problems.conflict();
        await audit(c, tx, access, {
          action: "people.contact.update",
          resourceType: "contact",
          resourceId: contactId,
          scope: { fields: changed.sort() },
        });
        return contactOut(updated, today);
      });
      return c.json(out, 200);
    },
  );
