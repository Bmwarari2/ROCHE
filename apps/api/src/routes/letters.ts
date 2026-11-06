import { createHash } from "node:crypto";
import { LetterList, LetterPreview, LetterRequest, SendLetter } from "@harbour/contracts";
import {
  contact,
  incident,
  letter,
  letterTemplate,
  letterTemplateVersion,
  person,
  type Transaction,
} from "@harbour/db";
import {
  checkTemplateDefinition,
  MERGE_FIELDS,
  type MergeFieldKey,
  type RenderedTemplate,
  renderTemplate,
  toUkWallClock,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, gte, isNull, or } from "drizzle-orm";
import type { Context } from "hono";
import { AuditedRefusal, withAuditedRefusal } from "../http/audit";
import {
  type AppEnv,
  requirePermission,
  type TenantAccess,
  usablePermissions,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { publish } from "../outbox";
import { destroyingOnFailure, storeDocument } from "../services/documents";
import {
  letterBlocks,
  letterValues,
  type PersonRow,
  SENDER_TYPED_FIELDS,
} from "../services/letters";
import { renderPdf } from "../services/pdf";
import { domainVersion } from "./letter-templates";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { audit } from "./people-shared";

/**
 * Letters and emails from approved templates (comms.md rules 24 and 25 and section 5; COMMS-007;
 * ADR-0051; hazard HZ-051). `comms.letter.manage` in the person's scope, with MFA (a letter holds
 * the person's details); an incident follow-up also needs `safety.incident.manage`. Values come from
 * the record, except the admission and fee details the sender types. Preview stores nothing and
 * shows who the letter is about; send must match the preview exactly (the version and a hash of the
 * text) and stores the letter row (field keys only) and a posted letter's PDF as a document about
 * the person. Sending email waits for the worker-based send (STATUS; HZ-051); duty of candour
 * letters wait for the candour record's relevant person.
 */

const MANAGE = "comms.letter.manage";
const INCIDENTS = "safety.incident.manage";
const A = {
  previewed: "comms.letter.previewed",
  sent: "comms.letter.sent",
  listed: "comms.letter.listed",
} as const;

type Request = z.infer<typeof LetterRequest>;

const refused = (problem: HttpProblem, action: string, personId: string, reason: string) =>
  new AuditedRefusal(problem, {
    action,
    outcome: "denied",
    resourceType: "person",
    resourceId: personId,
    reason,
  });

/** The permissions a letter needs, MFA included (a care record is read). */
async function letterAccess(c: Context<AppEnv>, body: Request | null): Promise<TenantAccess> {
  const access = await requirePermission(c, MANAGE);
  if (!access.mfaSatisfied) throw problems.mfaRequired();
  // An incident's details are special category data: its own permission, in its own scope too.
  if (body?.incidentId) return requirePermission(c, INCIDENTS);
  return access;
}

const ukToday = () => {
  const w = toUkWallClock(new Date());
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
};

/** What the sender confirmed: the subject and text exactly as previewed (SHA-256, hex). */
const textHash = (rendered: RenderedTemplate) =>
  createHash("sha256")
    .update(`${rendered.subject ?? ""}\n${rendered.text}`, "utf8")
    .digest("hex");

interface Made {
  readonly rendered: RenderedTemplate;
  readonly versionId: string;
  /** A letter's letterhead and window-envelope address (H-228); null for an email. */
  readonly blocks: { readonly letterhead: string[]; readonly address: string[] } | null;
  readonly person: PersonRow;
  readonly recipientName: string;
  readonly contactId: string | null;
}

/** Renders the letter in the caller's scope, or refuses with the reason (nothing is written). */
async function make(
  tx: Transaction,
  access: TenantAccess,
  action: string,
  personId: string,
  body: Request,
): Promise<Made> {
  const refuse = (problem: HttpProblem, reason: string) =>
    refused(problem, action, personId, reason);
  const [subject] = await tx.select().from(person).where(eq(person.id, personId));
  if (!subject) throw refuse(problems.notFound(), "not_found_or_out_of_scope");
  // No template kind is written for after a death yet; candour, which is, is refused below.
  if (subject.status === "deceased") {
    throw refuse(
      problems.invalid("This person has died. Letters about them are not made here."),
      "person_deceased",
    );
  }
  const [template] = await tx
    .select()
    .from(letterTemplate)
    .where(eq(letterTemplate.id, body.templateId));
  const [version] = template?.currentVersionId
    ? await tx
        .select()
        .from(letterTemplateVersion)
        .where(eq(letterTemplateVersion.id, template.currentVersionId))
    : [];
  if (!template || !version) {
    throw refuse(
      new HttpProblem(409, "template_not_in_use", "This template has no approved version in use."),
      "template_not_in_use",
    );
  }
  if (template.kind === "duty_of_candour") {
    throw refuse(
      problems.invalid(
        "Duty of candour letters are not made here yet: the candour record must name the relevant person first.",
      ),
      "candour_not_supported",
    );
  }
  const domain = domainVersion(template, version);
  const fields = checkTemplateDefinition(domain).fields;
  const namesIncident = fields.some((f) => f.startsWith("incident."));
  if (namesIncident !== Boolean(body.incidentId)) {
    throw refuse(
      problems.invalid(
        namesIncident
          ? "Choose the incident this letter is about."
          : "This template is not about an incident.",
      ),
      namesIncident ? "incident_required" : "incident_not_used",
    );
  }
  if (body.incidentId) {
    const [found] = await tx
      .select({ people: incident.personIds })
      .from(incident)
      .where(and(eq(incident.id, body.incidentId), isNull(incident.deletedAt)));
    if (!found) throw refuse(problems.notFound(), "incident_not_found");
    // Its free-text account may name everyone involved: a shared incident's letter would carry
    // another resident's details (#72 review, HZ-051). A family-facing summary is a follow-up.
    if (found.people.length > 1) {
      throw refuse(
        problems.invalid(
          "This incident involves more than one person, so its account cannot go in a letter about one of them.",
        ),
        "incident_involves_others",
      );
    }
    if (found.people[0] !== personId) {
      throw refuse(
        problems.invalid("This incident is not about this person."),
        "incident_wrong_person",
      );
    }
  }
  const typed = body.values ?? {};
  const notTyped = Object.keys(typed).filter((k) => !SENDER_TYPED_FIELDS.has(k));
  if (notTyped.length > 0) {
    throw refuse(
      problems.invalid(
        `These details come from the record and cannot be typed: ${notTyped.join(", ")}.`,
      ),
      "value_not_typed",
    );
  }
  let recipient: typeof contact.$inferSelect | null = null;
  if (body.recipient.kind === "contact") {
    // A current contact of this person only: not removed, and not past their authority's end.
    const [found] = await tx
      .select()
      .from(contact)
      .where(
        and(
          eq(contact.id, body.recipient.contactId),
          eq(contact.personId, personId),
          isNull(contact.deletedAt),
          or(isNull(contact.validUntil), gte(contact.validUntil, ukToday())),
        ),
      );
    recipient = found ?? null;
    if (!recipient) throw refuse(problems.notFound(), "contact_not_found");
  }
  const values = await letterValues(
    tx,
    {
      tenantId: access.tenantId,
      senderId: access.tenantUserId,
      person: subject,
      contact: recipient,
      incidentId: body.incidentId ?? null,
      typed,
    },
    fields,
  );
  const result = renderTemplate(domain, { subjectPersonId: personId, values });
  if (!result.ok) {
    throw refuse(
      problems.invalid(result.problems.map((p) => p.message).join(" ")),
      result.problems.map((p) => p.problem).join(","),
    );
  }
  // ADR-0051 again on what was rendered (#70 review): an email carries no health details and no
  // identifier, whatever the values turned out to be.
  const rendered = result.rendered;
  const identifiers = rendered.fieldsUsed.filter((f) => MERGE_FIELDS[f].notInEmail);
  if (
    rendered.channel === "email" &&
    (rendered.containsSpecialCategory || identifiers.length > 0)
  ) {
    throw refuse(
      problems.invalid(
        "This email would carry health details or an identifier. Send it as a letter.",
      ),
      "special_category_in_email",
    );
  }
  return {
    rendered,
    versionId: version.id,
    // The letterhead and the window-envelope address for a posted letter (H-228).
    blocks:
      rendered.channel === "email"
        ? null
        : await letterBlocks(tx, {
            tenantId: access.tenantId,
            person: subject,
            contact: recipient,
          }),
    person: subject,
    recipientName: recipient
      ? `${recipient.givenName} ${recipient.familyName}`
      : `${subject.givenName} ${subject.familyName}`,
    contactId: recipient?.id ?? null,
  };
}

const keys = (fields: readonly MergeFieldKey[]) => [...fields].sort();

const PersonParam = z.object({ id: z.uuid() });

export const lettersRouter = createRouter()
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/letters/preview",
      tags: ["comms"],
      summary: "Preview a letter or email (nothing is stored)",
      description:
        "comms.letter.manage in the person's scope, with MFA; safety.incident.manage too for an incident letter. Renders the template's version in use with the person's details and shows who it is about (name, room, photo) and the personal-data fields, for the check before sending (rule 25). Returns the version and a hash of the text, which the send must repeat. Refusals say what is missing. Audited with field keys only.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: LetterRequest } } },
      },
      responses: {
        200: jsonBody(LetterPreview, "The letter as it would be sent"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const access = await letterAccess(c, body);
      const made = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          const out = await make(tx, access, A.previewed, id, body);
          await audit(c, tx, access, {
            action: A.previewed,
            resourceType: "person",
            resourceId: id,
            scope: {
              templateVersionId: out.versionId,
              fields: keys(out.rendered.personalDataFields),
            },
          });
          return out;
        }),
      );
      const p = made.person;
      return c.json(
        {
          templateVersionId: made.versionId,
          textHash: textHash(made.rendered),
          person: {
            id: p.id,
            fullName: `${p.givenName} ${p.familyName}`,
            preferredName: p.preferredName,
            roomLabel: p.roomLabel,
            photoUrl: p.photoDocumentId ? `/v1/people/${p.id}/photo` : null,
            sample: p.isSample,
          },
          channel: made.rendered.channel,
          subject: made.rendered.subject,
          text: made.rendered.text,
          recipientName: made.recipientName,
          personalDataFields: keys(made.rendered.personalDataFields),
          containsSpecialCategory: made.rendered.containsSpecialCategory,
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/letters",
      tags: ["comms"],
      summary: "Send a letter",
      description:
        "As the preview, with the preview's version and text hash: a letter that would differ from what was confirmed is refused (409). A letter is rendered to PDF through the pack PDF writer (values as text, never markup) and stored as a document about the person. Email is refused (422, email_sending_not_available) until the worker-based send exists. The letter row holds the template version, recipient and field keys, never the content. Audited; outbox comms.letter.sent.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: SendLetter } } },
      },
      responses: {
        201: jsonBody(z.object({ id: z.uuid() }), "Sent"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const access = await letterAccess(c, body);
      const services = c.get("services");
      const letterId = await withAuditedRefusal(c, access, () =>
        destroyingOnFailure(services.storage, (storage) =>
          withTenant(c, async (tx) => {
            const made = await make(tx, access, A.sent, id, body);
            if (
              made.versionId !== body.templateVersionId ||
              textHash(made.rendered) !== body.textHash
            ) {
              throw refused(
                new HttpProblem(
                  409,
                  "letter_changed",
                  "The letter has changed since you checked it. Preview it again.",
                ),
                A.sent,
                id,
                "preview_changed",
              );
            }
            // A send then record across two steps could send twice or leave one unrecorded: email
            // waits for the worker-based send (STATUS; HZ-051).
            if (made.rendered.channel === "email") {
              throw refused(
                problems.invalid("Sending email is not available yet. Send it as a letter."),
                A.sent,
                id,
                "email_sending_not_available",
              );
            }
            // A letter about an invented sample person says so on the page, so it is never posted
            // or filed as real (HZ-072); the previewed text below it is unchanged.
            const sampleLines = made.person.isSample
              ? [
                  {
                    text: "Sample letter: about an invented person for practice. Do not send.",
                    bold: true,
                  },
                  { text: "" },
                ]
              : [];
            const bytes = renderPdf({
              title: "Letter",
              lines: [...sampleLines, ...made.rendered.text.split("\n").map((text) => ({ text }))],
              footer: (n, total) => `Page ${n} of ${total}.`,
              ...(made.blocks ? { letter: made.blocks } : {}),
            });
            const doc = await storeDocument(
              tx,
              { storage, scanner: services.scanner },
              access.tenantId,
              {
                bytes,
                declaredType: "application/pdf",
                category: "person_document",
                title: "Letter",
                fileName: "letter.pdf",
                personId: id,
                subjectType: "letter",
              },
            );
            const [row] = await tx
              .insert(letter)
              .values({
                templateVersionId: made.versionId,
                personId: id,
                recipientKind: made.contactId ? "contact" : "person",
                contactId: made.contactId,
                channel: made.rendered.channel,
                personalFields: keys(made.rendered.personalDataFields),
                specialCategory: made.rendered.containsSpecialCategory,
                resultsToFollow: made.rendered.resultsToFollow,
                incidentId: body.incidentId ?? null,
                documentId: doc.id,
                sentBy: access.tenantUserId,
                retentionClass: "care_record",
              })
              .returning({ id: letter.id });
            if (!row) throw new Error("letter not stored");
            await audit(c, tx, access, {
              action: A.sent,
              resourceType: "letter",
              resourceId: row.id,
              scope: {
                personId: id,
                templateVersionId: made.versionId,
                channel: made.rendered.channel,
                recipient: made.contactId ? "contact" : "person",
                fields: keys(made.rendered.personalDataFields),
              },
            });
            await publish(tx, {
              context: "comms",
              aggregateType: "letter",
              aggregateId: row.id,
              type: "comms.letter.sent",
              payload: {
                letterId: row.id,
                personId: id,
                templateVersionId: made.versionId,
                incidentId: body.incidentId ?? null,
                resultsToFollow: made.rendered.resultsToFollow,
              },
            });
            return row.id;
          }),
        ),
      );
      return c.json({ id: letterId }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/letters",
      tags: ["comms"],
      summary: "The letters sent about a person",
      description:
        "comms.letter.manage in the person's scope, with MFA (#69 review: reading letters needs a comms permission, not only the person in scope). Template version, recipient, channel and the field keys used; never the content (a letter's PDF is its document). The incident is shown only to holders of safety.incident.manage. Audited.",
      security,
      request: { params: PersonParam },
      responses: {
        200: jsonBody(LetterList, "Letters, newest first"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const access = await letterAccess(c, null);
      const seesIncidents = usablePermissions(access).has(INCIDENTS);
      const rows = await withTenant(c, async (tx) => {
        const [found] = await tx.select({ id: person.id }).from(person).where(eq(person.id, id));
        if (!found) return null;
        await audit(c, tx, access, { action: A.listed, resourceType: "person", resourceId: id });
        return tx.select().from(letter).where(eq(letter.personId, id)).orderBy(desc(letter.sentAt));
      });
      if (!rows) throw problems.notFound();
      return c.json(
        {
          items: rows.map((r) => ({
            id: r.id,
            templateVersionId: r.templateVersionId,
            channel: r.channel as "letter" | "email",
            recipientKind: r.recipientKind as "person" | "contact",
            contactId: r.contactId,
            personalFields: r.personalFields,
            specialCategory: r.specialCategory,
            incidentId: seesIncidents ? r.incidentId : null,
            documentId: r.documentId,
            sentBy: r.sentBy,
            sentAt: r.sentAt.toISOString(),
          })),
        },
        200,
      );
    },
  );
