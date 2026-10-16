import {
  AddEvidenceItems,
  ComposeEvidencePack,
  EndEvidencePack,
  EvidencePackDetail,
  EvidencePackLinkIssued,
  EvidencePackList,
  RedactEvidenceField,
  ReissueEvidencePackLink,
  ReleaseEvidencePack,
} from "@harbour/contracts";
import {
  evidencePack,
  evidencePackItem,
  evidencePackLink,
  location,
  person,
  type Transaction,
} from "@harbour/db";
import {
  checkEvidencePackLinkReissue,
  checkEvidencePackRelease,
  checkEvidencePackRequest,
  composeEvidencePack,
  EVIDENCE_PACK_RELEASE_MESSAGES,
  EVIDENCE_PACK_REQUEST_MESSAGES,
  EVIDENCE_REDACTION_TEXT,
  type EvidenceItem,
  type EvidencePackField,
  type EvidencePackReleaseProblem,
  evidencePackWatermark,
  formatUkDateTimeWithZone,
  normaliseEmail,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { AuditedRefusal, withAuditedRefusal, writeAudit } from "../http/audit";
import {
  type AppEnv,
  requireAnyPermission,
  requirePermission,
  type TenantAccess,
  usablePermissions,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import {
  BUNDLE_DELETED,
  type BundleContent,
  bundleOf,
  contributorsOf,
  currentItems,
  deleteBundle,
  type EvidencePackRow,
  evidencePackPolicy,
  loadEvidenceRecord,
  newEvidenceLinkToken,
  packDetail,
  packRequest,
  packSummary,
  publishPackEvent,
  type StoredField,
  writeBundle,
} from "../services/evidence-pack";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { audit, dbCode } from "./people-shared";

/**
 * Inspector evidence packs inside the provider (quality.md section 5; QUAL-003; ADR-0050; hazard
 * HZ-050): compose a draft from a request, add records to it (minimised and redacted by the
 * domain's rules, read in the composer's own scope), redact free text by hand, release it with its
 * link (step-up, by someone who did not shape it), issue a new link, revoke it or discard it. The
 * database enforces the same workflow and separation of duties (migration 0057); its refusals map
 * to 403 and 409. Opening a pack by its link is part 2b (`/p/evidence`).
 */

const COMPOSE = "quality.evidence_pack.compose";
const RELEASE = "quality.evidence_pack.release";
const A = {
  composed: "quality.evidence_pack.composed",
  viewed: "quality.evidence_pack.viewed",
  itemsAdded: "quality.evidence_pack.items_added",
  redacted: "quality.evidence_pack.redacted",
  released: "quality.evidence_pack.released",
  reissued: "quality.evidence_pack.link_reissued",
  revoked: "quality.evidence_pack.revoked",
  discarded: "quality.evidence_pack.discarded",
} as const;

const IdParam = z.object({ id: z.uuid() });

/** A refusal decided in the transaction, audited after it ends (`withAuditedRefusal`). */
const refused = (problem: HttpProblem, action: string, packId: string, reason: string) =>
  new AuditedRefusal(problem, {
    action,
    outcome: "denied",
    resourceType: "evidence_pack",
    resourceId: packId,
    reason,
  });

const stateConflict = (detail: string) => new HttpProblem(409, "invalid_state", detail);

/**
 * Runs a pack change: refusals decided in it are audited, and the database's own refusals
 * (separation of duties, the workflow, scope) become 403 or 409, audited too.
 */
async function change<T>(
  c: Context<AppEnv>,
  access: TenantAccess,
  action: string,
  packId: string | null,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  try {
    return await withAuditedRefusal(c, access, () => withTenant(c, fn));
  } catch (error) {
    const code = dbCode(error);
    if (code !== "42501" && code !== "23000" && code !== "23514") throw error;
    await writeAudit(c.get("services").appPool, access, {
      action,
      outcome: "denied",
      resourceType: "evidence_pack",
      ...(packId ? { resourceId: packId } : {}),
      reason: code === "42501" ? "refused_by_database" : "invalid_state",
      requestId: c.get("requestId"),
    });
    throw code === "42501"
      ? problems.forbidden()
      : stateConflict("The pack cannot be changed like that now. Reload it and try again.");
  }
}

async function findPack(tx: Transaction, id: string): Promise<EvidencePackRow | null> {
  const [row] = await tx.select().from(evidencePack).where(eq(evidencePack.id, id));
  return row ?? null;
}

/** The pack, or a refusal: not found (out of scope reads the same), stale, or not a draft. */
async function packFor(
  tx: Transaction,
  action: string,
  id: string,
  expect: { version?: number; state?: EvidencePackRow["state"] },
): Promise<EvidencePackRow> {
  const row = await findPack(tx, id);
  if (!row) throw refused(problems.notFound(), action, id, "not_found_or_out_of_scope");
  if (expect.version !== undefined && row.version !== expect.version) {
    throw refused(problems.conflict(), action, id, "version_conflict");
  }
  if (expect.state !== undefined && row.state !== expect.state) {
    const detail =
      expect.state === "draft"
        ? "Only a draft pack can be changed. Compose a new pack instead."
        : "Only a released pack can do this.";
    throw refused(stateConflict(detail), action, id, `not_${expect.state}`);
  }
  return row;
}

/** The fields as the database keeps them: outcomes and reasons, never the values. */
const stored = (fields: readonly EvidencePackField[]): StoredField[] =>
  fields.map((f) => ({
    key: f.key,
    label: f.label,
    kind: f.kind,
    outcome: f.outcome,
    ...(f.reason ? { reason: f.reason } : {}),
    ...(f.redactedBy ? { redactedBy: f.redactedBy } : {}),
  }));

/** The values the pack shows for one item (never a withheld one). */
const shown = (fields: readonly EvidencePackField[]): Record<string, string> =>
  Object.fromEntries(
    fields.filter((f) => f.value !== null).map((f) => [f.key, f.value as string] as const),
  );

const releaseProblem = (problems_: readonly EvidencePackReleaseProblem[]): HttpProblem => {
  const detail = problems_.map((p) => EVIDENCE_PACK_RELEASE_MESSAGES[p]).join(" ");
  if (
    problems_.includes("contributor_cannot_release") ||
    problems_.includes("missing_permission")
  ) {
    return new HttpProblem(403, "separation_of_duties", "You cannot release this pack.", detail);
  }
  if (problems_.includes("expiry_in_past") || problems_.includes("expiry_beyond_maximum")) {
    return problems.invalid(detail);
  }
  return stateConflict(detail);
};

export const evidencePacksRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/evidence-packs",
      tags: ["quality"],
      summary: "Evidence packs you can see",
      description:
        "Holders of quality.evidence_pack.compose or .release, for packs at locations where they hold one of them and whose people they can all see. Newest first.",
      security,
      responses: { 200: jsonBody(EvidencePackList, "Evidence packs"), ...errorResponses },
    }),
    async (c) => {
      await requireAnyPermission(c, [COMPOSE, RELEASE]);
      const rows = await withTenant(c, (tx) =>
        tx.select().from(evidencePack).orderBy(desc(evidencePack.composedAt)).limit(200),
      );
      return c.json({ items: rows.map(packSummary) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/evidence-packs",
      tags: ["quality"],
      summary: "Compose a draft evidence pack",
      description:
        "quality.evidence_pack.compose at every location asked for, seeing every person in scope (rule 1). The request is fixed once composed; the watermark names the recipient, purpose, time and pack. Audited.",
      security,
      request: { body: { content: { "application/json": { schema: ComposeEvidencePack } } } },
      responses: {
        201: jsonBody(EvidencePackDetail, "Composed"),
        ...errorResponses,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, COMPOSE);
      const body = c.req.valid("json");
      const locationIds = [...new Set(body.locationIds)];
      const personIds = [...new Set(body.personIds)];
      const problemsFound = checkEvidencePackRequest({
        packId: "",
        recipient: body.recipient,
        purpose: body.purpose,
        from: body.from,
        to: body.to,
        locationIds,
        qualityStatementIds: body.qualityStatementIds,
        peopleInScope: personIds,
        staffNames: body.staffNames,
        composedBy: access.tenantUserId,
        composedAt: new Date(),
      });
      if (problemsFound.length > 0) {
        throw problems.invalid(
          problemsFound.map((p) => EVIDENCE_PACK_REQUEST_MESSAGES[p]).join(" "),
        );
      }
      const detail = await change(c, access, A.composed, null, async (tx) => {
        // Everyone in scope must be someone the composer can see; every location must exist.
        const seen = await tx
          .select({ id: person.id })
          .from(person)
          .where(inArray(person.id, personIds));
        const places = await tx
          .select({ id: location.id })
          .from(location)
          .where(inArray(location.id, locationIds));
        if (seen.length !== personIds.length || places.length !== locationIds.length) {
          throw new AuditedRefusal(problems.invalid("A person or location was not found."), {
            action: A.composed,
            outcome: "denied",
            resourceType: "evidence_pack",
            reason: "not_found_or_out_of_scope",
          });
        }
        const { rows } = await tx.execute<{ id: string; now: Date }>(
          sql`SELECT app.uuid_v7() AS id, now() AS now`,
        );
        const { id, now } = rows[0] as { id: string; now: Date };
        await tx.insert(evidencePack).values({
          id,
          recipientName: body.recipient.name,
          recipientOrganisation: body.recipient.organisation,
          recipientEmail: normaliseEmail(body.recipient.email),
          purpose: body.purpose,
          dateFrom: body.from,
          dateTo: body.to,
          locationIds,
          qualityStatementIds: body.qualityStatementIds,
          personIds,
          staffNames: body.staffNames,
          composedBy: access.tenantUserId,
          watermark: evidencePackWatermark({
            packId: id,
            recipient: body.recipient,
            purpose: body.purpose,
            generatedAt: new Date(now),
          }),
        });
        await audit(c, tx, access, {
          action: A.composed,
          resourceType: "evidence_pack",
          resourceId: id,
          scope: { locationIds, people: personIds.length, staffNames: body.staffNames },
        });
        return packDetail(tx, (await findPack(tx, id)) as EvidencePackRow);
      });
      return c.json(detail, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/evidence-packs/{id}",
      tags: ["quality"],
      summary: "An evidence pack's manifest",
      description:
        "The request, the current items with every field's outcome and reason (and the value the pack shows, while the bundle exists), the excluded items and why, the contributors and the links. Never a token or code. Audited as a view.",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(EvidencePackDetail, "The manifest"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [COMPOSE, RELEASE]);
      const { id } = c.req.valid("param");
      const detail = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          const row = await packFor(tx, A.viewed, id, {});
          await audit(c, tx, access, {
            action: A.viewed,
            resourceType: "evidence_pack",
            resourceId: id,
          });
          return packDetail(tx, row);
        }),
      );
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/evidence-packs/{id}/items",
      tags: ["quality"],
      summary: "Add records to a draft pack",
      description:
        "quality.evidence_pack.compose. Each record is read in your own scope (one you cannot see reads as not found), tagged with the statements given, then kept or left out with its reason (rule 2) and minimised field by field (rule 3). Only the values the pack shows are kept, in the bundle. A member other than the composer becomes an editor, so cannot release it. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: AddEvidenceItems } } },
      },
      responses: {
        200: jsonBody(EvidencePackDetail, "Added"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, COMPOSE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const detail = await change(c, access, A.itemsAdded, id, async (tx) => {
        const row = await packFor(tx, A.itemsAdded, id, { version: body.version, state: "draft" });
        const present = new Set(
          (await currentItems(tx, id)).map((i) => `${i.recordType}:${i.recordId}`),
        );
        const loaded: EvidenceItem[] = [];
        for (const wanted of body.items) {
          const key = `${wanted.recordType}:${wanted.recordId}`;
          if (present.has(key)) {
            throw refused(
              stateConflict("A record is already in this pack."),
              A.itemsAdded,
              id,
              "already_in_pack",
            );
          }
          present.add(key);
          const found = await loadEvidenceRecord(
            tx,
            wanted.recordType,
            wanted.recordId,
            wanted.qualityStatementIds,
          );
          if (!found) {
            throw refused(
              problems.notFound(),
              A.itemsAdded,
              id,
              "record_not_found_or_out_of_scope",
            );
          }
          if (found.corrected) {
            throw refused(
              stateConflict("A record has been corrected since. Add the correction instead."),
              A.itemsAdded,
              id,
              "record_corrected",
            );
          }
          loaded.push(found.item);
        }
        const composed = composeEvidencePack(packRequest(row), loaded);
        if (!composed.ok) throw new Error("a stored pack request no longer passes its checks");
        const bundle = await bundleOf(tx, id);
        if (bundle.exists && bundle.content === null)
          throw new Error("a draft's bundle is deleted");
        const content: BundleContent = { ...(bundle.content ?? {}) };
        const byRecord = new Map(loaded.map((i) => [i.id, i]));
        const excluded = new Map(composed.pack.excluded.map((e) => [e.itemId, e.reason]));
        const included = new Map(composed.pack.items.map((i) => [i.itemId, i]));
        for (const item of loaded) {
          const kept = included.get(item.id);
          const source = byRecord.get(item.id) as EvidenceItem;
          const [inserted] = await tx
            .insert(evidencePackItem)
            .values({
              packId: id,
              recordType: source.recordType,
              recordId: source.recordId,
              recordVersion: source.recordVersion,
              title: source.title.slice(0, 120),
              occurredAt: source.occurredAt,
              qualityStatementIds: [
                ...(kept ? kept.qualityStatementIds : source.qualityStatementIds),
              ],
              exclusionReason: kept ? null : (excluded.get(item.id) ?? null),
              fields: kept ? stored(kept.fields) : [],
            })
            .returning({ id: evidencePackItem.id });
          if (inserted && kept) content[inserted.id] = shown(kept.fields);
        }
        await writeBundle(tx, id, content, bundle.exists);
        await audit(c, tx, access, {
          action: A.itemsAdded,
          resourceType: "evidence_pack",
          resourceId: id,
          scope: {
            included: composed.pack.items.length,
            excluded: composed.pack.excluded.length,
            records: loaded.map((i) => ({ type: i.recordType, id: i.recordId })),
          },
        });
        return packDetail(tx, (await findPack(tx, id)) as EvidencePackRow);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/evidence-packs/{id}/items/{itemId}/fields/{key}/redaction",
      tags: ["quality"],
      summary: "Redact a free-text field by hand",
      description:
        "quality.evidence_pack.compose, on a draft. The redacted copy replaces the withheld text, in your name, as a new item row superseding the old one; you become a contributor, so cannot release the pack. Refused (422) when the copy still names a third party, a staff member while roles only are shown, a person outside the pack's scope, or holds a run of ten digits (rule 4). Audited.",
      security,
      request: {
        params: z.object({ id: z.uuid(), itemId: z.uuid(), key: z.string().min(1).max(64) }),
        body: { content: { "application/json": { schema: RedactEvidenceField } } },
      },
      responses: {
        200: jsonBody(EvidencePackDetail, "Redacted"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, COMPOSE);
      const { id, itemId, key } = c.req.valid("param");
      const body = c.req.valid("json");
      const detail = await change(c, access, A.redacted, id, async (tx) => {
        const row = await packFor(tx, A.redacted, id, { version: body.version, state: "draft" });
        const item = (await currentItems(tx, id)).find((i) => i.id === itemId);
        const fields = (item?.fields ?? []) as StoredField[];
        const target = fields.find((f) => f.key === key);
        if (!item || item.exclusionReason !== null || target?.kind !== "free_text") {
          throw refused(problems.notFound(), A.redacted, id, "field_not_found");
        }
        const found = await loadEvidenceRecord(
          tx,
          item.recordType as EvidenceItem["recordType"],
          item.recordId,
          item.qualityStatementIds,
        );
        if (!found) throw refused(problems.notFound(), A.redacted, id, "record_not_found");
        if (found.corrected || found.item.recordVersion !== item.recordVersion) {
          throw refused(
            stateConflict(
              "The record has changed since it was added. Compose a new pack to show the change.",
            ),
            A.redacted,
            id,
            "record_changed",
          );
        }
        // Earlier hand redactions stand, in their redactors' names; this one is yours.
        const bundle = await bundleOf(tx, id);
        const values = bundle.content?.[item.id] ?? {};
        const now = new Date();
        const record: EvidenceItem = {
          ...found.item,
          fields: found.item.fields.map((f) => {
            if (f.key === key)
              return { ...f, redacted: { text: body.text, by: access.tenantUserId, at: now } };
            const before = fields.find((s) => s.key === f.key);
            const copy = values[f.key];
            return before?.reason === "free_text_redacted_by_hand" && before.redactedBy && copy
              ? { ...f, redacted: { text: copy, by: before.redactedBy, at: now } }
              : f;
          }),
        };
        const composed = composeEvidencePack(packRequest(row), [record]);
        const kept = composed.ok ? composed.pack.items[0] : undefined;
        const outcome = kept?.fields.find((f) => f.key === key);
        if (!kept || outcome?.reason !== "free_text_redacted_by_hand") {
          throw refused(
            problems.invalid(EVIDENCE_REDACTION_TEXT.redaction_incomplete),
            A.redacted,
            id,
            "redaction_incomplete",
          );
        }
        const [inserted] = await tx
          .insert(evidencePackItem)
          .values({
            packId: id,
            supersedesId: item.id,
            recordType: item.recordType,
            recordId: item.recordId,
            recordVersion: item.recordVersion,
            title: item.title,
            occurredAt: item.occurredAt,
            qualityStatementIds: item.qualityStatementIds,
            fields: stored(kept.fields),
          })
          .returning({ id: evidencePackItem.id });
        const content: BundleContent = { ...(bundle.content ?? {}) };
        delete content[item.id];
        if (inserted) content[inserted.id] = shown(kept.fields);
        await writeBundle(tx, id, content, bundle.exists);
        await audit(c, tx, access, {
          action: A.redacted,
          resourceType: "evidence_pack_item",
          resourceId: inserted?.id,
          scope: { packId: id, supersedes: item.id, field: key },
        });
        return packDetail(tx, (await findPack(tx, id)) as EvidencePackRow);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/evidence-packs/{id}/release",
      tags: ["quality"],
      summary: "Release a pack and issue its link (step-up)",
      description:
        "quality.evidence_pack.release at every location, with a fresh sign-in, by someone who did not compose, redact or edit it (rule 6), with at least one item. Issues the link to the recipient, expiring within evidence_pack.link_expiry_days.max (default .default). The token is returned once and only its hash is stored. Audited; quality.evidence_pack.released.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: ReleaseEvidencePack } } },
      },
      responses: {
        201: jsonBody(EvidencePackLinkIssued, "Released; the link, once"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, RELEASE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const issued = await change(c, access, A.released, id, async (tx) => {
        const row = await packFor(tx, A.released, id, { version: body.version });
        const now = new Date();
        const items = await currentItems(tx, id);
        const check = checkEvidencePackRelease(
          {
            state: row.state as "draft",
            composedBy: row.composedBy,
            contributorIds: await contributorsOf(tx, id),
            itemCount: items.filter((i) => i.exclusionReason === null).length,
            recipientEmail: row.recipientEmail,
          },
          {
            actorId: access.tenantUserId,
            permissions: usablePermissions(access, now),
            stepUpFresh: true,
            releasedAt: now,
            expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
          },
          await evidencePackPolicy(tx, access.tenantId, now),
        );
        if (!check.ok) {
          throw refused(releaseProblem(check.problems), A.released, id, check.problems.join(","));
        }
        // The pack must show each record as it stands now (#60 review round 1, HZ-050): a record
        // corrected or changed since it was added, or one the releaser cannot read, stops release.
        const stale: string[] = [];
        for (const item of items.filter((i) => i.exclusionReason === null)) {
          const found = await loadEvidenceRecord(
            tx,
            item.recordType as EvidenceItem["recordType"],
            item.recordId,
            item.qualityStatementIds,
          );
          const what = `${item.title} (${formatUkDateTimeWithZone(item.occurredAt)})`;
          if (!found) stale.push(`${what}: you cannot open it`);
          else if (found.corrected) stale.push(`${what}: corrected since it was added`);
          else if (found.item.recordVersion !== item.recordVersion)
            stale.push(`${what}: changed since it was added`);
        }
        if (stale.length > 0) {
          throw refused(
            new HttpProblem(
              409,
              "record_changed",
              "The pack no longer matches the record. Compose a new pack.",
              `${stale.join("; ")}.`,
            ),
            A.released,
            id,
            "record_changed",
          );
        }
        await tx
          .update(evidencePack)
          .set({ state: "released", releasedBy: access.tenantUserId, releasedAt: now })
          .where(eq(evidencePack.id, id));
        const { token, hash } = newEvidenceLinkToken();
        const [link] = await tx
          .insert(evidencePackLink)
          .values({
            packId: id,
            recipientEmail: row.recipientEmail,
            tokenHash: hash,
            issuedBy: access.tenantUserId,
            expiresAt: check.expiresAt,
          })
          .returning({ id: evidencePackLink.id, expiresAt: evidencePackLink.expiresAt });
        if (!link) throw new Error("link not stored");
        await audit(c, tx, access, {
          action: A.released,
          resourceType: "evidence_pack",
          resourceId: id,
          scope: { linkId: link.id, expiresAt: link.expiresAt.toISOString() },
        });
        await publishPackEvent(tx, id, "quality.evidence_pack.released", {
          linkId: link.id,
          expiresAt: link.expiresAt.toISOString(),
        });
        return { linkId: link.id, token, expiresAt: link.expiresAt.toISOString() };
      });
      // The token is in this response only: never cached (the /v1 middleware says so too).
      c.header("cache-control", "no-store");
      return c.json(issued, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/evidence-packs/{id}/links/{linkId}/reissue",
      tags: ["quality"],
      summary: "Issue a new link to the same recipient (step-up)",
      description:
        "A new link is a release (rule 9): quality.evidence_pack.release, fresh sign-in, not a contributor, expiry within the maximum. Only for the pack's latest link while it has not expired (after a lock-out or a lost email); the old link is revoked as re-issued in the same transaction. `version` is the link's. Audited.",
      security,
      request: {
        params: z.object({ id: z.uuid(), linkId: z.uuid() }),
        body: { content: { "application/json": { schema: ReissueEvidencePackLink } } },
      },
      responses: {
        201: jsonBody(EvidencePackLinkIssued, "Issued; the link, once"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, RELEASE);
      const { id, linkId } = c.req.valid("param");
      const body = c.req.valid("json");
      const issued = await change(c, access, A.reissued, id, async (tx) => {
        const row = await packFor(tx, A.reissued, id, { state: "released" });
        const [last] = await tx
          .select()
          .from(evidencePackLink)
          .where(eq(evidencePackLink.packId, id))
          .orderBy(desc(evidencePackLink.issuedAt), desc(evidencePackLink.id))
          .limit(1);
        if (!last || last.id !== linkId) {
          throw refused(problems.notFound(), A.reissued, id, "not_the_latest_link");
        }
        if (last.version !== body.version) {
          throw refused(problems.conflict(), A.reissued, id, "version_conflict");
        }
        const now = new Date();
        const bundle = await bundleOf(tx, id);
        // Once the link has ended the content is (or is about to be) deleted: a new pack instead.
        if (last.revokedAt !== null || last.expiresAt <= now || bundle.content === null) {
          throw refused(
            stateConflict(
              "This link has ended and the pack's content with it. Compose a new pack.",
            ),
            A.reissued,
            id,
            "link_ended",
          );
        }
        const check = checkEvidencePackLinkReissue(
          {
            state: "released",
            contributorIds: await contributorsOf(tx, id),
            recipientEmail: row.recipientEmail,
          },
          { linkId: last.id },
          {
            actorId: access.tenantUserId,
            permissions: usablePermissions(access, now),
            stepUpFresh: true,
            releasedAt: now,
            expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
            recipientEmail: row.recipientEmail,
          },
          await evidencePackPolicy(tx, access.tenantId, now),
        );
        if (!check.ok) {
          throw refused(releaseProblem(check.problems), A.reissued, id, check.problems.join(","));
        }
        await tx
          .update(evidencePackLink)
          .set({ revokedAt: now, revokedBy: access.tenantUserId, revocationReason: "reissued" })
          .where(and(eq(evidencePackLink.id, last.id), isNull(evidencePackLink.revokedAt)));
        const { token, hash } = newEvidenceLinkToken();
        const [link] = await tx
          .insert(evidencePackLink)
          .values({
            packId: id,
            recipientEmail: row.recipientEmail,
            tokenHash: hash,
            issuedBy: access.tenantUserId,
            replacesLinkId: last.id,
            expiresAt: check.expiresAt,
          })
          .returning({ id: evidencePackLink.id, expiresAt: evidencePackLink.expiresAt });
        if (!link) throw new Error("link not stored");
        await audit(c, tx, access, {
          action: A.reissued,
          resourceType: "evidence_pack",
          resourceId: id,
          scope: {
            linkId: link.id,
            replaces: last.id,
            expiresAt: link.expiresAt.toISOString(),
          },
        });
        return { linkId: link.id, token, expiresAt: link.expiresAt.toISOString() };
      });
      // The token is in this response only: never cached (the /v1 middleware says so too).
      c.header("cache-control", "no-store");
      return c.json(issued, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/evidence-packs/{id}/revoke",
      tags: ["quality"],
      summary: "Withdraw a released pack",
      description:
        "quality.evidence_pack.compose (withdrawing access only makes things safer, so composers may). The pack is revoked, its link stops working at once and the bundle is deleted; the manifest stays. Audited; quality.evidence_pack.revoked.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: EndEvidencePack } } },
      },
      responses: {
        200: jsonBody(EvidencePackDetail, "Revoked"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, COMPOSE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const detail = await change(c, access, A.revoked, id, async (tx) => {
        await packFor(tx, A.revoked, id, { version: body.version, state: "released" });
        const now = new Date();
        await tx
          .update(evidencePack)
          .set({
            state: "revoked",
            revokedBy: access.tenantUserId,
            revokedAt: now,
            revocationReason: body.reason,
          })
          .where(eq(evidencePack.id, id));
        await tx
          .update(evidencePackLink)
          .set({ revokedAt: now, revokedBy: access.tenantUserId, revocationReason: "pack_revoked" })
          .where(and(eq(evidencePackLink.packId, id), isNull(evidencePackLink.revokedAt)));
        await audit(c, tx, access, {
          action: A.revoked,
          resourceType: "evidence_pack",
          resourceId: id,
          reason: body.reason,
        });
        if (await deleteBundle(tx, id, "pack_revoked")) {
          await audit(c, tx, access, {
            action: BUNDLE_DELETED,
            resourceType: "evidence_pack",
            resourceId: id,
            reason: "pack_revoked",
          });
        }
        await publishPackEvent(tx, id, "quality.evidence_pack.revoked", {});
        return packDetail(tx, (await findPack(tx, id)) as EvidencePackRow);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/evidence-packs/{id}/discard",
      tags: ["quality"],
      summary: "Discard a draft pack",
      description:
        "quality.evidence_pack.compose, with a reason. The bundle is deleted; the manifest stays. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: EndEvidencePack } } },
      },
      responses: {
        200: jsonBody(EvidencePackDetail, "Discarded"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, COMPOSE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const detail = await change(c, access, A.discarded, id, async (tx) => {
        await packFor(tx, A.discarded, id, { version: body.version, state: "draft" });
        await tx
          .update(evidencePack)
          .set({
            state: "discarded",
            discardedBy: access.tenantUserId,
            discardedAt: new Date(),
            discardReason: body.reason,
          })
          .where(eq(evidencePack.id, id));
        await audit(c, tx, access, {
          action: A.discarded,
          resourceType: "evidence_pack",
          resourceId: id,
          reason: body.reason,
        });
        if (await deleteBundle(tx, id, "pack_discarded")) {
          await audit(c, tx, access, {
            action: BUNDLE_DELETED,
            resourceType: "evidence_pack",
            resourceId: id,
            reason: "pack_discarded",
          });
        }
        return packDetail(tx, (await findPack(tx, id)) as EvidencePackRow);
      });
      return c.json(detail, 200);
    },
  );
