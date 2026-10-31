import {
  ComplianceItemKind,
  CreateStaffFile,
  RecordComplianceItem,
  SignDbsRiskAssessment,
  StaffFileItem,
  StaffFileList,
  StaffHrDocument,
  StaffMemberList,
  UpdateStaffFile,
} from "@harbour/contracts";
import { complianceItem, document, staffProfile, type Transaction } from "@harbour/db";
import { type ComplianceDetail, complianceItemView, ukIsoDate } from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { AuditedRefusal, withAuditedRefusal, writeAudit } from "../http/audit";
import {
  type AppEnv,
  refusalOf,
  requireAnyPermission,
  requirePermission,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import {
  contentHeaders,
  destroyingOnFailure,
  imagePrintableOf,
  readDocumentContent,
  storeDocument,
} from "../services/documents";
import { sameStored } from "../services/record-history";
import {
  COMPLIANCE_ITEM_SOURCE,
  type ComplianceItemRow,
  currentStaff,
  endItemReminders,
  hrDocuments,
  isCurrentStaff,
  loadStaffFile,
  namesFor,
  nationOf,
  profileFacts,
  STAFF_FILE_SOURCE,
  type StaffProfileRow,
  staffFileItem,
  staffFileSummary,
  storedItem,
  workforceRates,
} from "../services/staff-files";
import { fileBody, fileResponse } from "./documents";
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
 * The staff profile and pre-employment file (workforce.md sections 2a, 3 and 5; WORK-002,
 * WORK-011; plan slice 11). Profiles and checks are read with workforce.staff_file.read and
 * written with .manage, never on one's own file; HR-only documents need
 * workforce.hr_document.read and every open is audited; the DBS risk assessment needs
 * workforce.dbs_risk_assessment.sign. The database enforces the same (migration 0073). Audit
 * events carry opaque ids and codes only.
 */

const READ = "workforce.staff_file.read";
const MANAGE = "workforce.staff_file.manage";
const HR_DOCUMENT = "workforce.hr_document.read";
const SIGN = "workforce.dbs_risk_assessment.sign";
const SELF = "workforce.self.read";
const A = {
  viewed: "workforce.staff_file.viewed",
  created: "workforce.staff_file.created",
  updated: "workforce.staff_file.updated",
  recorded: "workforce.compliance_item.recorded",
  signed: "workforce.dbs_risk_assessment.signed",
  documentAdded: "workforce.hr_document.added",
  documentViewed: "workforce.hr_document.viewed",
} as const;

const FileParam = z.object({ id: z.uuid() });
const ItemParam = z.object({ id: z.uuid(), kind: ComplianceItemKind });
const DocumentParam = z.object({ id: z.uuid(), documentId: z.uuid() });
const UploadQuery = z.object({
  title: z.string().trim().min(2).max(160),
  fileName: z.string().max(255).optional(),
});

const refused = (problem: HttpProblem, action: string, id: string | null, reason: string) =>
  new AuditedRefusal(problem, {
    action,
    outcome: "denied",
    resourceType: STAFF_FILE_SOURCE,
    ...(id ? { resourceId: id } : {}),
    reason,
  });

const notStaff = () =>
  new HttpProblem(422, "not_current_staff", "Choose a current member of staff.");

const ownFile = (action: string, id: string | null) =>
  refused(
    new HttpProblem(
      403,
      "own_staff_file",
      "Someone else records the checks on your own staff file.",
    ),
    action,
    id,
    "own_staff_file",
  );

/** Runs a change; refusals and the database's own (403, 404, 409) are audited. */
async function change<T>(
  c: Context<AppEnv>,
  access: TenantAccess,
  action: string,
  id: string | null,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  try {
    return await withAuditedRefusal(c, access, () => withTenant(c, fn));
  } catch (error) {
    const code = dbCode(error);
    if (!["42501", "23000", "23505", "23503", "23514"].includes(code ?? "")) throw error;
    await writeAudit(c.get("services").appPool, access, {
      action,
      outcome: "denied",
      resourceType: STAFF_FILE_SOURCE,
      ...(id ? { resourceId: id } : {}),
      reason: code === "42501" ? "refused_by_database" : `invalid_${code}`,
      requestId: c.get("requestId"),
    });
    if (code === "42501") throw problems.forbidden();
    if (code === "23505") {
      throw new HttpProblem(
        409,
        "staff_file_exists",
        "This member of staff already has a staff file.",
      );
    }
    if (code === "23503")
      throw problems.invalid("Choose a member of staff and a location of this organisation.");
    throw problems.invalid(
      "Those details cannot be saved together. Check the dates and try again.",
    );
  }
}

async function today(): Promise<string> {
  return ukIsoDate(new Date());
}

async function ratesFor(
  tx: Transaction,
  access: TenantAccess,
  profile: StaffProfileRow,
  on: string,
) {
  return workforceRates(tx, access.tenantId, await nationOf(tx, profile.locationId), on);
}

/** The whole file as the caller may see it, HR-only documents only for holders. */
async function fileBodyOf(
  c: Context<AppEnv>,
  tx: Transaction,
  access: TenantAccess,
  profile: StaffProfileRow,
  items: ComplianceItemRow[],
  on: string,
  withDocuments: boolean,
) {
  const rates = await ratesFor(tx, access, profile, on);
  const names = await namesFor(tx, [profile], items);
  const documents =
    withDocuments && refusalOf(c.get("access"), HR_DOCUMENT) === null
      ? await hrDocuments(tx, items)
      : null;
  return staffFileItem(profile, items, on, rates, names, documents);
}

async function fileFor(
  tx: Transaction,
  action: string,
  id: string,
  expect: { version?: number; notOwnOf?: string } = {},
) {
  const found = await loadStaffFile(tx, id);
  if (!found) throw refused(problems.notFound(), action, id, "not_found");
  if (expect.notOwnOf && found.profile.tenantUserId === expect.notOwnOf) throw ownFile(action, id);
  if (expect.version !== undefined && found.profile.version !== expect.version) {
    throw refused(problems.conflict(), action, id, "version_conflict");
  }
  return found;
}

export const staffFilesRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/staff-members",
      tags: ["workforce"],
      summary: "Staff to choose from",
      description:
        "workforce.staff_file.manage, workforce.sponsor.manage or workforce.ldss.manage. Active and invited members holding a staff role in force now, organisation-wide, by display name and job title only (never an email), for the member picker on HR forms; HR roles hold no platform.user.manage.",
      security,
      responses: { 200: jsonBody(StaffMemberList, "Staff"), ...errorResponses },
    }),
    async (c) => {
      await requireAnyPermission(c, [MANAGE, "workforce.sponsor.manage", "workforce.ldss.manage"]);
      const items = await withTenant(c, (tx) => currentStaff(tx));
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/staff-files",
      tags: ["workforce"],
      summary: "Staff files",
      description:
        "workforce.staff_file.read or .manage. Every staff profile with where its Schedule 3 file stands today: complete or not, outstanding items and items due soon.",
      security,
      responses: { 200: jsonBody(StaffFileList, "Staff files"), ...errorResponses },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [READ, MANAGE]);
      const on = await today();
      const items = await withTenant(c, async (tx) => {
        const profiles = await tx
          .select()
          .from(staffProfile)
          .where(isNull(staffProfile.deletedAt))
          .orderBy(staffProfile.createdAt);
        const rows =
          profiles.length === 0
            ? []
            : await tx
                .select()
                .from(complianceItem)
                .where(
                  inArray(
                    complianceItem.staffProfileId,
                    profiles.map((p) => p.id),
                  ),
                );
        const names = await namesFor(tx, profiles, []);
        const out = [];
        for (const profile of profiles) {
          const rates = await ratesFor(tx, access, profile, on);
          out.push(
            staffFileSummary(
              profile,
              rows.filter((r) => r.staffProfileId === profile.id),
              on,
              rates,
              names,
            ),
          );
        }
        return out;
      });
      return c.json({ items, asOf: on }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/staff-files",
      tags: ["workforce"],
      summary: "Create a staff file",
      description:
        "workforce.staff_file.manage. One file per member of staff, never one's own. Audited.",
      security,
      request: { body: { content: { "application/json": { schema: CreateStaffFile } } } },
      responses: {
        201: jsonBody(StaffFileItem, "Created"),
        ...errorResponses,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const body = c.req.valid("json");
      const on = await today();
      const result = await change(c, access, A.created, null, async (tx) => {
        if (body.tenantUserId === access.tenantUserId) throw ownFile(A.created, null);
        if (!(await isCurrentStaff(tx, body.tenantUserId))) {
          throw refused(notStaff(), A.created, null, "not_current_staff");
        }
        const [row] = await tx
          .insert(staffProfile)
          .values({
            tenantUserId: body.tenantUserId,
            locationId: body.locationId,
            jobTitle: body.jobTitle,
            pathwayCategory: body.pathwayCategory,
            registrationBody: body.registrationBody,
            previousCareWork: body.previousCareWork,
            dateOfBirth: body.dateOfBirth,
            startsOn: body.startsOn,
            leftOn: body.leftOn,
          })
          .returning();
        if (!row) throw new Error("staff profile not stored");
        await audit(c, tx, access, {
          action: A.created,
          resourceType: STAFF_FILE_SOURCE,
          resourceId: row.id,
          scopeExtra: { memberId: row.tenantUserId },
        });
        return fileBodyOf(c, tx, access, row, [], on, true);
      });
      return c.json(result, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/staff-files/{id}",
      tags: ["workforce"],
      summary: "A staff file",
      description:
        "workforce.staff_file.read or .manage. The profile and every Schedule 3 item with its details, status and notes today; the HR-only documents' details for holders of workforce.hr_document.read. Audited.",
      security,
      request: { params: FileParam },
      responses: {
        200: jsonBody(StaffFileItem, "The staff file"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [READ, MANAGE]);
      const { id } = c.req.valid("param");
      const on = await today();
      const result = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          const { profile, items } = await fileFor(tx, A.viewed, id);
          await audit(c, tx, access, {
            action: A.viewed,
            resourceType: STAFF_FILE_SOURCE,
            resourceId: id,
          });
          return fileBodyOf(c, tx, access, profile, items, on, true);
        }),
      );
      return c.json(result, 200);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/v1/workforce/staff-files/{id}",
      tags: ["workforce"],
      summary: "Change a staff profile",
      description:
        "workforce.staff_file.manage, never on one's own file, against the version you loaded. Audited.",
      security,
      request: {
        params: FileParam,
        body: { content: { "application/json": { schema: UpdateStaffFile } } },
      },
      responses: {
        200: jsonBody(StaffFileItem, "Saved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const on = await today();
      const result = await change(c, access, A.updated, id, async (tx) => {
        const { items } = await fileFor(tx, A.updated, id, {
          version: body.expectedVersion,
          notOwnOf: access.tenantUserId,
        });
        const [row] = await tx
          .update(staffProfile)
          .set({
            locationId: body.locationId,
            jobTitle: body.jobTitle,
            pathwayCategory: body.pathwayCategory,
            registrationBody: body.registrationBody,
            previousCareWork: body.previousCareWork,
            dateOfBirth: body.dateOfBirth,
            startsOn: body.startsOn,
            leftOn: body.leftOn,
          })
          .where(and(eq(staffProfile.id, id), eq(staffProfile.version, body.expectedVersion)))
          .returning();
        if (!row) throw refused(problems.conflict(), A.updated, id, "version_conflict");
        await audit(c, tx, access, {
          action: A.updated,
          resourceType: STAFF_FILE_SOURCE,
          resourceId: id,
        });
        return fileBodyOf(c, tx, access, row, items, on, true);
      });
      return c.json(result, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/workforce/staff-files/{id}/items/{kind}",
      tags: ["workforce"],
      summary: "Record a pre-employment check",
      description:
        "workforce.staff_file.manage, never on one's own file. Records or replaces one Schedule 3 item's details (the detail's kind must be the path's) and verifies it in the caller's name on a date no later than today, or leaves it unverified. An existing item needs expectedVersion. A new expiry or re-check date ends the item's open reminder tasks. Audited.",
      security,
      request: {
        params: ItemParam,
        body: { content: { "application/json": { schema: RecordComplianceItem } } },
      },
      responses: {
        200: jsonBody(StaffFileItem, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id, kind } = c.req.valid("param");
      const body = c.req.valid("json");
      const on = await today();
      const result = await change(c, access, A.recorded, id, async (tx) => {
        if (body.detail.kind !== kind) {
          throw refused(
            problems.invalid("The details are for a different check."),
            A.recorded,
            id,
            "kind_mismatch",
          );
        }
        if (body.verifiedOn !== null && body.verifiedOn > on) {
          throw refused(
            problems.invalid("A check is verified on or before today."),
            A.recorded,
            id,
            "verified_in_future",
          );
        }
        const { profile, items } = await fileFor(tx, A.recorded, id, {
          notOwnOf: access.tenantUserId,
        });
        const existing = items.find((i) => i.kind === kind && i.deletedAt === null);
        if (existing && body.expectedVersion !== existing.version) {
          throw refused(problems.conflict(), A.recorded, id, "version_conflict");
        }
        const rates = await ratesFor(tx, access, profile, on);
        const draft = {
          ...(existing ?? {}),
          detail: body.detail,
          verifiedOn: body.verifiedOn,
          verifiedBy: null,
          riskAssessmentSignedOn: existing?.riskAssessmentSignedOn ?? null,
          riskAssessmentSignedBy: existing?.riskAssessmentSignedBy ?? null,
        } as ComplianceItemRow;
        const view = complianceItemView(storedItem(draft), profileFacts(profile), on, rates);
        // The verifier stays only when nothing they verified changed; changed details or a new
        // date are verified in the caller's name (review round 1, finding 1).
        const unchanged =
          existing !== undefined &&
          existing.verifiedOn === body.verifiedOn &&
          sameStored(existing.detail, body.detail);
        const verifiedBy =
          body.verifiedOn === null ? null : unchanged ? existing.verifiedBy : access.tenantUserId;
        const values = {
          detail: body.detail as ComplianceDetail,
          verifiedOn: body.verifiedOn,
          verifiedBy,
          expiresOn: view.expiresOn,
          recheckDueOn: view.recheckDueOn,
        };
        let saved: ComplianceItemRow | undefined;
        if (existing) {
          [saved] = await tx
            .update(complianceItem)
            .set(values)
            .where(
              and(eq(complianceItem.id, existing.id), eq(complianceItem.version, existing.version)),
            )
            .returning();
          if (!saved) throw refused(problems.conflict(), A.recorded, id, "version_conflict");
          if (
            (existing.expiresOn ?? existing.recheckDueOn) !==
            (saved.expiresOn ?? saved.recheckDueOn)
          ) {
            await endItemReminders(tx, saved.id);
          }
        } else {
          [saved] = await tx
            .insert(complianceItem)
            .values({ staffProfileId: id, kind, ...values })
            .returning();
        }
        if (!saved) throw new Error("compliance item not stored");
        await audit(c, tx, access, {
          action: A.recorded,
          resourceType: COMPLIANCE_ITEM_SOURCE,
          resourceId: saved.id,
          scopeExtra: { staffProfileId: id, kind, verified: body.verifiedOn !== null },
        });
        const all = items.filter((i) => i.id !== saved.id).concat(saved);
        return fileBodyOf(c, tx, access, profile, all, on, true);
      });
      return c.json(result, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/staff-files/{id}/items/dbs_certificate/risk-assessment",
      tags: ["workforce"],
      summary: "Sign the DBS risk assessment",
      description:
        "workforce.dbs_risk_assessment.sign, never for oneself, in the caller's name, on a date no later than today. Lets a worker with a clear adults' barred list check start supervised before the certificate, or accepts a disclosure on a certificate already seen (workforce.md rule 3). Audited.",
      security,
      request: {
        params: FileParam,
        body: { content: { "application/json": { schema: SignDbsRiskAssessment } } },
      },
      responses: {
        200: jsonBody(StaffFileItem, "Signed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, SIGN);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const on = await today();
      const result = await change(c, access, A.signed, id, async (tx) => {
        if (body.signedOn > on) {
          throw refused(
            problems.invalid("A risk assessment is signed on or before today."),
            A.signed,
            id,
            "signed_in_future",
          );
        }
        const { profile, items } = await fileFor(tx, A.signed, id, {
          notOwnOf: access.tenantUserId,
        });
        const dbs = items.find((i) => i.kind === "dbs_certificate" && i.deletedAt === null);
        if (!dbs) {
          throw refused(
            problems.invalid("Record the DBS check before signing its risk assessment."),
            A.signed,
            id,
            "no_dbs_item",
          );
        }
        const [saved] = await tx
          .update(complianceItem)
          .set({
            riskAssessmentSignedOn: body.signedOn,
            riskAssessmentSignedBy: access.tenantUserId,
          })
          .where(
            and(eq(complianceItem.id, dbs.id), eq(complianceItem.version, body.expectedVersion)),
          )
          .returning();
        if (!saved) throw refused(problems.conflict(), A.signed, id, "version_conflict");
        await audit(c, tx, access, {
          action: A.signed,
          resourceType: COMPLIANCE_ITEM_SOURCE,
          resourceId: saved.id,
          scopeExtra: { staffProfileId: id },
        });
        const all = items.filter((i) => i.id !== saved.id).concat(saved);
        return fileBodyOf(c, tx, access, profile, all, on, true);
      });
      return c.json(result, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/staff-files/{id}/items/{kind}/documents",
      tags: ["workforce"],
      summary: "Add an HR-only document (the body is the file)",
      description:
        "workforce.staff_file.manage and workforce.hr_document.read, never on one's own file. Checked by its contents (JPEG, PNG, WebP or PDF), scanned and stored encrypted, as the document store does. Never to the DBS check: no certificate copy is kept. Right to work copies are kept as right_to_work_copy. Audited.",
      security,
      request: { params: ItemParam, query: UploadQuery, body: fileBody },
      responses: {
        201: jsonBody(StaffHrDocument, "Stored"),
        ...errorResponses,
        ...notFoundResponse,
        413: jsonBody(z.object({ code: z.string() }), "The file is too large"),
      },
    }),
    async (c) => {
      await requirePermission(c, HR_DOCUMENT);
      const access = await requirePermission(c, MANAGE);
      const { id, kind } = c.req.valid("param");
      const q = c.req.valid("query");
      if (kind === "dbs_certificate") {
        await writeAudit(c.get("services").appPool, access, {
          action: A.documentAdded,
          outcome: "denied",
          resourceType: STAFF_FILE_SOURCE,
          resourceId: id,
          reason: "dbs_copy_not_kept",
          requestId: c.get("requestId"),
        });
        throw problems.invalid(
          "A copy of a DBS certificate is not kept. Record the check's details instead.",
        );
      }
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const imagePrintable = imagePrintableOf(bytes);
      const { scanner } = c.get("services");
      const item = await destroyingOnFailure(c.get("services").storage, (storage) =>
        change(c, access, A.documentAdded, id, async (tx) => {
          const { items } = await fileFor(tx, A.documentAdded, id, {
            notOwnOf: access.tenantUserId,
          });
          const target = items.find((i) => i.kind === kind && i.deletedAt === null);
          if (!target) {
            throw refused(
              problems.invalid("Record the check before adding its documents."),
              A.documentAdded,
              id,
              "no_item",
            );
          }
          const row = await storeDocument(tx, { storage, scanner }, access.tenantId, {
            bytes,
            imagePrintable,
            declaredType: c.req.header("content-type") ?? null,
            category: "staff_hr_document",
            title: q.title,
            fileName: q.fileName ?? null,
            subjectType: COMPLIANCE_ITEM_SOURCE,
            subjectId: target.id,
            ...(kind === "right_to_work" ? { retentionClass: "right_to_work_copy" } : {}),
          });
          await audit(c, tx, access, {
            action: A.documentAdded,
            resourceType: "document",
            resourceId: row.id,
            scopeExtra: { staffProfileId: id, kind },
          });
          const [listed] = await hrDocuments(tx, [target]).then((all) =>
            all.filter((d) => d.id === row.id),
          );
          if (!listed) throw new Error("HR document not listed");
          return listed;
        }),
      );
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/staff-files/{id}/documents/{documentId}/content",
      tags: ["workforce"],
      summary: "Open an HR-only document (audited)",
      description:
        "workforce.hr_document.read. Every open is audited as workforce.hr_document.viewed.",
      security,
      request: { params: DocumentParam },
      responses: { 200: fileResponse("The file"), ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const access = await requirePermission(c, HR_DOCUMENT);
      const { id, documentId } = c.req.valid("param");
      const { storage } = c.get("services");
      const { row, bytes } = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          const items = await tx
            .select({ id: complianceItem.id })
            .from(complianceItem)
            .where(eq(complianceItem.staffProfileId, id));
          const [found] = await tx
            .select({ id: document.id })
            .from(document)
            .where(
              and(
                eq(document.id, documentId),
                eq(document.category, "staff_hr_document"),
                eq(document.subjectType, COMPLIANCE_ITEM_SOURCE),
                items.length > 0
                  ? inArray(
                      document.subjectId,
                      items.map((i) => i.id),
                    )
                  : eq(document.id, "00000000-0000-0000-0000-000000000000"),
              ),
            );
          if (!found) {
            throw refused(problems.notFound(), A.documentViewed, documentId, "not_found");
          }
          const content = await readDocumentContent(tx, storage, documentId);
          await audit(c, tx, access, {
            action: A.documentViewed,
            resourceType: "document",
            resourceId: documentId,
            scopeExtra: { staffProfileId: id },
          });
          return content;
        }),
      );
      return c.body(bytes as Uint8Array<ArrayBuffer>, 200, contentHeaders(row));
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/me/staff-file",
      tags: ["workforce"],
      summary: "My staff file",
      description:
        "workforce.self.read. The member's own profile and where each of their checks stands; not the HR-only documents.",
      security,
      responses: {
        200: jsonBody(StaffFileItem, "Your staff file"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, SELF);
      const on = await today();
      const result = await withTenant(c, async (tx) => {
        const [profile] = await tx
          .select()
          .from(staffProfile)
          .where(
            and(eq(staffProfile.tenantUserId, access.tenantUserId), isNull(staffProfile.deletedAt)),
          );
        if (!profile) return null;
        const items = await tx
          .select()
          .from(complianceItem)
          .where(eq(complianceItem.staffProfileId, profile.id));
        return fileBodyOf(c, tx, access, profile, items, on, false);
      });
      if (!result) throw problems.notFound();
      return c.json(result, 200);
    },
  );
