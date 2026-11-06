import {
  ChangePrnProtocol,
  MedicineList,
  MedicineListItemOut,
  MedicineListName,
  NewMedicineListItem,
  NewPrnProtocol,
  OutstandingPrnOutcomes,
  PrnFrequencyReport,
  PrnOutcomeOut,
  PrnProtocolList,
  PrnProtocolOut,
  RecordPrnOutcome,
  RemoveMedicineListItem,
  WithdrawPrnProtocol,
} from "@harbour/contracts";
import {
  medication,
  medicationAdministration,
  medicineListItem,
  person,
  prnOutcome,
  prnProtocol,
  type Transaction,
} from "@harbour/db";
import {
  checkMedicineListItem,
  checkPrnOutcome,
  checkPrnProtocol,
  formatDose,
  type MarEntry,
  MEDICINE_LIST_PROBLEM_WORDS,
  MEDICINES_RATE_KEYS,
  PRN_OUTCOME_DOSE_OUTCOMES,
  PRN_OUTCOME_PROBLEM_WORDS,
  PRN_OUTCOME_WORDS,
  PRN_PROTOCOL_PROBLEM_WORDS,
  PRN_PROTOCOL_STATUS_WORDS,
  PRN_RATE_KEYS,
  PRN_REPORT_NOTE,
  type PrnOutcome,
  type PrnReportDose,
  prnFrequency,
  prnOutcomeDueAt,
  prnProtocolStatus,
  protocolInForce,
  scopeFor,
  scopeReachesLocation,
  ukDayBounds,
  ukIsoDate,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import {
  type AppEnv,
  requireAnyPermission,
  requirePermission,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { lockPerson, personEntries } from "../services/medicines";
import { loadPerson, requireWrite } from "../services/people";
import { rateNumber } from "../services/rates";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";

/**
 * PRN protocols, their outcomes, the organisation's medicine lists and the PRN frequency report
 * (Phase 2 slice 28; medicines.md section 16; MEDS-003; HZ-117). A protocol shows the prescriber's
 * limits from the entry and never copies them; the report counts and never judges. Audited with
 * ids only.
 */

const tags = ["medicines"];
const MANAGE = "medicines.record.manage" as const;
const ADMINISTER = "medicines.emar.administer" as const;
const LISTS = "medicines.list.manage" as const;
const READERS = [MANAGE, ADMINISTER, "care.plan.read"] as const;
const IdParam = z.object({ id: z.uuid() });
const ListParam = z.object({ list: MedicineListName });

function audit(
  c: Context<AppEnv>,
  tx: Transaction,
  access: TenantAccess,
  input: Parameters<typeof auditInTx>[2],
) {
  return auditInTx(tx, access, { ...input, requestId: c.get("requestId") });
}

function refused(code: string, messages: readonly string[]): HttpProblem {
  return new HttpProblem(422, code, "This cannot be recorded like this.", messages.join(" "));
}

const GUARD_WORDS: Record<string, string> = {
  medicine_list_item_closed: "A product removed from the list cannot be changed.",
  prn_protocol_needs_current_when_required_entry: PRN_PROTOCOL_PROBLEM_WORDS.entry_not_current,
  prn_protocol_closed: "A withdrawn protocol cannot be changed.",
  prn_protocol_change_needs_reason: "Give a new reason for this change.",
  prn_outcome_not_for_this_dose: PRN_OUTCOME_PROBLEM_WORDS.not_given,
};

/** One write in a savepoint, with the database's refusals in words. */
async function inSavepoint<T>(tx: Transaction, fn: () => Promise<T>, conflict: string): Promise<T> {
  try {
    return await tx.transaction(async () => fn());
  } catch (error) {
    const e = error as {
      code?: string;
      message?: string;
      cause?: { code?: string; message?: string };
    };
    const code = e.code ?? e.cause?.code;
    const text = `${e.message ?? ""} ${e.cause?.message ?? ""}`;
    if (code === "23505") throw problems.conflict(conflict);
    if (code === "23514") {
      const key = Object.keys(GUARD_WORDS).find((k) => text.includes(k));
      throw refused("refused", [
        key ? (GUARD_WORDS[key] as string) : "This breaks a rule for this record.",
      ]);
    }
    throw error;
  }
}

type ListRow = typeof medicineListItem.$inferSelect;
type ProtocolRow = typeof prnProtocol.$inferSelect;
type OutcomeRow = typeof prnOutcome.$inferSelect;

function listItemOut(r: ListRow): z.infer<typeof MedicineListItemOut> {
  return {
    id: r.id,
    list: r.list as z.infer<typeof MedicineListName>,
    vmpId: r.vmpId,
    productName: r.productName,
    reason: r.reason,
    removedAt: r.removedAt?.toISOString() ?? null,
    removedReason: r.removedReason,
    version: r.version,
  };
}

/** The organisation's open psychotropic list (exact dm+d products; ADR-0082). */
async function psychotropicList(tx: Transaction): Promise<Set<string>> {
  const rows = await tx
    .select({ vmpId: medicineListItem.vmpId })
    .from(medicineListItem)
    .where(
      and(
        eq(medicineListItem.list, "psychotropic"),
        isNull(medicineListItem.removedAt),
        isNull(medicineListItem.deletedAt),
      ),
    );
  return new Set(rows.map((r) => r.vmpId));
}

/** The latest version of each of the person's medicines, by medicine id. */
async function latestEntries(tx: Transaction, personId: string): Promise<Map<string, MarEntry>> {
  const stored = await personEntries(tx, personId);
  const latest = new Map<string, MarEntry>();
  for (const s of stored) {
    const seen = latest.get(s.medicineId);
    if (!seen || s.entry.version > seen.version) latest.set(s.medicineId, s.entry);
  }
  return latest;
}

function isPsychotropic(entry: MarEntry | undefined, list: ReadonlySet<string>): boolean {
  if (!entry) return false;
  return entry.tags.includes("psychotropic") || list.has(entry.product.vmpId);
}

function protocolOut(
  r: ProtocolRow,
  entry: MarEntry | undefined,
  list: ReadonlySet<string>,
  today: string,
): z.infer<typeof PrnProtocolOut> {
  const status = prnProtocolStatus(
    r,
    today,
    entry ? { state: entry.state, directions: entry.directions.kind } : null,
  );
  const prn = entry?.directions.kind === "when_required" ? entry.directions : null;
  return {
    id: r.id,
    personId: r.personId,
    medicationId: r.medicationId,
    medicineId: r.medicineId,
    medicineName: entry?.product.name ?? "",
    purpose: r.purpose,
    triggers: [...r.triggers],
    nonDrugAlternatives: [...r.nonDrugAlternatives],
    purposeGroup: r.purposeGroup,
    orderOfUse: r.orderOfUse,
    expectedEffect: r.expectedEffect,
    agreedWithName: r.agreedWithName,
    agreedWithRole: r.agreedWithRole as "prescriber" | "pharmacist",
    agreedOn: r.agreedOn,
    reviewOn: r.reviewOn,
    limits: {
      dose: prn ? formatDose(prn.dose) : null,
      maxPer24h: prn?.maxQuantityPer24Hours ?? null,
      minimumIntervalMinutes: entry?.minimumIntervalMinutes ?? null,
      indication: entry?.indication ?? null,
    },
    psychotropic: isPsychotropic(entry, list),
    withdrawnOn: r.withdrawnOn,
    withdrawnReason: r.withdrawnReason,
    changeReason: r.changeReason,
    status,
    statusWords: PRN_PROTOCOL_STATUS_WORDS[status],
    version: r.version,
  };
}

function outcomeOut(r: OutcomeRow): z.infer<typeof PrnOutcomeOut> {
  return {
    id: r.id,
    personId: r.personId,
    administrationId: r.administrationId,
    outcome: r.outcome as PrnOutcome,
    outcomeWords: PRN_OUTCOME_WORDS[r.outcome as PrnOutcome],
    note: r.note,
    observedAt: r.observedAt.toISOString(),
    recordedBy: r.recordedBy,
    recordedAt: r.recordedAt.toISOString(),
    supersedesId: r.supersedesId,
    correctionReason: r.correctionReason,
  };
}

/** The places taken in a group by the person's other open protocols. */
async function takenOrders(
  tx: Transaction,
  personId: string,
  group: string | null,
  except: string | null,
): Promise<number[]> {
  if (group === null) return [];
  const rows = await tx
    .select({ id: prnProtocol.id, order: prnProtocol.orderOfUse })
    .from(prnProtocol)
    .where(
      and(
        eq(prnProtocol.personId, personId),
        eq(prnProtocol.purposeGroup, group),
        isNull(prnProtocol.withdrawnOn),
        isNull(prnProtocol.deletedAt),
      ),
    );
  return rows.filter((r) => r.id !== except && r.order !== null).map((r) => r.order as number);
}

async function protocolProblems(
  tx: Transaction,
  tenantId: string,
  personId: string,
  medicationId: string,
  body: Omit<z.infer<typeof NewPrnProtocol>, "medicationId">,
  except: string | null,
) {
  const [entry] = await tx
    .select({
      personId: medication.personId,
      directions: medication.directions,
      state: medication.state,
    })
    .from(medication)
    .where(eq(medication.id, medicationId));
  const found = checkPrnProtocol(
    {
      ...body,
      entry: entry ?? null,
      personId,
      takenOrders: await takenOrders(tx, personId, body.purposeGroup, except),
    },
    {
      today: ukIsoDate(new Date()),
      reviewMaxDays: await rateNumber(tx, tenantId, PRN_RATE_KEYS.protocolReviewMaxDays),
    },
  );
  if (found.length > 0) {
    throw refused(
      `prn_protocol_${found[0]}`,
      found.map((p) => PRN_PROTOCOL_PROBLEM_WORDS[p]),
    );
  }
}

const protocolValues = (body: Omit<z.infer<typeof NewPrnProtocol>, "medicationId">) => ({
  purpose: body.purpose,
  triggers: body.triggers,
  nonDrugAlternatives: body.nonDrugAlternatives,
  purposeGroup: body.purposeGroup,
  orderOfUse: body.orderOfUse,
  expectedEffect: body.expectedEffect,
  agreedWithName: body.agreedWithName,
  agreedWithRole: body.agreedWithRole,
  agreedOn: body.agreedOn,
  reviewOn: body.reviewOn,
});

async function loadProtocol(tx: Transaction, id: string): Promise<ProtocolRow> {
  const [row] = await tx
    .select()
    .from(prnProtocol)
    .where(and(eq(prnProtocol.id, id), isNull(prnProtocol.deletedAt)));
  if (!row) throw problems.notFound();
  return row;
}

/** The ids of administration records a later record corrects. */
function superseded(rows: readonly { supersedesId: string | null }[]): Set<string> {
  return new Set(rows.map((r) => r.supersedesId).filter((x): x is string => x !== null));
}

/** The latest outcome of each dose (corrections replace). */
function latestOutcomes(rows: readonly OutcomeRow[]): Map<string, OutcomeRow> {
  const replaced = superseded(rows);
  return new Map(rows.filter((r) => !replaced.has(r.id)).map((r) => [r.administrationId, r]));
}

export const prnProtocolsRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/medicine-lists/{list}",
      tags,
      summary: "One of the organisation's medicine lists (for example psychotropic)",
      description:
        "medicines.list.manage, medicines.record.manage or medicines.emar.administer. Exact dm+d products only (ADR-0082).",
      security,
      request: { params: ListParam },
      responses: {
        200: jsonBody(MedicineList, "The list, removed products included"),
        ...errorResponses,
      },
    }),
    async (c) => {
      await requireAnyPermission(c, [LISTS, MANAGE, ADMINISTER]);
      const { list } = c.req.valid("param");
      const out = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(medicineListItem)
          .where(and(eq(medicineListItem.list, list), isNull(medicineListItem.deletedAt)))
          .orderBy(medicineListItem.productName);
        return { list, items: rows.map(listItemOut) };
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/medicine-lists/{list}",
      tags,
      summary: "Add a dm+d product to one of the organisation's medicine lists",
      description:
        "medicines.list.manage. The exact dm+d product (VMP); never by ingredient or name. Audited with ids only.",
      security,
      request: {
        params: ListParam,
        body: { content: { "application/json": { schema: NewMedicineListItem } } },
      },
      responses: {
        201: jsonBody(MedicineListItemOut, "Added"),
        ...errorResponses,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, LISTS);
      const { list } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await withTenant(c, async (tx) => {
        const open = await tx
          .select({ vmpId: medicineListItem.vmpId })
          .from(medicineListItem)
          .where(
            and(
              eq(medicineListItem.list, list),
              isNull(medicineListItem.removedAt),
              isNull(medicineListItem.deletedAt),
            ),
          );
        const found = checkMedicineListItem(body.vmpId, new Set(open.map((r) => r.vmpId)));
        if (found.length > 0) {
          throw refused(
            `medicine_list_${found[0]}`,
            found.map((p) => MEDICINE_LIST_PROBLEM_WORDS[p]),
          );
        }
        const [row] = await inSavepoint(
          tx,
          () =>
            tx
              .insert(medicineListItem)
              .values({
                list,
                vmpId: body.vmpId,
                productName: body.productName,
                reason: body.reason,
              })
              .returning(),
          MEDICINE_LIST_PROBLEM_WORDS.already_listed,
        );
        const stored = row as ListRow;
        await audit(c, tx, access, {
          action: "medicines.list.item_added",
          resourceType: "medicine_list_item",
          resourceId: stored.id,
          scope: { list, vmpId: stored.vmpId },
        });
        return listItemOut(stored);
      });
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/medicine-list-items/{id}/remove",
      tags,
      summary: "Remove a product from a medicine list, with a reason",
      description:
        "medicines.list.manage, with the version read. The removal is kept. Audited with ids only.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: RemoveMedicineListItem } } },
      },
      responses: {
        200: jsonBody(MedicineListItemOut, "Removed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, LISTS);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await withTenant(c, async (tx) => {
        const [current] = await tx
          .select()
          .from(medicineListItem)
          .where(eq(medicineListItem.id, id));
        if (!current || current.deletedAt) throw problems.notFound();
        if (current.removedAt) {
          throw refused("medicine_list_removed", ["This product has already been removed."]);
        }
        const [row] = await inSavepoint(
          tx,
          () =>
            tx
              .update(medicineListItem)
              .set({ removedAt: new Date(), removedReason: body.reason })
              .where(and(eq(medicineListItem.id, id), eq(medicineListItem.version, body.version)))
              .returning(),
          "Read the list again and resend.",
        );
        if (!row) throw problems.conflict();
        await audit(c, tx, access, {
          action: "medicines.list.item_removed",
          resourceType: "medicine_list_item",
          resourceId: id,
          scope: { list: current.list, vmpId: current.vmpId },
        });
        return listItemOut(row);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/prn-protocols",
      tags,
      summary: "A person's PRN protocols, with the prescriber's limits from each entry",
      description:
        "medicines.record.manage, medicines.emar.administer or care.plan.read, in the person's scope. Audited with ids only.",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(PrnProtocolList, "Protocols, withdrawn ones included"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [...READERS]);
      const { id } = c.req.valid("param");
      const out = await withTenant(c, async (tx) => {
        await loadPerson(tx, id);
        const rows = await tx
          .select()
          .from(prnProtocol)
          .where(and(eq(prnProtocol.personId, id), isNull(prnProtocol.deletedAt)))
          .orderBy(prnProtocol.purposeGroup, prnProtocol.orderOfUse);
        const entries = await latestEntries(tx, id);
        const list = await psychotropicList(tx);
        await audit(c, tx, access, {
          action: "medicines.prn_protocol.viewed",
          resourceType: "person",
          resourceId: id,
          scope: { personId: id, count: rows.length },
        });
        const today = ukIsoDate(new Date());
        return { items: rows.map((r) => protocolOut(r, entries.get(r.medicineId), list, today)) };
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/prn-protocols",
      tags,
      summary: "Record a PRN protocol for one of the person's when-required medicines",
      description:
        "medicines.record.manage in the person's scope. For a current when-required entry; the signs that mean it may be needed, what to try first, the order among the person's medicines for the same purpose, the agreement with the prescriber or pharmacist and a review within the rate table's days. One open protocol per medicine. The dose, most in 24 hours and interval stay the entry's. Audited with ids only.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: NewPrnProtocol } } },
      },
      responses: {
        201: jsonBody(PrnProtocolOut, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id: personId } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, personId);
        requireWrite(p, "care_plan");
        await protocolProblems(tx, access.tenantId, personId, body.medicationId, body, null);
        const [row] = await inSavepoint(
          tx,
          () =>
            tx
              .insert(prnProtocol)
              .values({
                personId,
                medicationId: body.medicationId,
                // Set by the guard from the entry.
                medicineId: body.medicationId,
                ...protocolValues(body),
              })
              .returning(),
          "This medicine already has a protocol in use, or that place in the group is taken: change it instead.",
        );
        const stored = row as ProtocolRow;
        await audit(c, tx, access, {
          action: "medicines.prn_protocol.recorded",
          resourceType: "prn_protocol",
          resourceId: stored.id,
          scope: { personId, medicineId: stored.medicineId },
        });
        const entries = await latestEntries(tx, personId);
        return protocolOut(
          stored,
          entries.get(stored.medicineId),
          await psychotropicList(tx),
          ukIsoDate(new Date()),
        );
      });
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/prn-protocols/{id}/change",
      tags,
      summary: "Change or review a PRN protocol, with a reason",
      description:
        "medicines.record.manage in the person's scope, with the version read; every version is kept. Audited with ids only.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: ChangePrnProtocol } } },
      },
      responses: {
        200: jsonBody(PrnProtocolOut, "Changed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const { reason, version, ...body } = c.req.valid("json");
      const out = await withTenant(c, async (tx) => {
        const current = await loadProtocol(tx, id);
        const p = await loadPerson(tx, current.personId);
        requireWrite(p, "care_plan");
        if (current.withdrawnOn !== null) {
          throw refused("prn_protocol_closed", ["A withdrawn protocol cannot be changed."]);
        }
        await protocolProblems(
          tx,
          access.tenantId,
          current.personId,
          current.medicationId,
          body,
          id,
        );
        const [row] = await inSavepoint(
          tx,
          () =>
            tx
              .update(prnProtocol)
              .set({ ...protocolValues(body), changeReason: reason })
              .where(and(eq(prnProtocol.id, id), eq(prnProtocol.version, version)))
              .returning(),
          "That place in the group is taken.",
        );
        if (!row) throw problems.conflict();
        await audit(c, tx, access, {
          action: "medicines.prn_protocol.changed",
          resourceType: "prn_protocol",
          resourceId: id,
          scope: { personId: current.personId },
        });
        const entries = await latestEntries(tx, current.personId);
        return protocolOut(
          row,
          entries.get(row.medicineId),
          await psychotropicList(tx),
          ukIsoDate(new Date()),
        );
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/prn-protocols/{id}/withdraw",
      tags,
      summary: "Withdraw a PRN protocol, with a reason",
      description:
        "medicines.record.manage in the person's scope, with the version read. Doses after it count as given without a protocol. Audited with ids only.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: WithdrawPrnProtocol } } },
      },
      responses: {
        200: jsonBody(PrnProtocolOut, "Withdrawn"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await withTenant(c, async (tx) => {
        const current = await loadProtocol(tx, id);
        const p = await loadPerson(tx, current.personId);
        requireWrite(p, "care_plan");
        if (current.withdrawnOn !== null) {
          throw refused("prn_protocol_closed", ["This protocol has already been withdrawn."]);
        }
        const today = ukIsoDate(new Date());
        const [row] = await inSavepoint(
          tx,
          () =>
            tx
              .update(prnProtocol)
              .set({
                withdrawnOn: today,
                withdrawnReason: body.reason,
                changeReason: `Withdrawn: ${body.reason}`,
              })
              .where(and(eq(prnProtocol.id, id), eq(prnProtocol.version, body.version)))
              .returning(),
          "Read the protocol again and resend.",
        );
        if (!row) throw problems.conflict();
        await audit(c, tx, access, {
          action: "medicines.prn_protocol.withdrawn",
          resourceType: "prn_protocol",
          resourceId: id,
          scope: { personId: current.personId },
        });
        const entries = await latestEntries(tx, current.personId);
        return protocolOut(row, entries.get(row.medicineId), await psychotropicList(tx), today);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/medicine-administrations/{id}/prn-outcome",
      tags,
      summary: "Record the outcome of a when-required dose",
      description:
        "medicines.emar.administer or medicines.record.manage, in the person's scope. For a when-required dose that was given or taken, seen after the dose and not in the future; a correction names the outcome it corrects, with a reason. Resending the same id returns the same record. Audited with ids only.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: RecordPrnOutcome } } },
      },
      responses: {
        200: jsonBody(PrnOutcomeOut, "Already recorded with this id"),
        201: jsonBody(PrnOutcomeOut, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [ADMINISTER, MANAGE]);
      const { id: administrationId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const result = await withTenant(c, async (tx) => {
        const [dose] = await tx
          .select()
          .from(medicationAdministration)
          .where(eq(medicationAdministration.id, administrationId));
        if (!dose) throw problems.notFound();
        const p = await loadPerson(tx, dose.personId);
        await lockPerson(tx, dose.personId);
        const [resent] = await tx.select().from(prnOutcome).where(eq(prnOutcome.id, body.id));
        if (resent) {
          if (
            resent.administrationId !== administrationId ||
            resent.outcome !== body.outcome ||
            resent.recordedBy !== access.tenantUserId ||
            (resent.supersedesId ?? null) !== (body.correction?.supersedesId ?? null)
          ) {
            throw problems.conflict(
              "This record id cannot be used. Read the record again and resend.",
            );
          }
          return { status: 200 as const, outcome: outcomeOut(resent) };
        }
        const observedAt = new Date(body.observedAt);
        requireWrite(p, "care_note", observedAt);
        const found = checkPrnOutcome({ dose, observedAt, now });
        if (found.length > 0) {
          throw refused(
            `prn_outcome_${found[0]}`,
            found.map((x) => PRN_OUTCOME_PROBLEM_WORDS[x]),
          );
        }
        const [row] = await inSavepoint(
          tx,
          () =>
            tx
              .insert(prnOutcome)
              .values({
                id: body.id,
                personId: dose.personId,
                administrationId,
                outcome: body.outcome,
                note: body.note,
                observedAt,
                recordedBy: access.tenantUserId,
                supersedesId: body.correction?.supersedesId ?? null,
                correctionReason: body.correction?.reason ?? null,
              })
              .returning(),
          body.correction
            ? "That outcome has already been corrected: read it again."
            : "This dose already has an outcome: correct it instead.",
        );
        const stored = row as OutcomeRow;
        await audit(c, tx, access, {
          action: body.correction
            ? "medicines.prn_outcome.corrected"
            : "medicines.prn_outcome.recorded",
          resourceType: "prn_outcome",
          resourceId: stored.id,
          scope: { personId: dose.personId, administrationId },
        });
        return { status: 201 as const, outcome: outcomeOut(stored) };
      });
      return c.json(result.outcome, result.status);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/prn-outcomes/outstanding",
      tags,
      summary: "A person's when-required doses whose outcome is due and not recorded",
      description:
        "medicines.record.manage, medicines.emar.administer or care.plan.read, in the person's scope. Due `medicines.prn.outcome_check_minutes` after the dose.",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(OutstandingPrnOutcomes, "Outstanding outcomes, oldest first"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [...READERS]);
      const { id } = c.req.valid("param");
      const now = new Date();
      const out = await withTenant(c, async (tx) => {
        await loadPerson(tx, id);
        const minutes = await rateNumber(
          tx,
          access.tenantId,
          MEDICINES_RATE_KEYS.prnOutcomeCheckMinutes,
        );
        const doses = await tx
          .select()
          .from(medicationAdministration)
          .where(
            and(eq(medicationAdministration.personId, id), isNull(medicationAdministration.dueAt)),
          )
          .orderBy(medicationAdministration.givenAt);
        const replaced = superseded(doses);
        const outcomes = await tx.select().from(prnOutcome).where(eq(prnOutcome.personId, id));
        const seen = latestOutcomes(outcomes);
        const entries = await latestEntries(tx, id);
        const names = new Map([...entries.values()].map((e) => [e.id, e.product.name]));
        const medicineOf = await medicineIds(
          tx,
          doses.map((d) => d.medicationId),
        );
        const items = doses
          .filter(
            (d) =>
              !replaced.has(d.id) &&
              (PRN_OUTCOME_DOSE_OUTCOMES as readonly string[]).includes(d.outcome) &&
              !seen.has(d.id),
          )
          .map((d) => ({
            d,
            dueAt: prnOutcomeDueAt(d.givenAt, { prnOutcomeCheckMinutes: minutes }),
          }))
          .filter((x) => x.dueAt.getTime() <= now.getTime())
          .map(({ d, dueAt }) => ({
            administrationId: d.id,
            entryId: d.medicationId,
            medicineName:
              names.get(d.medicationId) ??
              entries.get(medicineOf.get(d.medicationId) ?? "")?.product.name ??
              "",
            givenAt: d.givenAt.toISOString(),
            dueAt: dueAt.toISOString(),
          }));
        return { items };
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/locations/{id}/medicines/prn-frequency",
      tags,
      summary: "The PRN frequency report for a home (information only)",
      description:
        "medicines.record.manage at the home. For each person and when-required medicine in the period (UK dates, inclusive, at most `medicines.prn_report.max_days`): doses given or taken, days with doses, the most in one day, doses with no protocol in use, outcomes and those outstanding; psychotropic by the entry's tag or the organisation's list. People are counted at their current home. A count for the prescriber and pharmacist, never a judgement. Audited with ids only.",
      security,
      request: {
        params: IdParam,
        query: z.object({
          from: z.iso.date(),
          to: z.iso.date(),
          psychotropicOnly: z.enum(["true", "false"]).default("false"),
        }),
      },
      responses: { 200: jsonBody(PrnFrequencyReport, "The report"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const q = c.req.valid("query");
      if (!scopeReachesLocation(scopeFor(access.effective, MANAGE), id)) throw problems.forbidden();
      const now = new Date();
      const out = await withTenant(c, async (tx) => {
        if (q.to < q.from)
          throw problems.invalid("The end of the period must be on or after its start.");
        const maxDays = await rateNumber(tx, access.tenantId, PRN_RATE_KEYS.reportMaxDays);
        const days =
          (Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / 86_400_000 + 1;
        if (days > maxDays) throw problems.invalid(`Choose a period of ${maxDays} days or fewer.`);
        const startsAt = ukDayBounds(q.from).startsAt;
        const endsAt = ukDayBounds(q.to).endsAt;
        const people = await tx
          .select({ id: person.id, given: person.givenName, family: person.familyName })
          .from(person)
          .where(and(eq(person.locationId, id), isNull(person.deletedAt)));
        const ids = people.map((p) => p.id);
        const lines =
          ids.length === 0
            ? { lines: [], medicineNames: new Map<string, string>() }
            : await reportLines(tx, access.tenantId, ids, startsAt, endsAt, now);
        const names = new Map(people.map((p) => [p.id, `${p.given} ${p.family}`]));
        const items = lines.lines
          .filter((l) => q.psychotropicOnly === "false" || l.psychotropic)
          .map((l) => ({
            ...l,
            name: names.get(l.personId) ?? "",
            medicineName: lines.medicineNames.get(l.medicineId) ?? "",
          }));
        await audit(c, tx, access, {
          action: "medicines.report.prn_frequency_viewed",
          resourceType: "location",
          resourceId: id,
          scope: { from: q.from, to: q.to, people: new Set(items.map((i) => i.personId)).size },
        });
        return { from: q.from, to: q.to, note: PRN_REPORT_NOTE, items };
      });
      return c.json(out, 200);
    },
  );

/** Each administration record's stable medicine id. */
async function medicineIds(
  tx: Transaction,
  medicationIds: readonly string[],
): Promise<Map<string, string>> {
  if (medicationIds.length === 0) return new Map();
  const rows = await tx
    .select({ id: medication.id, medicineId: medication.medicineId })
    .from(medication)
    .where(inArray(medication.id, [...new Set(medicationIds)]));
  return new Map(rows.map((r) => [r.id, r.medicineId]));
}

async function reportLines(
  tx: Transaction,
  tenantId: string,
  personIds: readonly string[],
  startsAt: Date,
  endsAt: Date,
  now: Date,
) {
  const minutes = await rateNumber(tx, tenantId, MEDICINES_RATE_KEYS.prnOutcomeCheckMinutes);
  const doses = await tx
    .select()
    .from(medicationAdministration)
    .where(
      and(
        inArray(medicationAdministration.personId, [...personIds]),
        isNull(medicationAdministration.dueAt),
        gte(medicationAdministration.givenAt, startsAt),
        lt(medicationAdministration.givenAt, endsAt),
      ),
    );
  // A record superseded by a correction never counts, wherever the correction falls.
  const corrections =
    doses.length === 0
      ? []
      : await tx
          .select({ supersedesId: medicationAdministration.supersedesId })
          .from(medicationAdministration)
          .where(
            inArray(
              medicationAdministration.supersedesId,
              doses.map((d) => d.id),
            ),
          );
  const replaced = superseded(corrections);
  const kept = doses.filter(
    (d) =>
      !replaced.has(d.id) && (PRN_OUTCOME_DOSE_OUTCOMES as readonly string[]).includes(d.outcome),
  );
  const entries = await tx
    .select({
      id: medication.id,
      medicineId: medication.medicineId,
      name: medication.productName,
      vmpId: medication.vmpId,
      tags: medication.tags,
      version: medication.version,
    })
    .from(medication)
    .where(inArray(medication.personId, [...personIds]))
    .orderBy(desc(medication.version));
  const byId = new Map(entries.map((e) => [e.id, e]));
  const medicineNames = new Map<string, string>();
  for (const e of entries)
    if (!medicineNames.has(e.medicineId)) medicineNames.set(e.medicineId, e.name);
  const list = await psychotropicList(tx);
  const protocols = await tx
    .select({
      medicineId: prnProtocol.medicineId,
      agreedOn: prnProtocol.agreedOn,
      withdrawnOn: prnProtocol.withdrawnOn,
      reviewOn: prnProtocol.reviewOn,
      createdAt: prnProtocol.createdAt,
      updatedAt: prnProtocol.updatedAt,
    })
    .from(prnProtocol)
    .where(and(inArray(prnProtocol.personId, [...personIds]), isNull(prnProtocol.deletedAt)));
  const outcomes = latestOutcomes(
    kept.length === 0
      ? []
      : await tx
          .select()
          .from(prnOutcome)
          .where(
            inArray(
              prnOutcome.administrationId,
              kept.map((d) => d.id),
            ),
          ),
  );
  const reportDoses: PrnReportDose[] = kept.map((d) => {
    const e = byId.get(d.medicationId);
    const medicineId = e?.medicineId ?? d.medicationId;
    return {
      personId: d.personId,
      medicineId,
      at: d.givenAt,
      // Each dose is classed by the version it was given against, or the organisation's list.
      psychotropic: (e?.tags ?? []).includes("psychotropic") || (e ? list.has(e.vmpId) : false),
      protocol: protocolInForce(
        protocols
          .filter((p) => p.medicineId === medicineId)
          .map((p) => ({
            recordedAt: p.createdAt,
            agreedFrom: ukDayBounds(p.agreedOn).startsAt,
            // A withdrawn protocol is closed, so its last change is the withdrawal.
            withdrawnAt: p.withdrawnOn === null ? null : p.updatedAt,
            reviewOn: p.reviewOn,
          })),
        d.givenAt,
      ),
      outcome: (outcomes.get(d.id)?.outcome as PrnOutcome | undefined) ?? null,
      outcomeDue:
        prnOutcomeDueAt(d.givenAt, { prnOutcomeCheckMinutes: minutes }).getTime() <= now.getTime(),
    };
  });
  return { lines: prnFrequency(reportDoses), medicineNames };
}
