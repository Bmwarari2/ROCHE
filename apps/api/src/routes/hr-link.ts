import { randomUUID } from "node:crypto";
import {
  auditEvent,
  HR_LINK_PORT,
  hrDelivery,
  hrLocationLink,
  hrPersonLink,
  integrationConnection,
  location,
  staffProfile,
  type Transaction,
  tenant,
  withRequestContext,
} from "@harbour/db";
import {
  DEFAULT_HR_OWNERS,
  HR_STALENESS_DEFAULT_MINUTES,
  HR_STALENESS_MAX_MINUTES,
  type HrOwners,
  stalenessLimitProblem,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import {
  type AppEnv,
  clientIp,
  requireAnyPermission,
  requirePermission,
  stepUpRefusal,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import {
  applyEmployee,
  DECOY_SECRET,
  deliverStarter,
  type HrLinkSettings,
  HrOwnersSchema,
  HrWebhookSchema,
  hrConnection,
  hrLinkEnabled,
  hrLinkStaleness,
  leaversNotEnded,
  ownersOrProblem,
  pullSafely,
  signatureRefusal,
  starterFor,
  ukRefusal,
} from "../integrations/hr-link";
import { receiveInbound } from "../integrations/inbound";
import { SECRET_REF_SHAPE, secretRefProblem } from "../integrations/secret-ref";
import { publish } from "../outbox";
import { endLeaversAccess } from "../services/leavers";
import { withSystemRights } from "../services/system-rights";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
  unavailableResponse,
} from "./openapi";

/**
 * The Thapsus-HR link (integrations.md section 11.6; INTG-014; ADR-0126; slice 87). Behind the
 * `integrations.thapsus_hr` flag, off by default. Connecting, owners and locations need
 * `integrations.hr_link.manage` with step-up; match decisions `integrations.hr_link.review`;
 * health `integrations.hr_link.read`. The webhook receiver is public (no session): it is signed.
 */

const tags = ["integrations"];
/** The reconciliation's interval: a shorter staleness limit would always show a healthy link stale. */
const HR_SYNC_MINUTES = 10;
const READERS = [
  "integrations.hr_link.read",
  "integrations.hr_link.review",
  "integrations.hr_link.manage",
] as const;

const notUk = (code: string) =>
  new HttpProblem(
    422,
    "hr_link_not_uk",
    "The link works only with a Thapsus-HR workspace in the UK, on its UK address.",
    code,
  );
const unavailable = () =>
  new HttpProblem(
    503,
    "hr_link_unavailable",
    "The link to Thapsus-HR is not available yet. Keep using the payroll export and staff files.",
  );
const notConnected = () =>
  new HttpProblem(404, "hr_link_not_connected", "This organisation is not linked to Thapsus-HR.");

async function requireFlag(tx: Transaction) {
  if (!(await hrLinkEnabled(tx))) throw problems.featureDisabled();
}

function portFor(c: Context<AppEnv>, tenantId: string, settings: HrLinkSettings) {
  const port = c.get("services").hrLink.port(tenantId, settings);
  if (!port) throw unavailable();
  return port;
}

const Owners = HrOwnersSchema.meta({ id: "HrLinkOwners" });

const Status = z
  .object({
    connected: z.boolean(),
    status: z.string().nullable(),
    version: z.number().int().nullable(),
    workspaceSlug: z.string().nullable(),
    apiBaseUrl: z.string().nullable(),
    owners: Owners,
    stalenessMinutes: z.number().int(),
    hasWebhookSecret: z.boolean(),
    staleness: z
      .object({
        stale: z.boolean(),
        lastGoodSyncAt: z.string().nullable(),
        lastErrorCode: z.string().nullable(),
        failures: z.number().int(),
      })
      .nullable(),
    matchesToReview: z.number().int(),
    /** Leavers whose day is over but whose access could not be ended automatically. */
    leaversNotEnded: z.number().int(),
  })
  .meta({ id: "HrLinkStatus" });

const Connect = z
  .object({
    workspaceSlug: z.string().regex(/^[a-z0-9-]{1,63}$/),
    owners: Owners.optional(),
    stalenessMinutes: z
      .number()
      .int()
      .min(HR_SYNC_MINUTES)
      .max(HR_STALENESS_MAX_MINUTES)
      .optional(),
    secretRef: z.string().regex(SECRET_REF_SHAPE).nullable().default(null),
  })
  .strict()
  .meta({ id: "HrLinkConnect" });

const Change = z
  .object({
    expectedVersion: z.number().int(),
    owners: Owners.optional(),
    stalenessMinutes: z
      .number()
      .int()
      .min(HR_SYNC_MINUTES)
      .max(HR_STALENESS_MAX_MINUTES)
      .optional(),
    secretRef: z.string().regex(SECRET_REF_SHAPE).nullable().optional(),
  })
  .strict()
  .meta({ id: "HrLinkChange" });

const SyncResult = z
  .object({
    linked: z.number().int(),
    review: z.number().int(),
    leavers: z.number().int(),
    drift: z.number().int(),
    failed: z.number().int(),
    error: z.string().nullable(),
  })
  .meta({ id: "HrLinkSyncResult" });

const Match = z
  .object({
    id: z.uuid(),
    version: z.number().int(),
    hrEmployeeId: z.string(),
    employeeNumber: z.string().nullable(),
    reason: z.string(),
    candidateStaffProfileId: z.uuid().nullable(),
    /** Read from Thapsus-HR for the reviewer now; never stored here (section 11.8). */
    hrName: z.string().nullable(),
    hrWorkEmail: z.string().nullable(),
    /** A leaving date Thapsus-HR already gave: the queue shows these first. */
    leavingOn: z.string().nullable(),
  })
  .meta({ id: "HrLinkMatch" });

const Delivery = z
  .object({
    id: z.uuid(),
    kind: z.string(),
    harbourRef: z.uuid(),
    hrId: z.string().nullable(),
    state: z.string(),
    attempts: z.number().int(),
    lastErrorCode: z.string().nullable(),
    sentAt: z.string().nullable(),
  })
  .meta({ id: "HrLinkDelivery" });

const LocationMap = z
  .object({
    harbour: z.array(
      z.object({ locationId: z.uuid(), name: z.string(), hrLocationId: z.string().nullable() }),
    ),
    thapsusHr: z.array(z.object({ id: z.string(), name: z.string() })),
  })
  .meta({ id: "HrLinkLocations" });

const settingsOf = (
  slug: string,
  domain: string,
  owners: HrOwners,
  minutes: number,
): HrLinkSettings => ({
  workspaceSlug: slug,
  homeRegion: "uk",
  apiBaseUrl: `https://api.uk.${domain}`,
  thapsusDomain: domain,
  owners,
  stalenessMinutes: minutes,
});

function checkSecret(c: Context<AppEnv>, access: TenantAccess, ref: string | null | undefined) {
  if (!ref) return;
  const problem = secretRefProblem(ref, {
    projectId: c.get("services").config.GCP_PROJECT_ID,
    tenantId: access.tenantId,
  });
  if (problem) throw problems.invalid(problem);
}

/** The pull in the organisation's own system context (no member; rule 3), audited as the link. */
function pullAsSystem(
  c: Context<AppEnv>,
  tx: Transaction,
  tenantId: string,
  settings: HrLinkSettings,
) {
  const port = portFor(c, tenantId, settings);
  return withSystemRights(tx, () => pullSafely(tx, tenantId, port, settings, new Date()));
}

export const hrLinkRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/integrations/hr-link",
      tags,
      summary: "The Thapsus-HR link: status, owners and whether its data is out of date",
      security,
      responses: { 200: jsonBody(Status, "Link status"), ...errorResponses },
    }),
    async (c) => {
      await requireAnyPermission(c, READERS);
      const body = await withTenant(c, async (tx) => {
        await requireFlag(tx);
        const link = await hrConnection(tx);
        const review = await tx
          .select({ id: hrPersonLink.id })
          .from(hrPersonLink)
          .where(and(eq(hrPersonLink.state, "review"), isNull(hrPersonLink.deletedAt)));
        return {
          connected: link?.status === "connected",
          status: link?.status ?? null,
          version: link?.version ?? null,
          workspaceSlug: link?.settings.workspaceSlug ?? null,
          apiBaseUrl: link?.settings.apiBaseUrl ?? null,
          owners: link?.settings.owners ?? DEFAULT_HR_OWNERS,
          stalenessMinutes: link?.settings.stalenessMinutes ?? HR_STALENESS_DEFAULT_MINUTES,
          hasWebhookSecret: link?.secretRef != null,
          // Said after a disconnect too, so nobody reads old data as current (rule 9).
          staleness: link ? await hrLinkStaleness(tx, link.settings, new Date()) : null,
          matchesToReview: review.length,
          leaversNotEnded: await leaversNotEnded(tx, new Date()),
        };
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/integrations/hr-link",
      tags,
      summary: "Connect to the organisation's Thapsus-HR workspace (UK only; step-up)",
      description:
        "Checks the workspace is in the UK and reached on its UK address, records the link, then pulls employees and matches them (employee number, then work email with date of birth; never by name).",
      security,
      request: { body: { content: { "application/json": { schema: Connect } } } },
      responses: {
        201: jsonBody(SyncResult, "Connected; first pull done"),
        ...errorResponses,
        ...conflictResponse,
        ...unavailableResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "integrations.hr_link.manage");
      const body = c.req.valid("json");
      checkSecret(c, access, body.secretRef);
      const owners = body.owners ?? DEFAULT_HR_OWNERS;
      const ownersProblem = ownersOrProblem(owners);
      if (ownersProblem) throw problems.invalid(`These stay with this product: ${ownersProblem}`);
      // Thapsus's domain is this environment's, never the caller's (rule 1).
      const domain = c.get("services").hrLink.domain;
      if (!domain) throw unavailable();
      const settings = settingsOf(
        body.workspaceSlug,
        domain,
        owners,
        body.stalenessMinutes ?? HR_STALENESS_DEFAULT_MINUTES,
      );
      const result = await withTenant(c, async (tx) => {
        await requireFlag(tx);
        const port = portFor(c, access.tenantId, settings);
        const refusal = await ukRefusal(port, settings);
        if (refusal) {
          await auditInTx(tx, access, {
            action: "integrations.hr_link.connect",
            outcome: "denied",
            resourceType: "integration_connection",
            resourceId: HR_LINK_PORT,
            reason: refusal,
          });
          return { refusal };
        }
        const existing = await hrConnection(tx);
        if (existing?.status === "connected") throw problems.conflict("Already linked.");
        const values = {
          provider: "thapsus_hr",
          status: "connected",
          settings: settings as unknown as Record<string, unknown>,
          secretRef: body.secretRef,
          lastError: null,
        };
        if (existing) {
          await tx
            .update(integrationConnection)
            .set(values)
            .where(eq(integrationConnection.id, existing.id));
        } else {
          await tx.insert(integrationConnection).values({ port: HR_LINK_PORT, ...values });
        }
        await auditInTx(tx, access, {
          action: "integrations.hr_link.connect",
          resourceType: "integration_connection",
          resourceId: HR_LINK_PORT,
          after: { ...settings, hasSecret: body.secretRef !== null },
        });
        return { pulled: await pullAsSystem(c, tx, access.tenantId, settings) };
      });
      // A refusal is audited, and nothing was sent or kept.
      if ("refusal" in result) throw notUk(String(result.refusal));
      return c.json(result.pulled, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/v1/integrations/hr-link",
      tags,
      summary: "Change the owners, staleness limit or webhook secret (step-up)",
      security,
      request: { body: { content: { "application/json": { schema: Change } } } },
      responses: {
        200: jsonBody(z.object({ version: z.number().int() }), "Changed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "integrations.hr_link.manage");
      const body = c.req.valid("json");
      checkSecret(c, access, body.secretRef);
      const version = await withTenant(c, async (tx) => {
        await requireFlag(tx);
        const link = await hrConnection(tx);
        if (!link) throw notConnected();
        const owners = body.owners ?? link.settings.owners;
        const ownersProblem = ownersOrProblem(owners);
        if (ownersProblem) throw problems.invalid(`These stay with this product: ${ownersProblem}`);
        const minutes = body.stalenessMinutes ?? link.settings.stalenessMinutes;
        if (stalenessLimitProblem(minutes)) throw problems.invalid("Choose 1 to 60 minutes.");
        const settings = { ...link.settings, owners, stalenessMinutes: minutes };
        const [row] = await tx
          .update(integrationConnection)
          .set({
            settings: settings as unknown as Record<string, unknown>,
            ...(body.secretRef !== undefined ? { secretRef: body.secretRef } : {}),
          })
          .where(
            and(
              eq(integrationConnection.id, link.id),
              eq(integrationConnection.version, body.expectedVersion),
            ),
          )
          .returning({ version: integrationConnection.version });
        if (!row) throw problems.conflict();
        await auditInTx(tx, access, {
          action: "integrations.hr_link.change",
          resourceType: "integration_connection",
          resourceId: HR_LINK_PORT,
          before: link.settings,
          after: settings,
          ...(body.secretRef !== undefined ? { scope: { secretChanged: true } } : {}),
        });
        return row.version;
      });
      return c.json({ version }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/integrations/hr-link/test",
      tags,
      summary: "Check the link: reachable, and still a UK workspace on its UK address",
      security,
      responses: {
        200: jsonBody(z.object({ ok: z.boolean(), code: z.string().nullable() }), "Checked"),
        ...errorResponses,
        ...notFoundResponse,
        ...unavailableResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "integrations.hr_link.manage");
      const out = await withTenant(c, async (tx) => {
        await requireFlag(tx);
        const link = await hrConnection(tx);
        if (!link) throw notConnected();
        const port = portFor(c, access.tenantId, link.settings);
        const health = await port.health();
        const code = health.ok ? await ukRefusal(port, link.settings) : "unavailable";
        await auditInTx(tx, access, {
          action: "integrations.hr_link.test",
          outcome: code ? "error" : "success",
          resourceType: "integration_connection",
          resourceId: HR_LINK_PORT,
          ...(code ? { reason: code } : {}),
        });
        return { ok: code === null, code };
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/v1/integrations/hr-link",
      tags,
      summary: "Disconnect: sync stops; links and leaving dates are kept for audit (step-up)",
      security,
      responses: { 204: { description: "Disconnected" }, ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const access = await requirePermission(c, "integrations.hr_link.manage");
      await withTenant(c, async (tx) => {
        await requireFlag(tx);
        const link = await hrConnection(tx);
        if (link?.status !== "connected") throw notConnected();
        await tx
          .update(integrationConnection)
          .set({ status: "disconnected" })
          .where(eq(integrationConnection.id, link.id));
        await auditInTx(tx, access, {
          action: "integrations.hr_link.disconnect",
          resourceType: "integration_connection",
          resourceId: HR_LINK_PORT,
        });
      });
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/integrations/hr-link/sync",
      tags,
      summary: "Pull and reconcile employees now (as the nightly reconciliation does)",
      security,
      responses: {
        200: jsonBody(SyncResult, "Pulled"),
        ...errorResponses,
        ...notFoundResponse,
        ...unavailableResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "integrations.hr_link.manage");
      const out = await withTenant(c, async (tx) => {
        await requireFlag(tx);
        const link = await hrConnection(tx);
        if (link?.status !== "connected") throw notConnected();
        await auditInTx(tx, access, {
          action: "integrations.hr_link.sync",
          resourceType: "integration_connection",
          resourceId: HR_LINK_PORT,
        });
        return pullAsSystem(c, tx, access.tenantId, link.settings);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/integrations/hr-link/locations",
      tags,
      summary: "This organisation's locations beside Thapsus-HR's, with the mapping",
      security,
      responses: {
        200: jsonBody(LocationMap, "Locations"),
        ...errorResponses,
        ...notFoundResponse,
        ...unavailableResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, READERS);
      const out = await withTenant(c, async (tx) => {
        await requireFlag(tx);
        const link = await hrConnection(tx);
        if (link?.status !== "connected") throw notConnected();
        const ours = await tx
          .select({ locationId: location.id, name: location.name })
          .from(location)
          .where(isNull(location.deletedAt));
        const maps = await tx
          .select({ locationId: hrLocationLink.locationId, hrId: hrLocationLink.hrLocationId })
          .from(hrLocationLink)
          .where(isNull(hrLocationLink.deletedAt));
        const theirs = await portFor(c, access.tenantId, link.settings).locations();
        return {
          harbour: ours.map((l) => ({
            ...l,
            hrLocationId: maps.find((m) => m.locationId === l.locationId)?.hrId ?? null,
          })),
          thapsusHr: theirs.ok ? theirs.value.map((l) => ({ id: l.id, name: l.name })) : [],
        };
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/integrations/hr-link/locations/{locationId}",
      tags,
      summary: "Map a location to a Thapsus-HR location, or clear its mapping (step-up)",
      security,
      request: {
        params: z.object({ locationId: z.uuid() }),
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  hrLocationId: z
                    .string()
                    .regex(/^[A-Za-z0-9_-]{1,64}$/)
                    .nullable(),
                })
                .strict(),
            },
          },
        },
      },
      responses: {
        204: { description: "Saved" },
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "integrations.hr_link.manage");
      const { locationId } = c.req.valid("param");
      const { hrLocationId } = c.req.valid("json");
      await withTenant(c, async (tx) => {
        await requireFlag(tx);
        const link = await hrConnection(tx);
        if (link?.status !== "connected") throw notConnected();
        const [place] = await tx
          .select({ id: location.id })
          .from(location)
          .where(and(eq(location.id, locationId), isNull(location.deletedAt)));
        if (!place) throw problems.notFound();
        if (hrLocationId) {
          const theirs = await portFor(c, access.tenantId, link.settings).locations();
          if (theirs.ok && !theirs.value.some((l) => l.id === hrLocationId)) {
            throw problems.invalid("Thapsus-HR has no location with that identifier.");
          }
        }
        await tx
          .update(hrLocationLink)
          .set({ deletedAt: new Date() })
          .where(and(eq(hrLocationLink.locationId, locationId), isNull(hrLocationLink.deletedAt)));
        if (hrLocationId) {
          try {
            await tx.transaction((sp) =>
              sp.insert(hrLocationLink).values({ locationId, hrLocationId }),
            );
          } catch {
            throw problems.conflict("That Thapsus-HR location is already mapped to another.");
          }
        }
        await auditInTx(tx, access, {
          action: "integrations.hr_link.location_mapped",
          resourceType: "location",
          resourceId: locationId,
          after: { hrLocationId },
        });
      });
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/integrations/hr-link/matches",
      tags,
      summary: "The match review queue: employees that could not be linked safely",
      security,
      responses: {
        200: jsonBody(z.object({ items: z.array(Match) }), "Matches to review"),
        ...errorResponses,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [
        "integrations.hr_link.review",
        "integrations.hr_link.manage",
      ]);
      const items = await withTenant(c, async (tx) => {
        await requireFlag(tx);
        const link = await hrConnection(tx);
        const rows = await tx
          .select()
          .from(hrPersonLink)
          .where(and(eq(hrPersonLink.state, "review"), isNull(hrPersonLink.deletedAt)))
          // Leavers first: an unlinked leaver keeps access until someone decides (rule 8).
          .orderBy(sql`${hrPersonLink.leavingOn} ASC NULLS LAST`, hrPersonLink.createdAt)
          .limit(100);
        const port =
          link?.status === "connected"
            ? c.get("services").hrLink.port(access.tenantId, link.settings)
            : null;
        const out = [];
        for (const r of rows) {
          const hr = port ? await port.employee(r.hrEmployeeId) : null;
          out.push({
            id: r.id,
            version: r.version,
            hrEmployeeId: r.hrEmployeeId,
            employeeNumber: r.employeeNumber,
            reason: r.reviewReason ?? "no_match",
            candidateStaffProfileId: r.staffProfileId,
            hrName: hr?.ok ? `${hr.value.givenName} ${hr.value.familyName}`.trim() : null,
            hrWorkEmail: hr?.ok ? hr.value.workEmail : null,
            leavingOn: r.leavingOn,
          });
        }
        await auditInTx(tx, access, {
          action: "integrations.hr_link.matches_viewed",
          resourceType: "hr_person_link",
          scope: { count: out.length },
        });
        return out;
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/integrations/hr-link/matches/{id}/confirm",
      tags,
      summary: "Confirm a match to a staff file (never your own; step-up)",
      description:
        "The staff file must be one the reviewer can see. When Thapsus-HR already gave a leaving date, only someone who manages that staff file may confirm, because confirming ends the member's access after that day.",
      security,
      request: {
        params: z.object({ id: z.uuid() }),
        body: {
          content: {
            "application/json": {
              schema: z
                .object({ staffProfileId: z.uuid(), expectedVersion: z.number().int() })
                .strict(),
            },
          },
        },
      },
      responses: {
        204: { description: "Linked" },
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "integrations.hr_link.review");
      // A match decides whose staff file Thapsus-HR's data reaches: a fresh step-up (HZ-133).
      if (!access.stepUpFresh) throw stepUpRefusal(access);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      await withTenant(c, async (tx) => {
        await requireFlag(tx);
        const [row] = await tx
          .select()
          .from(hrPersonLink)
          .where(
            and(
              eq(hrPersonLink.id, id),
              eq(hrPersonLink.state, "review"),
              isNull(hrPersonLink.deletedAt),
            ),
          );
        if (!row) throw problems.notFound();
        // The staff file as the reviewer sees it: one outside their reach is not found.
        const file = await tx
          .select({ id: staffProfile.id })
          .from(staffProfile)
          .where(and(eq(staffProfile.id, body.staffProfileId), isNull(staffProfile.deletedAt)));
        if (file.length === 0) throw problems.notFound();
        if (row.leavingOn) {
          const manages = await tx.execute<{ ok: boolean }>(
            sql`SELECT app.manages_staff_file_of(${body.staffProfileId}::uuid) AS ok`,
          );
          if (!manages.rows[0]?.ok) {
            throw new HttpProblem(
              403,
              "hr_link_leaver_needs_manager",
              "Thapsus-HR has a leaving date for this employee. Someone who manages the staff file confirms this match.",
            );
          }
        }
        const me = access.context.userId;
        try {
          const changed = await tx.transaction((sp) =>
            sp
              .update(hrPersonLink)
              .set({
                state: "linked",
                matchMethod: "manual",
                reviewReason: null,
                staffProfileId: body.staffProfileId,
                confirmedBy: me,
                confirmedAt: new Date(),
              })
              .where(and(eq(hrPersonLink.id, id), eq(hrPersonLink.version, body.expectedVersion)))
              .returning({ id: hrPersonLink.id }),
          );
          if (changed.length === 0) throw problems.conflict();
        } catch (error) {
          if (error instanceof HttpProblem) throw error;
          const text = String((error as { cause?: { message?: string } }).cause?.message ?? error);
          if (text.includes("hr_link_own_file")) {
            throw new HttpProblem(
              403,
              "hr_link_own_file",
              "Someone else confirms a match to your own staff file.",
            );
          }
          if (text.includes("hr_person_link_staff_key")) {
            throw problems.conflict("That staff file is already linked to another employee.");
          }
          throw error;
        }
        await auditInTx(tx, access, {
          action: "integrations.hr_link.match_confirmed",
          resourceType: "hr_person_link",
          resourceId: id,
          after: { staffProfileId: body.staffProfileId },
        });
        await publish(tx, {
          context: "integrations",
          aggregateType: "hr_person_link",
          aggregateId: id,
          type: "integrations.hr_link.person_linked",
          payload: { how: "manual" },
        });
        // A leaving date Thapsus-HR already gave applies now the person is linked (rule 8).
        const link = await hrConnection(tx);
        if (row.leavingOn && link?.status === "connected") {
          const port = c.get("services").hrLink.port(access.tenantId, link.settings);
          const employee = port ? await port.employee(row.hrEmployeeId) : null;
          if (employee?.ok) {
            await withSystemRights(tx, async () => {
              const now = new Date();
              await applyEmployee(tx, access.tenantId, link.settings.owners, employee.value, now);
              await endLeaversAccess(tx, access.tenantId, now);
            });
          }
        }
      });
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/integrations/hr-link/matches/{id}/reject",
      tags,
      summary: "Reject a match: the employee stays unlinked and is neither rostered nor sent",
      security,
      request: {
        params: z.object({ id: z.uuid() }),
        body: {
          content: {
            "application/json": {
              schema: z.object({ expectedVersion: z.number().int() }).strict(),
            },
          },
        },
      },
      responses: {
        204: { description: "Rejected" },
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "integrations.hr_link.review");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      await withTenant(c, async (tx) => {
        await requireFlag(tx);
        const changed = await tx
          .update(hrPersonLink)
          .set({
            state: "rejected",
            reviewReason: null,
            confirmedBy: access.context.userId,
            confirmedAt: new Date(),
          })
          .where(
            and(
              eq(hrPersonLink.id, id),
              eq(hrPersonLink.state, "review"),
              eq(hrPersonLink.version, body.expectedVersion),
            ),
          )
          .returning({ id: hrPersonLink.id });
        if (changed.length === 0) throw problems.conflict();
        await auditInTx(tx, access, {
          action: "integrations.hr_link.match_rejected",
          resourceType: "hr_person_link",
          resourceId: id,
        });
      });
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/integrations/hr-link/deliveries",
      tags,
      summary: "What was sent to Thapsus-HR, and what failed",
      security,
      responses: {
        200: jsonBody(z.object({ items: z.array(Delivery) }), "Deliveries"),
        ...errorResponses,
      },
    }),
    async (c) => {
      await requireAnyPermission(c, READERS);
      const items = await withTenant(c, async (tx) => {
        await requireFlag(tx);
        const rows = await tx
          .select()
          .from(hrDelivery)
          .orderBy(desc(hrDelivery.createdAt))
          .limit(200);
        return rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          harbourRef: r.harbourRef,
          hrId: r.hrId,
          state: r.state,
          attempts: r.attempts,
          lastErrorCode: r.lastErrorCode,
          sentAt: r.sentAt?.toISOString() ?? null,
        }));
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/integrations/hr-link/starters/{staffProfileId}",
      tags,
      summary: "Create a starter hired here as an employee in Thapsus-HR, once (step-up)",
      description:
        "Sends only the starter's listed fields: names, work email, date of birth, job title, location, contracted hours and start date. A retry returns the same employee.",
      security,
      request: {
        params: z.object({ staffProfileId: z.uuid() }),
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  givenName: z.string().trim().min(1).max(100),
                  familyName: z.string().trim().min(1).max(100),
                })
                .strict(),
            },
          },
        },
      },
      responses: {
        200: jsonBody(
          z.object({
            state: z.string(),
            hrId: z.string().nullable(),
            error: z.string().nullable(),
          }),
          "Delivery",
        ),
        ...errorResponses,
        ...notFoundResponse,
        ...unavailableResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "integrations.hr_link.manage");
      const { staffProfileId } = c.req.valid("param");
      const names = c.req.valid("json");
      const out = await withTenant(c, async (tx) => {
        await requireFlag(tx);
        const link = await hrConnection(tx);
        if (link?.status !== "connected") throw notConnected();
        if (link.settings.owners.recruitment_and_vetting !== "harbour") throw problems.forbidden();
        // The staff file as the caller sees it, never their own, and not already in Thapsus-HR.
        const [file] = await tx
          .select({
            locationId: staffProfile.locationId,
            tenantUserId: staffProfile.tenantUserId,
          })
          .from(staffProfile)
          .where(and(eq(staffProfile.id, staffProfileId), isNull(staffProfile.deletedAt)));
        if (!file) throw problems.notFound();
        if (file.tenantUserId === access.context.userId) throw problems.forbidden();
        const port = portFor(c, access.tenantId, link.settings);
        const result = await withSystemRights(tx, async () => {
          const [linked] = await tx
            .select({ id: hrPersonLink.id })
            .from(hrPersonLink)
            .where(
              and(
                eq(hrPersonLink.staffProfileId, staffProfileId),
                eq(hrPersonLink.state, "linked"),
                isNull(hrPersonLink.deletedAt),
              ),
            );
          const [sent] = await tx
            .select({ id: hrDelivery.id })
            .from(hrDelivery)
            .where(and(eq(hrDelivery.kind, "starter"), eq(hrDelivery.harbourRef, staffProfileId)));
          // A starter already sent answers as it did (rule 5); anyone else already linked is not one.
          if (linked && !sent) return { state: "refused", hrId: null, error: "already_linked" };
          const [mapped] = file.locationId
            ? await tx
                .select({ hrId: hrLocationLink.hrLocationId })
                .from(hrLocationLink)
                .where(
                  and(
                    eq(hrLocationLink.locationId, file.locationId),
                    isNull(hrLocationLink.deletedAt),
                  ),
                )
            : [];
          const starter = await starterFor(tx, staffProfileId, names, mapped?.hrId ?? null);
          if (!starter) return { state: "refused", hrId: null, error: "no_start_date" };
          return deliverStarter(
            tx,
            access.tenantId,
            port,
            link.settings,
            staffProfileId,
            starter,
            randomUUID(),
            new Date(),
          );
        });
        await auditInTx(tx, access, {
          action: "integrations.hr_link.starter_sent",
          outcome: result.state === "sent" ? "success" : "error",
          resourceType: "staff_profile",
          resourceId: staffProfileId,
          ...(result.error ? { reason: result.error } : {}),
        });
        return result;
      });
      if (out.error === "already_linked") {
        throw problems.conflict("This member is already linked to a Thapsus-HR employee.");
      }
      return c.json(out, 200);
    },
  );

/**
 * The signed webhook receiver (section 11.6), public: Thapsus-HR holds no session. Each
 * organisation's link has its own URL and signing secret. Throttled per address and per
 * organisation before any query. A bad signature, a replay or a link that is off gets one generic
 * answer (the same HMAC work either way); a body that fails its schema is quarantined; a good one
 * names an employee, whom Harbour then fetches (identifiers only). If that fetch fails nothing is
 * kept and Thapsus-HR is told to try again.
 */
export const hrLinkInboundRouter = createRouter().openapi(
  createRoute({
    method: "post",
    path: "/p/integrations/thapsus-hr/{tenantId}",
    tags,
    summary: "Thapsus-HR's signed employee webhooks (no session)",
    description:
      "The body is `{ id, type, employeeId, occurredAt }`, signed in the `Thapsus-Signature` header as `t=<unix seconds>,v1=<hex HMAC-SHA256 of t.body>`, within 5 minutes.",
    request: { params: z.object({ tenantId: z.uuid() }) },
    responses: {
      202: jsonBody(
        z.object({ status: z.enum(["accepted", "quarantined", "duplicate"]) }),
        "Taken",
      ),
      401: { description: "Not signed by this organisation's link" },
      429: { description: "Too many requests; wait as Retry-After says" },
      503: { description: "The employee could not be fetched; send the event again" },
    },
  }),
  async (c) => {
    const { tenantId } = c.req.valid("param");
    const services = c.get("services");
    const throttles = services.hrLink.webhookThrottles;
    const address = clientIp(c);
    const wait =
      (address ? throttles.address.take(address) : null) ?? throttles.tenant.take(tenantId);
    if (wait !== null) {
      const limited = new HttpProblem(429, "rate_limited", "Too many requests.");
      limited.retryAfterSeconds = wait;
      throw limited;
    }
    const raw = await c.req.text();
    const now = new Date();
    const header = c.req.header("thapsus-signature");
    const refuse = () => new HttpProblem(401, "unsigned", "Not accepted.");
    const retry = () =>
      new HttpProblem(503, "hr_link_retry", "The employee could not be fetched. Send it again.");
    const context = { tenantId, userId: null, scope: "tenant" as const, locationIds: [] };
    const outcome = await withRequestContext(services.db, context, async (tx) => {
      const [live] = await tx
        .select({ id: tenant.id })
        .from(tenant)
        .where(and(eq(tenant.id, tenantId), eq(tenant.status, "active")));
      const link = live && (await hrLinkEnabled(tx)) ? await hrConnection(tx) : null;
      const secret =
        link?.status === "connected" && link.secretRef
          ? await services.hrLink.webhookSecret(link.secretRef)
          : null;
      const refusal = signatureRefusal(header, raw, secret ?? DECOY_SECRET, now);
      if (!link || !secret) return null;
      if (refusal) {
        await tx.insert(auditEvent).values({
          tenantId,
          actorAuthUserId: "integration:thapsus_hr",
          actorRoleKeys: ["integration"],
          action: "integrations.hr_link.webhook",
          outcome: "denied",
          resourceType: "integration_connection",
          resourceId: HR_LINK_PORT,
          reason: refusal,
        });
        return "refused" as const;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { unparsed: true };
      }
      const eventId =
        typeof (payload as { id?: unknown } | null)?.id === "string"
          ? (payload as { id: string }).id.slice(0, 64)
          : null;
      let received: Awaited<ReturnType<typeof receiveInbound<typeof HrWebhookSchema>>>;
      try {
        received = await tx.transaction((sp) =>
          receiveInbound(
            sp,
            {
              port: HR_LINK_PORT,
              provider: "thapsus_hr",
              ...(eventId ? { externalId: eventId } : {}),
              // Identifiers only: anything else in the body is not kept (section 11.8).
              payload: HrWebhookSchema.safeParse(payload).success ? payload : { invalid: true },
            },
            HrWebhookSchema,
          ),
        );
      } catch (error) {
        // The same event already taken (a retry, or two at once).
        if (
          String((error as { cause?: unknown }).cause ?? error).includes(
            "integration_inbound_external_key",
          )
        ) {
          return "duplicate" as const;
        }
        throw error;
      }
      if (received.status === "quarantined") return "quarantined" as const;
      const port = services.hrLink.port(tenantId, link.settings);
      const employee = port ? await port.employee(received.data.employeeId) : null;
      // An employee Thapsus-HR no longer has: taken, and left to the reconciliation's
      // employee_missing check rather than retried for ever.
      if (employee && !employee.ok && employee.error === "not_found") return "accepted" as const;
      if (!port || !employee?.ok || (await ukRefusal(port, link.settings))) {
        // Nothing kept: Thapsus-HR sends it again, and the reconciliation catches it meanwhile.
        throw retry();
      }
      await applyEmployee(tx, tenantId, link.settings.owners, employee.value, now);
      await endLeaversAccess(tx, tenantId, now);
      return "accepted" as const;
    });
    if (outcome === null || outcome === "refused") throw refuse();
    return c.json({ status: outcome }, 202);
  },
);
