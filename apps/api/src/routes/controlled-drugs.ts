import { randomUUID } from "node:crypto";
import {
  AssertWitness,
  CdPageDetail,
  CdPageList,
  CdPageSummary,
  CdRecorderList,
  CdWaitingAssertions,
  OpenCdPage,
  RecordCdEntry,
  RecordStockCheck,
  StockCheckRecorded,
  WitnessAssertionOut,
} from "@harbour/contracts";
import {
  controlledDrugPage,
  controlledDrugStockCheck,
  controlledDrugWitnessAssertion,
  medication,
  type Transaction,
  tenantUser,
} from "@harbour/db";
import {
  type CdWitnessPolicy,
  cdStockCheck,
  cdStockCheckDueAt,
  isDoseQuantity,
  ukIsoDate,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { AuditedRefusal, auditInTx, withAuditedRefusal } from "../http/audit";
import {
  type AppEnv,
  requireAnyPermission,
  requirePermission,
  stepUpFresh,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { publish } from "../outbox";
import {
  assertionProblem,
  cdEntryOf,
  type PageRow,
  pageEntries,
  pageFor,
  type StockCheckRow,
  stockCheckOut,
  witnessPolicyFor,
  writeCdEntry,
} from "../services/controlled-drugs";
import { medicinesRates } from "../services/medicine-administrations";
import { guardConcurrent, lockPerson, personEntries } from "../services/medicines";
import { loadPerson } from "../services/people";
import { rateNumber } from "../services/rates";
import { permissionHolders, withTenantWideScope } from "../services/safety";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";

/**
 * The controlled drugs register (Phase 2 slice 34; MEDS-005; medicines.md section 14; ADR-0083).
 * Slice 3's rules decide every entry; the database checks the running balance again. Recording
 * needs `medicines.cd.administer` and a fresh step-up; the witness signs first with
 * `medicines.cd.witness`, their own session and step-up (ADR-0084). A stock check that does not
 * balance publishes an event the safety module turns into an incident. Audit by id only.
 */

const tags = ["medicines"];
const ADMINISTER = "medicines.cd.administer" as const;
const WITNESS = "medicines.cd.witness" as const;
const READERS = [
  ADMINISTER,
  WITNESS,
  "medicines.record.manage",
  "medicines.emar.administer",
  "care.plan.read",
] as const;
const PersonParam = z.object({ id: z.uuid() });
const PageParam = z.object({ pageId: z.uuid() });
const ASSERTION_MINUTES = "medicines.cd.witness_assertion_minutes";

function audit(
  c: Context<AppEnv>,
  tx: Transaction,
  access: TenantAccess,
  input: Parameters<typeof auditInTx>[2],
) {
  return auditInTx(tx, access, { ...input, requestId: c.get("requestId") });
}

function refusal(issues: readonly { problem: string; message: string }[]): HttpProblem {
  return new HttpProblem(
    422,
    `cd_${issues[0]?.problem ?? "refused"}`,
    "The controlled drugs register cannot take this.",
    issues.map((i) => i.message).join(" "),
  );
}

/** A step-up refused is audited like any other refusal (ADR-0084). */
function requireStepUp(access: TenantAccess, action: string, resourceId: string) {
  if (!stepUpFresh(access)) {
    throw new AuditedRefusal(problems.stepUp(), {
      action,
      outcome: "denied",
      resourceType: "controlled_drug_page",
      resourceId,
      scope: { problems: ["step_up_required"] },
    });
  }
}

/** A page within the caller's scope (RLS), under its person's lock. */
async function lockedPage(tx: Transaction, pageId: string): Promise<PageRow> {
  const [first] = await tx
    .select({ personId: controlledDrugPage.personId })
    .from(controlledDrugPage)
    .where(eq(controlledDrugPage.id, pageId));
  if (!first) throw problems.notFound();
  await lockPerson(tx, first.personId);
  const [page] = await tx
    .select()
    .from(controlledDrugPage)
    .where(eq(controlledDrugPage.id, pageId));
  return page as PageRow;
}

async function summary(
  tx: Transaction,
  page: PageRow,
  policy: CdWitnessPolicy,
  stockCheckIntervalDays: number,
) {
  const entries = await pageEntries(tx, page.id);
  const [last] = await tx
    .select()
    .from(controlledDrugStockCheck)
    .where(eq(controlledDrugStockCheck.pageId, page.id))
    .orderBy(desc(controlledDrugStockCheck.checkedAt))
    .limit(1);
  return {
    id: page.id,
    personId: page.personId,
    vmpId: page.vmpId,
    productName: page.productName,
    unit: { code: page.unitCode, name: page.unitName },
    balance: Number(entries.at(-1)?.balanceAfter ?? 0),
    lastStockCheck: last ? stockCheckOut(last, page.unitName) : null,
    // Counted from the last check, or from when the page was opened if it has never been checked
    // (slice 34 clinical review M3).
    nextStockCheckDueAt: cdStockCheckDueAt(last?.checkedAt ?? page.openedAt, {
      cdStockCheckIntervalDays: stockCheckIntervalDays,
    }).toISOString(),
    witnessPolicy: policy,
  };
}

export const controlledDrugsRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/controlled-drugs",
      tags,
      summary: "A person's controlled drugs register pages",
      description:
        "Each page (drug, form and strength) with its balance, its last stock check and when the next is due. Audited.",
      security,
      request: { params: PersonParam },
      responses: { 200: jsonBody(CdPageList, "The pages"), ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [...READERS]);
      const { id: personId } = c.req.valid("param");
      const out = await withTenant(c, async (tx) => {
        const person = await loadPerson(tx, personId);
        const rates = await medicinesRates(
          tx,
          access.tenantId,
          person.nation,
          ukIsoDate(new Date()),
        );
        const policy = await witnessPolicyFor(tx, person.locationId);
        const pages = await tx
          .select()
          .from(controlledDrugPage)
          .where(eq(controlledDrugPage.personId, personId))
          .orderBy(asc(controlledDrugPage.productName));
        const list = [];
        for (const p of pages)
          list.push(await summary(tx, p, policy, rates.cdStockCheckIntervalDays));
        await audit(c, tx, access, {
          action: "medicines.cd.viewed",
          resourceType: "person",
          resourceId: personId,
          scope: { pages: pages.length },
        });
        return { pages: list };
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/controlled-drugs/pages",
      tags,
      summary: "Open the register page for a controlled drug on the MAR",
      description:
        "One page per person and dm+d product (drug, form and strength), taking the product and dose unit from the MAR entry, whose dm+d controlled drug schedule must be set. Returns the existing page if there is one. Audited.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: OpenCdPage } } },
      },
      responses: {
        200: jsonBody(CdPageSummary, "The page"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, ADMINISTER);
      const { id: personId } = c.req.valid("param");
      const { entryId } = c.req.valid("json");
      const out = await withTenant(c, async (tx) => {
        const person = await loadPerson(tx, personId);
        await lockPerson(tx, personId);
        const stored = (await personEntries(tx, personId)).find((s) => s.entry.id === entryId);
        if (!stored) throw problems.notFound();
        const [row] = await tx
          .select({ cd: medication.cdSchedule })
          .from(medication)
          .where(eq(medication.id, entryId));
        if (!row?.cd) {
          throw problems.invalid(
            "This medicine is not a controlled drug, so it has no register page.",
          );
        }
        const { page, opened } = await pageFor(tx, stored.entry, access.tenantUserId);
        if (opened) {
          await audit(c, tx, access, {
            action: "medicines.cd.page_opened",
            resourceType: "controlled_drug_page",
            resourceId: page.id,
            scope: { personId },
          });
        }
        const rates = await medicinesRates(
          tx,
          access.tenantId,
          person.nation,
          ukIsoDate(new Date()),
        );
        return summary(
          tx,
          page,
          await witnessPolicyFor(tx, person.locationId),
          rates.cdStockCheckIntervalDays,
        );
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/controlled-drugs/pages/{pageId}",
      tags,
      summary: "A register page: its entries in order, corrections beside them, and stock checks",
      description: "Audited.",
      security,
      request: { params: PageParam },
      responses: {
        200: jsonBody(CdPageDetail, "The page"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [...READERS]);
      const { pageId } = c.req.valid("param");
      const out = await withTenant(c, async (tx) => {
        const [page] = await tx
          .select()
          .from(controlledDrugPage)
          .where(eq(controlledDrugPage.id, pageId));
        if (!page) throw problems.notFound();
        const person = await loadPerson(tx, page.personId);
        const rates = await medicinesRates(
          tx,
          access.tenantId,
          person.nation,
          ukIsoDate(new Date()),
        );
        const entries = await pageEntries(tx, page.id);
        const checks = await tx
          .select()
          .from(controlledDrugStockCheck)
          .where(eq(controlledDrugStockCheck.pageId, page.id))
          .orderBy(asc(controlledDrugStockCheck.checkedAt));
        await audit(c, tx, access, {
          action: "medicines.cd.viewed",
          resourceType: "controlled_drug_page",
          resourceId: page.id,
          scope: { personId: page.personId, entries: entries.length },
        });
        // Everyone who signed the page, by name, for the screens and the print (slice 54).
        const signers = [
          ...new Set(
            [
              ...entries.flatMap((r) => [r.recordedBy, r.witnessId]),
              ...checks.flatMap((s) => [s.checkedBy, s.witnessId]),
            ].filter((v): v is string => !!v),
          ),
        ];
        const people =
          signers.length === 0
            ? []
            : await tx
                .select({ id: tenantUser.id, name: tenantUser.displayName })
                .from(tenantUser)
                .where(inArray(tenantUser.id, signers));
        return {
          people,
          ...(await summary(
            tx,
            page,
            await witnessPolicyFor(tx, person.locationId),
            rates.cdStockCheckIntervalDays,
          )),
          entries: entries.map((r) => {
            const e = cdEntryOf(page, r);
            return {
              id: r.id,
              seq: r.seq,
              movement: e.movement,
              quantity: e.quantity,
              balanceAfter: e.balanceAfter,
              correctsId: e.correctsId,
              corrects: e.corrects,
              reason: e.reason,
              counterparty: r.counterparty,
              reference: r.reference,
              occurredAt: r.occurredAt.toISOString(),
              recorded: { id: r.recordedBy, at: r.recordedAt.toISOString() },
              witnessId: r.witnessId,
              noWitnessReason: r.noWitnessReason,
              flags: [...r.flags],
              administrationId: r.administrationId,
              correctedBy: entries.filter((x) => x.correctsId === r.id).map((x) => x.id),
            };
          }),
          stockChecks: checks.map((s: StockCheckRow) => stockCheckOut(s, page.unitName)),
        };
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/controlled-drugs/pages/{pageId}/recorders",
      tags,
      summary: "Who a witness may sign for on this page",
      description:
        "Members who may record controlled drugs at the person's home (medicines.cd.administer there), never the witness themselves, by name: for choosing whom they watched (ADR-0084 on the web; slice 54). Not audited: no register content is read.",
      security,
      request: { params: PageParam },
      responses: {
        200: jsonBody(CdRecorderList, "Recorders"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, WITNESS);
      const { pageId } = c.req.valid("param");
      const recorders = await withTenant(c, async (tx) => {
        const [page] = await tx
          .select({ personId: controlledDrugPage.personId })
          .from(controlledDrugPage)
          .where(eq(controlledDrugPage.id, pageId));
        if (!page) throw problems.notFound();
        const person = await loadPerson(tx, page.personId);
        return withTenantWideScope(tx, async () => {
          const ids = (
            await permissionHolders(tx, ADMINISTER, person.locationId, new Date())
          ).filter((id) => id !== access.tenantUserId);
          if (ids.length === 0) return [];
          const rows = await tx
            .select({ id: tenantUser.id, name: tenantUser.displayName })
            .from(tenantUser)
            .where(inArray(tenantUser.id, ids));
          return rows.sort((a, b) => a.name.localeCompare(b.name));
        });
      });
      return c.json({ recorders }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/controlled-drugs/pages/{pageId}/witness-assertions",
      tags,
      summary: "The witness signatures waiting for you on this page",
      description:
        "Unused, unexpired witness signatures on this page that name the signed-in member as recorder, with the witness's name, the movement and the quantity they signed for: the recorder chooses one when recording (ADR-0084 on the web; slice 54). Never another recorder's.",
      security,
      request: { params: PageParam },
      responses: {
        200: jsonBody(CdWaitingAssertions, "Signatures waiting"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [ADMINISTER, "medicines.stock.manage"]);
      const { pageId } = c.req.valid("param");
      const now = new Date();
      const assertions = await withTenant(c, async (tx) => {
        const [page] = await tx
          .select({ id: controlledDrugPage.id })
          .from(controlledDrugPage)
          .where(eq(controlledDrugPage.id, pageId));
        if (!page) throw problems.notFound();
        const rows = await tx
          .select({
            id: controlledDrugWitnessAssertion.id,
            movement: controlledDrugWitnessAssertion.movement,
            quantity: controlledDrugWitnessAssertion.quantity,
            expiresAt: controlledDrugWitnessAssertion.expiresAt,
            witnessName: tenantUser.displayName,
          })
          .from(controlledDrugWitnessAssertion)
          .innerJoin(tenantUser, eq(tenantUser.id, controlledDrugWitnessAssertion.witnessId))
          .where(
            and(
              eq(controlledDrugWitnessAssertion.pageId, pageId),
              eq(controlledDrugWitnessAssertion.recorderId, access.tenantUserId),
              isNull(controlledDrugWitnessAssertion.usedAt),
              gt(controlledDrugWitnessAssertion.expiresAt, now),
            ),
          )
          .orderBy(desc(controlledDrugWitnessAssertion.assertedAt));
        return rows.map((r) => ({
          id: r.id,
          movement: r.movement as "receipt",
          quantity: Number(r.quantity),
          witnessName: r.witnessName,
          expiresAt: r.expiresAt.toISOString(),
        }));
      });
      return c.json({ assertions }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/controlled-drugs/pages/{pageId}/witness-assertions",
      tags,
      summary: "Sign as witness for what you saw (ADR-0084)",
      description:
        "The witness, with their own session, a fresh step-up and current medicines competence, signs for the movement and quantity they saw (and the administration, for a dose). The recorder's entry names the signature, which expires after medicines.cd.witness_assertion_minutes and is used once. Audited.",
      security,
      request: {
        params: PageParam,
        body: { content: { "application/json": { schema: AssertWitness } } },
      },
      responses: {
        201: jsonBody(WitnessAssertionOut, "Signed"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, WITNESS);
      const { pageId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const competence = await c
        .get("services")
        .medicines.competence.forMember(access.tenantId, access.tenantUserId, now);
      const out = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          requireStepUp(access, "medicines.cd.witness_asserted", pageId);
          const page = await lockedPage(tx, pageId);
          if (competence !== "current") {
            throw new AuditedRefusal(
              refusal([
                {
                  problem: "witness_not_competent",
                  message: "Only someone whose medicines competence is current can witness.",
                },
              ]),
              {
                action: "medicines.cd.witness_asserted",
                outcome: "denied",
                resourceType: "controlled_drug_page",
                resourceId: pageId,
                scope: { personId: page.personId, problems: ["witness_not_competent"] },
              },
            );
          }
          if (body.recorderId === access.tenantUserId) {
            throw new AuditedRefusal(
              refusal([
                {
                  problem: "witness_is_recorder",
                  message: "A witness signs for someone else's entry, never their own.",
                },
              ]),
              {
                action: "medicines.cd.witness_asserted",
                outcome: "denied",
                resourceType: "controlled_drug_page",
                resourceId: pageId,
                scope: { personId: page.personId, problems: ["witness_is_recorder"] },
              },
            );
          }
          const person = await loadPerson(tx, page.personId);
          const minutes = await rateNumber(tx, access.tenantId, ASSERTION_MINUTES, person.nation);
          const [row] = await tx
            .insert(controlledDrugWitnessAssertion)
            .values({
              personId: page.personId,
              pageId: page.id,
              movement: body.movement,
              quantity: String(body.quantity),
              administrationId: body.administrationId,
              witnessId: access.tenantUserId,
              recorderId: body.recorderId,
              expiresAt: new Date(now.getTime() + minutes * 60_000),
            })
            .returning();
          const a = row as typeof controlledDrugWitnessAssertion.$inferSelect;
          await audit(c, tx, access, {
            action: "medicines.cd.witness_asserted",
            resourceType: "controlled_drug_witness_assertion",
            resourceId: a.id,
            scope: { personId: page.personId, pageId: page.id, movement: body.movement },
          });
          return {
            id: a.id,
            pageId: page.id,
            witnessId: a.witnessId,
            expiresAt: a.expiresAt.toISOString(),
          };
        }),
      );
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/controlled-drugs/pages/{pageId}/entries",
      tags,
      summary: "Record a receipt, disposal, transfer out, destruction or correction",
      description:
        "Checked by slice 3's checkCdEntry on the page as it stands, under the person's lock, with the witness's signature or, where policy allows, why there was none; destruction is always witnessed. Administrations are recorded through the administrations API. Needs a fresh step-up. Audited.",
      security,
      request: {
        params: PageParam,
        body: { content: { "application/json": { schema: RecordCdEntry } } },
      },
      responses: {
        201: jsonBody(CdPageDetail.shape.entries.element, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, ADMINISTER);
      const { pageId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const out = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          requireStepUp(access, "medicines.cd.entry_recorded", pageId);
          const page = await lockedPage(tx, pageId);
          const person = await loadPerson(tx, page.personId);
          const occurredAt = body.occurredAt ? new Date(body.occurredAt) : now;
          const deny = (issues: readonly { problem: string; message: string }[]) =>
            new AuditedRefusal(refusal(issues), {
              action: "medicines.cd.entry_recorded",
              outcome: "denied",
              resourceType: "controlled_drug_page",
              resourceId: pageId,
              scope: {
                personId: page.personId,
                movement: body.movement,
                problems: issues.map((i) => i.problem),
              },
            });
          if (occurredAt.getTime() > now.getTime()) {
            throw deny([
              { problem: "in_future", message: "Record what has happened, not what will." },
            ]);
          }
          if (body.movement !== "correction" && !isDoseQuantity(body.quantity)) {
            throw deny([
              { problem: "bad_quantity", message: "Record the amount as a number more than zero." },
            ]);
          }
          const result = await writeCdEntry(tx, {
            id: randomUUID(),
            page,
            movement: body.movement,
            quantity: body.quantity,
            occurredAt,
            correctsId: body.correctsId,
            corrects: body.corrects,
            reason: body.reason,
            counterparty: body.counterparty,
            reference: body.reference,
            witness: body.witness,
            administrationId: null,
            recordedBy: access.tenantUserId,
            policy: await witnessPolicyFor(tx, person.locationId),
            now,
          });
          if (!result.ok) throw deny(result.issues);
          const r = result.row;
          await audit(c, tx, access, {
            action: "medicines.cd.entry_recorded",
            resourceType: "controlled_drug_entry",
            resourceId: r.id,
            scope: { personId: page.personId, pageId: page.id, movement: r.movement, seq: r.seq },
          });
          await publish(tx, {
            context: "medicines",
            aggregateType: "controlled_drug_entry",
            aggregateId: r.id,
            type: "medicines.cd.entry_recorded",
            payload: { personId: page.personId, pageId: page.id, entryId: r.id },
          });
          const e = cdEntryOf(page, r);
          return {
            id: r.id,
            seq: r.seq,
            movement: e.movement,
            quantity: e.quantity,
            balanceAfter: e.balanceAfter,
            correctsId: e.correctsId,
            corrects: e.corrects,
            reason: e.reason,
            counterparty: r.counterparty,
            reference: r.reference,
            occurredAt: r.occurredAt.toISOString(),
            recorded: { id: r.recordedBy, at: r.recordedAt.toISOString() },
            witnessId: r.witnessId,
            noWitnessReason: r.noWitnessReason,
            flags: [...r.flags],
            administrationId: r.administrationId,
            correctedBy: [],
          };
        }),
      );
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/controlled-drugs/pages/{pageId}/stock-checks",
      tags,
      summary: "Record a stock count against a page",
      description:
        "Compared with the page by slice 3's cdStockCheck. A count that does not balance needs a reason and raises a medication incident through the safety module; the count never changes the balance. Witnessed as an entry is. Needs a fresh step-up. Audited.",
      security,
      request: {
        params: PageParam,
        body: { content: { "application/json": { schema: RecordStockCheck } } },
      },
      responses: {
        201: jsonBody(StockCheckRecorded, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [ADMINISTER, "medicines.stock.manage"]);
      const { pageId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const out = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          requireStepUp(access, "medicines.cd.stock_checked", pageId);
          const page = await lockedPage(tx, pageId);
          const person = await loadPerson(tx, page.personId);
          const policy = await witnessPolicyFor(tx, person.locationId);
          const entries = (await pageEntries(tx, page.id)).map((r) => cdEntryOf(page, r));
          const result = cdStockCheck(entries, body.counted);
          const deny = (problem: string, message: string) =>
            new AuditedRefusal(refusal([{ problem, message }]), {
              action: "medicines.cd.stock_checked",
              outcome: "denied",
              resourceType: "controlled_drug_page",
              resourceId: pageId,
              scope: { personId: page.personId, problems: [problem] },
            });
          if (result.raiseIncident && !body.reason) {
            throw deny(
              "stock_check_reason_required",
              "The count does not match the register. Say what you found; an incident is raised.",
            );
          }
          const { witnessId, issue } = await assertionProblem(tx, body.witness, {
            pageId: page.id,
            movement: "stock_check",
            quantity: body.counted,
            administrationId: null,
            recordedBy: access.tenantUserId,
            now,
          });
          if (issue) throw deny(issue.problem, issue.message);
          if ("noWitnessReason" in body.witness && policy === "required") {
            throw deny("witness_required", "A second person must witness the count.");
          }
          const [row] = await guardConcurrent(() =>
            tx
              .insert(controlledDrugStockCheck)
              .values({
                personId: page.personId,
                pageId: page.id,
                counted: String(result.counted),
                expected: String(result.expected),
                difference: String(result.difference),
                reason: body.reason,
                checkedBy: access.tenantUserId,
                witnessId,
                witnessAssertionId:
                  "witnessAssertionId" in body.witness ? body.witness.witnessAssertionId : null,
                noWitnessReason:
                  "noWitnessReason" in body.witness ? body.witness.noWitnessReason : null,
                // A lone count is flagged for the manager, as an entry is (security review L2).
                flags: "noWitnessReason" in body.witness ? ["no_witness_for_review"] : [],
              })
              .returning(),
          );
          const check = row as StockCheckRow;
          await audit(c, tx, access, {
            action: "medicines.cd.stock_checked",
            resourceType: "controlled_drug_stock_check",
            resourceId: check.id,
            scope: { personId: page.personId, pageId: page.id, balanced: !result.raiseIncident },
          });
          if (result.raiseIncident) {
            // The safety module raises the incident (modules talk through the outbox).
            await publish(tx, {
              context: "medicines",
              aggregateType: "controlled_drug_stock_check",
              aggregateId: check.id,
              type: "medicines.cd.stock_discrepancy",
              payload: {
                stockCheckId: check.id,
                personId: page.personId,
                locationId: person.locationId,
                checkedBy: access.tenantUserId,
                checkedAt: check.checkedAt.toISOString(),
              },
            });
          }
          return {
            stockCheck: stockCheckOut(check, page.unitName),
            incidentRaised: result.raiseIncident,
          };
        }),
      );
      return c.json(out, 201);
    },
  );
