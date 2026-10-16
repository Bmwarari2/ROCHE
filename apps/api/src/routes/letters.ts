import { LetterList, LetterPreview, LetterRequest, SendLetter } from "@harbour/contracts";
import {
  contact,
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
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import type { Context } from "hono";
import { AuditedRefusal, withAuditedRefusal } from "../http/audit";
import { type AppEnv, requirePermission, type TenantAccess, withTenant } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { publish } from "../outbox";
import { destroyingOnFailure, storeDocument } from "../services/documents";
import { letterValues, SENDER_TYPED_FIELDS } from "../services/letters";
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
 * the record, except the admission and fee details the sender types. Preview stores nothing; send
 * stores the letter row (field keys, never an email's content), the rendered PDF for a letter as a
 * document about the person, or the provider's message id for an email. Duty of candour letters
 * wait for the candour record's relevant person (STATUS).
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

interface Made {
  readonly rendered: RenderedTemplate;
  readonly versionId: string;
  readonly recipientName: string;
  readonly recipientEmail: string | null;
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
  const [subject] = await tx.select().from(person).where(eq(person.id, personId));
  if (!subject) throw refused(problems.notFound(), action, personId, "not_found_or_out_of_scope");
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
    throw refused(
      new HttpProblem(409, "template_not_in_use", "This template has no approved version in use."),
      action,
      personId,
      "template_not_in_use",
    );
  }
  if (template.kind === "duty_of_candour") {
    throw refused(
      problems.invalid(
        "Duty of candour letters are not made here yet: the candour record must name the relevant person first.",
      ),
      action,
      personId,
      "candour_not_supported",
    );
  }
  const domain = domainVersion(template, version);
  const fields = checkTemplateDefinition(domain).fields;
  const namesIncident = fields.some((f) => f.startsWith("incident."));
  if (namesIncident !== Boolean(body.incidentId)) {
    throw refused(
      problems.invalid(
        namesIncident
          ? "Choose the incident this letter is about."
          : "This template is not about an incident.",
      ),
      action,
      personId,
      namesIncident ? "incident_required" : "incident_not_used",
    );
  }
  const typed = body.values ?? {};
  const notTyped = Object.keys(typed).filter((k) => !SENDER_TYPED_FIELDS.has(k));
  if (notTyped.length > 0) {
    throw refused(
      problems.invalid(
        `These details come from the record and cannot be typed: ${notTyped.join(", ")}.`,
      ),
      action,
      personId,
      "value_not_typed",
    );
  }
  let recipient: typeof contact.$inferSelect | null = null;
  if (body.recipient.kind === "contact") {
    const contactId = body.recipient.contactId;
    const [found] = await tx
      .select()
      .from(contact)
      .where(and(eq(contact.id, contactId), eq(contact.personId, personId)));
    recipient = found ?? null;
    if (!recipient) throw refused(problems.notFound(), action, personId, "contact_not_found");
  }
  const values = await letterValues(
    tx,
    {
      tenantId: access.tenantId,
      senderId: access.tenantUserId,
      person: subject,
      contact: recipient ?? null,
      incidentId: body.incidentId ?? null,
      typed,
    },
    fields,
  );
  const result = renderTemplate(domain, { subjectPersonId: personId, values });
  if (!result.ok) {
    throw refused(
      problems.invalid(result.problems.map((p) => p.message).join(" ")),
      action,
      personId,
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
    throw refused(
      problems.invalid(
        "This email would carry health details or an identifier. Send it as a letter.",
      ),
      action,
      personId,
      "special_category_in_email",
    );
  }
  const recipientName = recipient
    ? `${recipient.givenName} ${recipient.familyName}`
    : `${subject.givenName} ${subject.familyName}`;
  return {
    rendered,
    versionId: version.id,
    recipientName,
    recipientEmail: recipient ? recipient.email : null,
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
        "comms.letter.manage in the person's scope, with MFA; safety.incident.manage too for an incident letter. Renders the template's version in use with the person's details and lists the personal-data fields, for the check before sending (rule 25). Refusals say what is missing. Audited with field keys only.",
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
      return c.json(
        {
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
      summary: "Send a letter or email",
      description:
        "As the preview, once the sender has confirmed it. A letter is rendered to PDF through the pack PDF writer (values as text, never markup) and stored as a document about the person; an email goes through the organisation's email provider to the contact's address and only the provider's message id is kept. The letter row holds the template version, recipient and field keys, never the content. Audited; outbox comms.letter.sent.",
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
      // An email is sent once rendered, then recorded; a letter's document and row in one go.
      const emailed = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          const made = await make(tx, access, A.sent, id, body);
          if (made.rendered.channel !== "email") return { made, providerId: null };
          if (!made.recipientEmail) {
            throw refused(
              problems.invalid("Choose a contact with an email address."),
              A.sent,
              id,
              "no_email_address",
            );
          }
          const adapter = await services.adapterFor(access.tenantId, "email", tx);
          const result = await adapter.send({
            idempotencyKey: c.get("requestId"),
            title: made.rendered.subject ?? "",
            link: null,
            to: made.recipientEmail,
            body: made.rendered.text,
          });
          if (!result.ok) {
            throw refused(
              new HttpProblem(
                502,
                "email_not_sent",
                "The email could not be sent. Try again later.",
              ),
              A.sent,
              id,
              result.retryable ? "email_retryable" : "email_failed",
            );
          }
          return { made, providerId: result.providerMessageId };
        }),
      );
      const letterId = await withAuditedRefusal(c, access, () =>
        destroyingOnFailure(services.storage, (storage) =>
          withTenant(c, async (tx) => {
            const { made, providerId } = emailed;
            let documentId: string | null = null;
            if (made.rendered.channel === "letter") {
              const bytes = renderPdf({
                title: "Letter",
                lines: made.rendered.text.split("\n").map((text) => ({ text })),
                footer: (n, total) => `Page ${n} of ${total}.`,
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
              documentId = doc.id;
            }
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
                documentId,
                deliveryReference: providerId,
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
      summary: "The letters and emails sent about a person",
      description:
        "comms.letter.manage in the person's scope, with MFA (#69 review: reading letters needs a comms permission, not only the person in scope). Template version, recipient, channel and the field keys used; never the content (a letter's PDF is its document). Audited.",
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
            incidentId: r.incidentId,
            documentId: r.documentId,
            sentBy: r.sentBy,
            sentAt: r.sentAt.toISOString(),
          })),
        },
        200,
      );
    },
  );
