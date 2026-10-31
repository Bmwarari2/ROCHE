import {
  ApplyVettingCheck,
  RecordVettingConsent,
  RefreshVettingCheck,
  StaffFileVetting,
  StartVettingCheck,
  VETTING_RESULT_SCHEMAS,
  VettingConsent,
  VettingPortList,
  WithdrawVettingConsent,
} from "@harbour/contracts";
import {
  complianceItem,
  integrationConnection,
  type Transaction,
  tenantUser,
  vettingCheck,
  vettingConsent,
} from "@harbour/db";
import {
  type ComplianceDetail,
  complianceItemView,
  consentActive,
  ITEM_OF_CHECK,
  PORT_OF_CHECK,
  type StaffProfileFacts,
  ukIsoDate,
  VETTING_PORTS,
  type VettingAnswer,
  type VettingCheckKind,
  type VettingConsentPurpose,
  type VettingRequestMap,
  type VettingResultMap,
  vettingApplication,
  vettingCheckStillMatches,
  vettingRequestProblem,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { AuditedRefusal, withAuditedRefusal } from "../http/audit";
import {
  type AppEnv,
  requireAnyPermission,
  requirePermission,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { createVettingAdapter, type VettingConnection } from "../integrations/vetting";
import { staffNames } from "../services/staff";
import {
  type ComplianceItemRow,
  endItemReminders,
  loadStaffFile,
  nationOf,
  profileFacts,
  STAFF_FILE_SOURCE,
  type StaffProfileRow,
  storedItem,
  workforceRates,
} from "../services/staff-files";
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
 * Identity and vetting adapters (workforce.md section 2e and rule 24; WORK-002; ADR-0094; plan
 * slice 77). Read with workforce.staff_file.read or .manage, written with .manage and never on
 * one's own file; the database enforces the same (migration 0120). A port is off until the
 * organisation configures it (`PUT /v1/integrations/{port}`), and manual entry stays the default.
 * The vendor is called outside any transaction: the check is stored pending first, then its
 * answer. A result changes the staff file only when a person applies it. Audit events carry
 * opaque ids and codes only, never what was sent or answered.
 */

const READ = "workforce.staff_file.read";
const MANAGE = "workforce.staff_file.manage";
const A = {
  consentRecorded: "workforce.vetting_consent.recorded",
  consentWithdrawn: "workforce.vetting_consent.withdrawn",
  started: "workforce.vetting_check.started",
  refreshed: "workforce.vetting_check.refreshed",
  applied: "workforce.vetting_check.applied",
} as const;
const CHECK_SOURCE = "vetting_check";
const CONSENT_SOURCE = "vetting_consent";

const FileParam = z.object({ id: z.uuid() });
const ConsentParam = z.object({ id: z.uuid(), consentId: z.uuid() });
const CheckParam = z.object({ id: z.uuid(), checkId: z.uuid() });

type CheckRow = typeof vettingCheck.$inferSelect;
type ConsentRow = typeof vettingConsent.$inferSelect;

const MESSAGES: Record<string, [409 | 422 | 403, string]> = {
  own_file: [403, "Someone else makes the checks on your own staff file."],
  adapter_off: [
    409,
    "This check is not switched on for your organisation. Record it by hand with the evidence.",
  ],
  check_open: [409, "A check of this kind is already waiting for an answer."],
  consent_missing: [
    409,
    "Record the worker's consent before this DBS check. Without it, record the check by hand.",
  ],
  idsp_document_not_eligible: [
    422,
    "An identity service provider checks British and Irish passports only. Use the Home Office share code check, or record it by hand.",
  ],
  no_certificate_number: [422, "Record the DBS certificate's number first."],
  not_subscribed: [422, "The certificate is not on the Update Service."],
  no_date_of_birth: [422, "Record the worker's date of birth on the staff file first."],
  registration_not_nmc: [422, "This role is not on the NMC register."],
  no_pin: [422, "Record the NMC PIN first."],
  not_verified: [422, "The provider did not verify the worker's identity. Check it by hand."],
  application_withdrawn: [422, "The DBS application was withdrawn."],
  details_not_matched: [
    422,
    "The Update Service did not match those details. Check the surname and certificate number.",
  ],
  registration_has_conditions: [
    422,
    "Read the conditions on the NMC register and record the registration by hand.",
  ],
  not_registered: [422, "The NMC register has no current registration for that PIN."],
  item_changed: [409, "The staff file has changed since this check was made. Start a new check."],
  checked_in_future: [422, "The check's date is after today."],
  identity_not_confirmed: [
    422,
    "Confirm the photograph the provider matched is of the worker before applying it.",
  ],
  not_completed: [409, "This check has no answer to apply."],
  already_applied: [409, "This check has already been applied."],
  not_pending: [409, "This check is not waiting for an answer."],
  given_in_future: [422, "Consent is recorded on or before today."],
  withdrawn_before_given: [422, "A withdrawal is on or after the day the consent was given."],
  consent_in_force: [409, "The worker's consent for this is already recorded."],
  already_withdrawn: [409, "This consent has already been withdrawn."],
};

const refused = (action: string, resourceType: string, id: string | null, reason: string) => {
  const [status, title] = MESSAGES[reason] ?? [409, "That cannot be done now."];
  return new AuditedRefusal(new HttpProblem(status, reason, title), {
    action,
    outcome: "denied",
    resourceType,
    ...(id ? { resourceId: id } : {}),
    reason,
  });
};
const notFound = (action: string, resourceType: string, id: string) =>
  new AuditedRefusal(problems.notFound(), {
    action,
    outcome: "denied",
    resourceType,
    resourceId: id,
    reason: "not_found",
  });
const stale = (action: string, resourceType: string, id: string) =>
  new AuditedRefusal(problems.conflict(), {
    action,
    outcome: "denied",
    resourceType,
    resourceId: id,
    reason: "version_conflict",
  });

const today = () => ukIsoDate(new Date());
const production = (c: Context<AppEnv>) => c.get("services").config.NODE_ENV === "production";

async function connectionFor(tx: Transaction, port: string): Promise<VettingConnection | null> {
  const [row] = await tx
    .select({ provider: integrationConnection.provider, settings: integrationConnection.settings })
    .from(integrationConnection)
    .where(and(eq(integrationConnection.port, port), isNull(integrationConnection.deletedAt)));
  return row ? { provider: row.provider, settings: row.settings as Record<string, unknown> } : null;
}

async function portStates(c: Context<AppEnv>, tx: Transaction) {
  const rows = await tx
    .select({ port: integrationConnection.port, provider: integrationConnection.provider })
    .from(integrationConnection)
    .where(isNull(integrationConnection.deletedAt));
  return VETTING_PORTS.map((port) => {
    const row = rows.find((r) => r.port === port);
    const kind = (Object.keys(PORT_OF_CHECK) as VettingCheckKind[]).find(
      (k) => PORT_OF_CHECK[k] === port,
    ) as VettingCheckKind;
    const on =
      row !== undefined &&
      createVettingAdapter(
        kind,
        { provider: row.provider, settings: {} },
        {
          production: production(c),
        },
      ) !== null;
    return { port, on, provider: on ? (row?.provider ?? null) : null };
  });
}

async function fileFor(
  tx: Transaction,
  action: string,
  id: string,
  notOwnOf: string | null,
): Promise<{ profile: StaffProfileRow; items: ComplianceItemRow[] }> {
  const found = await loadStaffFile(tx, id);
  if (!found) throw notFound(action, STAFF_FILE_SOURCE, id);
  if (notOwnOf && found.profile.tenantUserId === notOwnOf) {
    throw refused(action, STAFF_FILE_SOURCE, id, "own_file");
  }
  return found;
}

const liveItem = (items: ComplianceItemRow[], kind: string) =>
  items.find((i) => i.kind === kind && i.deletedAt === null);

/** Whether a completed check could be applied today, and why not. */
function applicability(
  row: CheckRow,
  items: ComplianceItemRow[],
  on: string,
): { applicable: boolean; reason: string | null } {
  if (row.state !== "completed" || row.result === null) {
    return { applicable: false, reason: "not_completed" };
  }
  if (row.appliedAt !== null) return { applicable: false, reason: "already_applied" };
  const kind = row.kind as VettingCheckKind;
  const parsed = VETTING_RESULT_SCHEMAS[kind].safeParse(row.result);
  if (!parsed.success) return { applicable: false, reason: "not_completed" };
  const existing = (liveItem(items, ITEM_OF_CHECK[kind])?.detail ??
    null) as ComplianceDetail | null;
  if (!vettingCheckStillMatches(kind, row.checked as Record<string, string>, existing)) {
    return { applicable: false, reason: "item_changed" };
  }
  const outcome = vettingApplication(
    kind,
    parsed.data as VettingResultMap[typeof kind],
    existing,
    on,
  );
  return outcome.ok
    ? { applicable: true, reason: null }
    : { applicable: false, reason: outcome.problem };
}

async function vettingBody(
  c: Context<AppEnv>,
  tx: Transaction,
  profileId: string,
  items: ComplianceItemRow[],
) {
  const on = today();
  const consents = await tx
    .select()
    .from(vettingConsent)
    .where(eq(vettingConsent.staffProfileId, profileId))
    .orderBy(desc(vettingConsent.createdAt));
  const checks = await tx
    .select()
    .from(vettingCheck)
    .where(eq(vettingCheck.staffProfileId, profileId))
    .orderBy(desc(vettingCheck.createdAt));
  const names = await staffNames(tx, [
    ...consents.flatMap((r) => [r.recordedBy, r.withdrawnBy]),
    ...checks.flatMap((r) => [r.requestedBy, r.appliedBy]),
  ]);
  return StaffFileVetting.parse({
    consents: consents.map((r) => consentItem(r, names, on)),
    checks: checks.map((r) => {
      const { applicable, reason } = applicability(r, items, on);
      return {
        id: r.id,
        version: r.version,
        kind: r.kind,
        provider: r.provider,
        consentId: r.consentId,
        requestedBy: names(r.requestedBy),
        requestedAt: r.createdAt.toISOString(),
        checked: r.checked,
        state: r.state,
        result: r.result,
        error: r.error,
        completedAt: r.completedAt?.toISOString() ?? null,
        appliedAt: r.appliedAt?.toISOString() ?? null,
        appliedBy: names(r.appliedBy),
        applicable,
        notApplicableReason: applicable ? null : reason,
      };
    }),
    ports: await portStates(c, tx),
  });
}

function consentItem(r: ConsentRow, names: (id: string | null) => unknown, on: string) {
  return {
    id: r.id,
    version: r.version,
    purpose: r.purpose,
    givenOn: r.givenOn,
    recordedBy: names(r.recordedBy),
    withdrawnOn: r.withdrawnOn,
    withdrawnBy: names(r.withdrawnBy),
    inForce: consentActive(
      {
        purpose: r.purpose as VettingConsentPurpose,
        givenOn: r.givenOn,
        withdrawnOn: r.withdrawnOn,
      },
      on,
    ),
  };
}

/** Stores the adapter's answer on a pending check (the vendor was called outside the transaction). */
async function storeAnswer(
  tx: Transaction,
  checkId: string,
  answer: VettingAnswer<unknown>,
): Promise<void> {
  const values =
    answer.state === "completed"
      ? {
          state: "completed",
          externalReference: answer.externalReference,
          result: answer.result as object,
          error: null,
          completedAt: new Date(),
        }
      : answer.state === "failed"
        ? { state: "failed", error: answer.error, completedAt: new Date() }
        : { externalReference: answer.externalReference };
  await tx
    .update(vettingCheck)
    .set(values)
    .where(and(eq(vettingCheck.id, checkId), eq(vettingCheck.state, "pending")));
}

/** Database refusals said plainly; the policy and guard refusals are audited by the caller. */
function databaseRefusal(error: unknown, action: string, resourceType: string, id: string | null) {
  const code = dbCode(error);
  if (code === "42501") {
    return new AuditedRefusal(problems.forbidden(), {
      action,
      outcome: "denied",
      resourceType,
      ...(id ? { resourceId: id } : {}),
      reason: "refused_by_database",
    });
  }
  if (code === "23505") return refused(action, resourceType, id, "check_open");
  if (code === "23514" || code === "23000") {
    return refused(action, resourceType, id, "consent_missing");
  }
  return null;
}

async function run<T>(
  c: Context<AppEnv>,
  access: TenantAccess,
  action: string,
  resourceType: string,
  id: string | null,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return withAuditedRefusal(c, access, async () => {
    try {
      return await withTenant(c, fn);
    } catch (error) {
      if (error instanceof AuditedRefusal) throw error;
      const mapped = databaseRefusal(error, action, resourceType, id);
      if (mapped) throw mapped;
      throw error;
    }
  });
}

export const vettingRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/vetting/ports",
      tags: ["workforce"],
      summary: "Which vetting ports are switched on",
      description: `${READ} or ${MANAGE}. Each vetting port (ADR-0094) and its provider when the organisation has switched it on; every port is off by default.`,
      security,
      responses: { 200: jsonBody(VettingPortList, "Ports"), ...errorResponses },
    }),
    async (c) => {
      await requireAnyPermission(c, [READ, MANAGE]);
      const items = await withTenant(c, (tx) => portStates(c, tx));
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/staff-files/{id}/vetting",
      tags: ["workforce"],
      summary: "A staff file's vetting consents and checks",
      description: `${READ} or ${MANAGE}. The worker's consents, the checks made through the vetting ports with their answers, whether each can be applied, and which ports are on.`,
      security,
      request: { params: FileParam },
      responses: {
        200: jsonBody(StaffFileVetting, "Consents and checks"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [READ, MANAGE]);
      const { id } = c.req.valid("param");
      const body = await run(
        c,
        access,
        "workforce.staff_file.viewed",
        STAFF_FILE_SOURCE,
        id,
        async (tx) => {
          const { items } = await fileFor(tx, "workforce.staff_file.viewed", id, null);
          return vettingBody(c, tx, id, items);
        },
      );
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/staff-files/{id}/vetting/consents",
      tags: ["workforce"],
      summary: "Record the worker's consent to a DBS check",
      description: `${MANAGE}, never on one's own file. The worker's consent to a DBS application or to Update Service status checks, given on or before today, in the caller's name. 409 while one is in force. Audited.`,
      security,
      request: {
        params: FileParam,
        body: { content: { "application/json": { schema: RecordVettingConsent } } },
      },
      responses: {
        201: jsonBody(VettingConsent, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const on = today();
      const saved = await run(c, access, A.consentRecorded, CONSENT_SOURCE, null, async (tx) => {
        await fileFor(tx, A.consentRecorded, id, access.tenantUserId);
        if (body.givenOn > on)
          throw refused(A.consentRecorded, CONSENT_SOURCE, null, "given_in_future");
        let row: ConsentRow | undefined;
        try {
          [row] = await tx
            .insert(vettingConsent)
            .values({
              staffProfileId: id,
              purpose: body.purpose,
              givenOn: body.givenOn,
              recordedBy: access.tenantUserId,
            })
            .returning();
        } catch (error) {
          if (dbCode(error) === "23505") {
            throw refused(A.consentRecorded, CONSENT_SOURCE, null, "consent_in_force");
          }
          throw error;
        }
        if (!row) throw new Error("consent not stored");
        await audit(c, tx, access, {
          action: A.consentRecorded,
          resourceType: CONSENT_SOURCE,
          resourceId: row.id,
          scopeExtra: { staffProfileId: id, purpose: body.purpose },
        });
        const names = await staffNames(tx, [row.recordedBy]);
        return consentItem(row, names, on);
      });
      return c.json(VettingConsent.parse(saved), 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/staff-files/{id}/vetting/consents/{consentId}/withdraw",
      tags: ["workforce"],
      summary: "Record that the worker withdrew their consent",
      description: `${MANAGE}, never on one's own file. Once, in the caller's name, on a day from when it was given until today. Checks then need a new consent. Audited.`,
      security,
      request: {
        params: ConsentParam,
        body: { content: { "application/json": { schema: WithdrawVettingConsent } } },
      },
      responses: {
        200: jsonBody(VettingConsent, "Withdrawn"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id, consentId } = c.req.valid("param");
      const body = c.req.valid("json");
      const on = today();
      const saved = await run(
        c,
        access,
        A.consentWithdrawn,
        CONSENT_SOURCE,
        consentId,
        async (tx) => {
          await fileFor(tx, A.consentWithdrawn, id, access.tenantUserId);
          const [found] = await tx
            .select()
            .from(vettingConsent)
            .where(and(eq(vettingConsent.id, consentId), eq(vettingConsent.staffProfileId, id)));
          if (!found) throw notFound(A.consentWithdrawn, CONSENT_SOURCE, consentId);
          if (found.withdrawnOn !== null) {
            throw refused(A.consentWithdrawn, CONSENT_SOURCE, consentId, "already_withdrawn");
          }
          if (found.version !== body.expectedVersion) {
            throw stale(A.consentWithdrawn, CONSENT_SOURCE, consentId);
          }
          if (body.withdrawnOn > on) {
            throw refused(A.consentWithdrawn, CONSENT_SOURCE, consentId, "given_in_future");
          }
          if (body.withdrawnOn < found.givenOn) {
            throw refused(A.consentWithdrawn, CONSENT_SOURCE, consentId, "withdrawn_before_given");
          }
          const [row] = await tx
            .update(vettingConsent)
            .set({ withdrawnOn: body.withdrawnOn, withdrawnBy: access.tenantUserId })
            .where(
              and(
                eq(vettingConsent.id, consentId),
                eq(vettingConsent.version, body.expectedVersion),
              ),
            )
            .returning();
          if (!row) throw stale(A.consentWithdrawn, CONSENT_SOURCE, consentId);
          await audit(c, tx, access, {
            action: A.consentWithdrawn,
            resourceType: CONSENT_SOURCE,
            resourceId: consentId,
            scopeExtra: { staffProfileId: id },
          });
          const names = await staffNames(tx, [row.recordedBy, row.withdrawnBy]);
          return consentItem(row, names, on);
        },
      );
      return c.json(VettingConsent.parse(saved), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/staff-files/{id}/vetting/checks",
      tags: ["workforce"],
      summary: "Start a vetting check",
      description: `${MANAGE}, never on one's own file. Starts a check through its port's adapter (workforce.md rule 24): 409 adapter_off when the organisation has not switched the port on, consent_missing for a DBS check without the worker's consent in force. The provider is sent only the port's declared fields. Audited.`,
      security,
      request: {
        params: FileParam,
        body: { content: { "application/json": { schema: StartVettingCheck } } },
      },
      responses: {
        201: jsonBody(StaffFileVetting, "Started"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const kind = body.kind;
      const on = today();
      const opts = { production: production(c) };
      // 1. Check the rules and store the check, pending.
      const prepared = await run(c, access, A.started, CHECK_SOURCE, null, async (tx) => {
        const { profile, items } = await fileFor(tx, A.started, id, access.tenantUserId);
        const connection = await connectionFor(tx, PORT_OF_CHECK[kind]);
        const adapter = createVettingAdapter(kind, connection, opts);
        const consents = await tx
          .select()
          .from(vettingConsent)
          .where(eq(vettingConsent.staffProfileId, id));
        const [open] = await tx
          .select({ id: vettingCheck.id })
          .from(vettingCheck)
          .where(
            and(
              eq(vettingCheck.staffProfileId, id),
              eq(vettingCheck.kind, kind),
              eq(vettingCheck.state, "pending"),
            ),
          );
        const dbs = liveItem(items, "dbs_certificate")?.detail as
          | Extract<ComplianceDetail, { kind: "dbs_certificate" }>
          | undefined;
        const registration = liveItem(items, "professional_registration")?.detail as
          | Extract<ComplianceDetail, { kind: "professional_registration" }>
          | undefined;
        const problem = vettingRequestProblem(
          {
            kind,
            ownFile: false,
            adapterOn: adapter !== null,
            consents: consents.map((r) => ({
              purpose: r.purpose as VettingConsentPurpose,
              givenOn: r.givenOn,
              withdrawnOn: r.withdrawnOn,
            })),
            idspDocument: body.kind === "idsp_right_to_work" ? body.document : null,
            dbs: dbs ?? null,
            dateOfBirth: profile.dateOfBirth,
            registrationBody: profile.registrationBody,
            pin: registration?.pin ?? null,
            openCheck: open !== undefined,
          },
          on,
        );
        if (problem || !adapter || !connection) {
          throw refused(A.started, CHECK_SOURCE, null, problem ?? "adapter_off");
        }
        const consent = consents.find(
          (r) =>
            r.purpose === (kind === "dbs_application" ? "dbs_application" : "dbs_update_service") &&
            consentActive(
              {
                purpose: r.purpose as VettingConsentPurpose,
                givenOn: r.givenOn,
                withdrawnOn: r.withdrawnOn,
              },
              on,
            ),
        );
        const checked =
          body.kind === "idsp_right_to_work"
            ? { document: body.document }
            : kind === "dbs_status_check"
              ? { certificateNumber: dbs?.certificate?.number }
              : kind === "nmc_register_check"
                ? { pin: registration?.pin }
                : {};
        const [row] = await tx
          .insert(vettingCheck)
          .values({
            staffProfileId: id,
            kind,
            provider: connection.provider,
            consentId:
              kind === "dbs_application" || kind === "dbs_status_check"
                ? (consent?.id ?? null)
                : null,
            requestedBy: access.tenantUserId,
            checked,
          })
          .returning();
        if (!row) throw new Error("check not stored");
        const [member] = await tx
          .select({ name: tenantUser.displayName, email: tenantUser.email })
          .from(tenantUser)
          .where(eq(tenantUser.id, profile.tenantUserId));
        const name = member?.name ?? "";
        const email = member?.email ?? "";
        const request: VettingRequestMap[VettingCheckKind] =
          body.kind === "idsp_right_to_work"
            ? { reference: row.id, name, email, document: body.document }
            : body.kind === "dbs_application"
              ? {
                  reference: row.id,
                  name,
                  email,
                  level: "enhanced_adults_barred",
                  workforce: "adult",
                  jobTitle: profile.jobTitle,
                }
              : body.kind === "dbs_status_check"
                ? {
                    reference: row.id,
                    certificateNumber: dbs?.certificate?.number ?? "",
                    familyName: body.familyName,
                    dateOfBirth: profile.dateOfBirth ?? "",
                  }
                : { reference: row.id, pin: registration?.pin ?? "" };
        await audit(c, tx, access, {
          action: A.started,
          resourceType: CHECK_SOURCE,
          resourceId: row.id,
          scopeExtra: { staffProfileId: id, kind, provider: connection.provider },
        });
        return { checkId: row.id, adapter, request };
      });
      // 2. Ask the provider, outside any transaction.
      const answer = await prepared.adapter.start(prepared.request as never);
      // 3. Store its answer.
      const result = await withTenant(c, async (tx) => {
        await storeAnswer(tx, prepared.checkId, answer);
        const found = await loadStaffFile(tx, id);
        return vettingBody(c, tx, id, found?.items ?? []);
      });
      return c.json(result, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/staff-files/{id}/vetting/checks/{checkId}/refresh",
      tags: ["workforce"],
      summary: "Ask again about a pending vetting check",
      description: `${MANAGE}, never on one's own file. Asks the port's adapter about a check still waiting for an answer, and stores it. 409 when the port has been switched off since. Audited.`,
      security,
      request: {
        params: CheckParam,
        body: { content: { "application/json": { schema: RefreshVettingCheck } } },
      },
      responses: {
        200: jsonBody(StaffFileVetting, "Asked"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id, checkId } = c.req.valid("param");
      const body = c.req.valid("json");
      const opts = { production: production(c) };
      const prepared = await run(c, access, A.refreshed, CHECK_SOURCE, checkId, async (tx) => {
        await fileFor(tx, A.refreshed, id, access.tenantUserId);
        const [row] = await tx
          .select()
          .from(vettingCheck)
          .where(and(eq(vettingCheck.id, checkId), eq(vettingCheck.staffProfileId, id)));
        if (!row) throw notFound(A.refreshed, CHECK_SOURCE, checkId);
        if (row.version !== body.expectedVersion) throw stale(A.refreshed, CHECK_SOURCE, checkId);
        if (row.state !== "pending" || !row.externalReference) {
          throw refused(A.refreshed, CHECK_SOURCE, checkId, "not_pending");
        }
        const kind = row.kind as VettingCheckKind;
        const connection = await connectionFor(tx, PORT_OF_CHECK[kind]);
        const adapter =
          connection && connection.provider === row.provider
            ? createVettingAdapter(kind, connection, opts)
            : null;
        if (!adapter) throw refused(A.refreshed, CHECK_SOURCE, checkId, "adapter_off");
        await audit(c, tx, access, {
          action: A.refreshed,
          resourceType: CHECK_SOURCE,
          resourceId: checkId,
          scopeExtra: { staffProfileId: id, kind },
        });
        return { adapter, externalReference: row.externalReference };
      });
      const answer = await prepared.adapter.status(prepared.externalReference);
      const result = await withTenant(c, async (tx) => {
        await storeAnswer(tx, checkId, answer);
        const found = await loadStaffFile(tx, id);
        return vettingBody(c, tx, id, found?.items ?? []);
      });
      return c.json(result, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/staff-files/{id}/vetting/checks/{checkId}/apply",
      tags: ["workforce"],
      summary: "Apply a vetting check's answer to the staff file",
      description: `${MANAGE}, never on one's own file. Applies a completed check to its item (workforce.md rule 24), verified in the caller's name on the check's date, with the check as the item's evidence source. Outcomes that are not evidence are refused and the item stays as it was. An IDSP check needs the caller to confirm the photograph is of the worker. Audited.`,
      security,
      request: {
        params: CheckParam,
        body: { content: { "application/json": { schema: ApplyVettingCheck } } },
      },
      responses: {
        200: jsonBody(StaffFileVetting, "Applied"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id, checkId } = c.req.valid("param");
      const body = c.req.valid("json");
      const on = today();
      const result = await run(c, access, A.applied, CHECK_SOURCE, checkId, async (tx) => {
        const { profile, items } = await fileFor(tx, A.applied, id, access.tenantUserId);
        const [row] = await tx
          .select()
          .from(vettingCheck)
          .where(and(eq(vettingCheck.id, checkId), eq(vettingCheck.staffProfileId, id)));
        if (!row) throw notFound(A.applied, CHECK_SOURCE, checkId);
        if (row.version !== body.expectedVersion) throw stale(A.applied, CHECK_SOURCE, checkId);
        const kind = row.kind as VettingCheckKind;
        const itemKind = ITEM_OF_CHECK[kind];
        const existing = liveItem(items, itemKind);
        if (existing && body.itemExpectedVersion !== existing.version) {
          throw stale(A.applied, CHECK_SOURCE, checkId);
        }
        const { applicable, reason } = applicability(row, items, on);
        if (!applicable) throw refused(A.applied, CHECK_SOURCE, checkId, reason ?? "not_completed");
        if (kind === "idsp_right_to_work" && !body.identityConfirmed) {
          throw refused(A.applied, CHECK_SOURCE, checkId, "identity_not_confirmed");
        }
        const parsed = VETTING_RESULT_SCHEMAS[kind].parse(row.result);
        const outcome = vettingApplication(
          kind,
          parsed as VettingResultMap[typeof kind],
          (existing?.detail ?? null) as ComplianceDetail | null,
          on,
        );
        if (!outcome.ok) throw refused(A.applied, CHECK_SOURCE, checkId, outcome.problem);
        // The check is applied first, so the item's source guard finds it applied by the caller.
        const [applied] = await tx
          .update(vettingCheck)
          .set({ appliedAt: new Date(), appliedBy: access.tenantUserId })
          .where(and(eq(vettingCheck.id, checkId), eq(vettingCheck.version, row.version)))
          .returning();
        if (!applied) throw stale(A.applied, CHECK_SOURCE, checkId);
        const rates = await workforceRates(
          tx,
          access.tenantId,
          await nationOf(tx, profile.locationId),
          on,
        );
        const facts: StaffProfileFacts = profileFacts(profile);
        const draft = {
          ...(existing ?? {}),
          detail: outcome.detail,
          verifiedOn: outcome.verifiedOn,
          verifiedBy: access.tenantUserId,
          riskAssessmentSignedOn: existing?.riskAssessmentSignedOn ?? null,
          riskAssessmentSignedBy: existing?.riskAssessmentSignedBy ?? null,
        } as ComplianceItemRow;
        const view = complianceItemView(storedItem(draft), facts, on, rates);
        const values = {
          detail: outcome.detail,
          verifiedOn: outcome.verifiedOn,
          verifiedBy: access.tenantUserId,
          expiresOn: view.expiresOn,
          recheckDueOn: view.recheckDueOn,
          evidenceSource: kind,
          vettingCheckId: checkId,
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
          if (!saved) throw stale(A.applied, CHECK_SOURCE, checkId);
          if (
            (existing.expiresOn ?? existing.recheckDueOn) !==
            (saved.expiresOn ?? saved.recheckDueOn)
          ) {
            await endItemReminders(tx, saved.id);
          }
        } else {
          [saved] = await tx
            .insert(complianceItem)
            .values({ staffProfileId: id, kind: itemKind, ...values })
            .returning();
        }
        if (!saved) throw new Error("compliance item not stored");
        await audit(c, tx, access, {
          action: A.applied,
          resourceType: CHECK_SOURCE,
          resourceId: checkId,
          scopeExtra: { staffProfileId: id, kind, complianceItemId: saved.id },
        });
        const all = items.filter((i) => i.id !== saved.id).concat(saved);
        return vettingBody(c, tx, id, all);
      });
      return c.json(result, 200);
    },
  );
