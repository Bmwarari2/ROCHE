import {
  type ExitDetails,
  type ExitOut,
  ExitView,
  MoveExit,
  PlanExit,
  UpdateExitItem,
} from "@harbour/contracts";
import {
  careNote,
  document,
  exitChecklistItem,
  exitRecord,
  statutoryNotification,
  type Transaction,
  task,
} from "@harbour/db";
import {
  checkExitWorkflowMove,
  EXIT_WORKFLOWS,
  type ExitItemState,
  type ExitKind,
  exitChecklist,
  exitChecklistStatus,
  exitItemOwner,
  LIVE_PERSON_STATUSES,
  type PersonStatus,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { writeAudit } from "../http/audit";
import { requirePermission, withTenant } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { draftedKinds, notificationsForExit } from "../services/death-notifications";
import {
  contextOfExit,
  loadPerson,
  type PersonRecord,
  personKeys,
  personProperty,
  planExit,
  requireVersion,
  requireWrite,
  WorkflowMoveRefused,
} from "../services/people";
import { moveWorkflow } from "../services/workflow";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import {
  actorOf,
  audit,
  invalidOnForeignKey,
  iso,
  PersonParam,
  refusal,
  requireAnyPermission,
} from "./people-shared";

/**
 * Discharge, transfer and death workflows (people.md rules 11 and 12): the checklist with its
 * owners and notifications from `exitChecklist`, the state from `exitChecklistStatus` (property,
 * keys and the statutory notifications counted from their own records, so nothing can be ticked
 * while an item is still held), the moves gated by `checkExitWorkflowMove`, and the return
 * deadlines from the rate table. A discharge or death recorded in error is corrected from the
 * person's status, which cancels the exit.
 */

const ItemParams = PersonParam.extend({ itemKey: z.string().max(80) });

type ExitRow = typeof exitRecord.$inferSelect;
type ItemRow = typeof exitChecklistItem.$inferSelect;

/** Items counted from their own records: the inventory and the keys log. */
const DERIVED_FROM_RECORDS = new Set(["property_returned", "keys_returned"]);

/** The evidence an item may cite must be the same person's record. */
async function evidenceBelongs(
  tx: Transaction,
  personId: string,
  type: string,
  id: string,
): Promise<boolean> {
  const owner = async (rows: Promise<{ personId: string | null }[]>) =>
    (await rows)[0]?.personId === personId;
  switch (type) {
    case "statutory_notification":
      return owner(
        tx
          .select({ personId: statutoryNotification.personId })
          .from(statutoryNotification)
          .where(eq(statutoryNotification.id, id)),
      );
    case "document":
      return owner(
        tx
          .select({ personId: document.personId })
          .from(document)
          .where(and(eq(document.id, id), isNull(document.deletedAt))),
      );
    case "note":
      return owner(
        tx.select({ personId: careNote.personId }).from(careNote).where(eq(careNote.id, id)),
      );
    default:
      // Residents' money ledger entries arrive with the finance module (Phase 3).
      return false;
  }
}

async function latestExit(tx: Transaction, personId: string): Promise<ExitRow | null> {
  const [row] = await tx
    .select()
    .from(exitRecord)
    .where(and(eq(exitRecord.personId, personId), isNull(exitRecord.deletedAt)))
    .orderBy(desc(exitRecord.createdAt))
    .limit(1);
  return row ?? null;
}

function storedState(row: ItemRow): ExitItemState {
  if (row.status === "done" && row.doneBy && row.doneAt) {
    return { status: "done", by: row.doneBy, at: row.doneAt, evidenceId: row.evidenceId };
  }
  if (row.status === "not_required" && row.doneBy && row.doneAt) {
    return { status: "not_required", reason: row.reason ?? "", by: row.doneBy, at: row.doneAt };
  }
  return { status: "pending" };
}

/** Everything `exitChecklistStatus` needs, from the record. */
async function exitState(tx: Transaction, exit: ExitRow) {
  const context = contextOfExit(exit);
  const definitions = exitChecklist(context);
  const rows = await tx
    .select()
    .from(exitChecklistItem)
    .where(and(eq(exitChecklistItem.exitRecordId, exit.id), isNull(exitChecklistItem.deletedAt)));
  const states: Record<string, ExitItemState> = {};
  for (const row of rows) states[row.itemKey] = storedState(row);

  // Notifications drafted in the safety module (HZ-013) follow their draft once there is one:
  // this death's drafts only, never those of an earlier death recorded in error.
  const forExit = await notificationsForExit(tx, exit);
  const drafts = new Map<string, typeof statutoryNotification.$inferSelect>();
  const fromSafety = new Set<string>();
  for (const [itemKey, kind] of draftedKinds(exit)) {
    const draft = forExit.get(kind);
    if (!draft || draft.noLongerIndicated) continue;
    drafts.set(itemKey, draft);
    fromSafety.add(itemKey);
    if (draft.status === "submitted" && draft.submittedBy && draft.submittedAt) {
      states[itemKey] = {
        status: "done",
        by: draft.submittedBy,
        at: draft.submittedAt,
        evidenceId: draft.id,
      };
    } else if (draft.status === "not_required" && draft.notRequiredReason) {
      states[itemKey] = {
        status: "not_required",
        reason: draft.notRequiredReason,
        by: draft.updatedBy ?? "",
        at: draft.updatedAt,
      };
    } else {
      states[itemKey] = { status: "pending" };
    }
  }

  const property = (await personProperty(tx, exit.personId)).map((i) => ({
    id: i.id,
    category: i.category,
    valuable: i.valuable,
    receivedOn: i.receivedOn,
    status: i.status as "held",
  }));
  const keys = (await personKeys(tx, exit.personId)).map((k) => ({
    ...k,
    issuedTo: k.issuedTo as "person" | "representative",
  }));
  // Until the residents' money ledger (finance, Phase 3), the money return is confirmed by hand.
  const moneyItem = states.residents_money_returned;
  const status = exitChecklistStatus(definitions, states, {
    property,
    keys,
    residentsMoneyBalancePence: context.holdsResidentsMoney
      ? moneyItem?.status === "done"
        ? 0
        : 1
      : null,
  });
  return { context, definitions, rows, states, status, fromSafety, drafts };
}

async function exitOut(tx: Transaction, exit: ExitRow): Promise<ExitOut> {
  const { context, definitions, rows, states, status, fromSafety, drafts } = await exitState(
    tx,
    exit,
  );
  return {
    id: exit.id,
    personId: exit.personId,
    kind: exit.kind as ExitOut["kind"],
    state: exit.state as ExitOut["state"],
    leftAt: iso(exit.leftAt),
    context: {
      regulator: context.regulator,
      localAuthorityFunded: context.funding.localAuthority,
      nhsFunded: context.funding.nhs,
      placeOfDeath: (exit.placeOfDeath ?? null) as ExitOut["context"]["placeOfDeath"],
      deathExpected: exit.deathExpected,
      learningDisabilityOrAutism: context.learningDisabilityOrAutism,
      dolsInPlace: context.dolsInPlace,
      homeIsDwpAppointee: context.homeIsDwpAppointee,
      holdsResidentsMoney: context.holdsResidentsMoney,
      holdsDeposit: context.holdsDeposit,
      hasLoanEquipment: context.hasLoanEquipment,
    },
    details: {
      destinationType: exit.destinationType,
      receivingProviderName: exit.receivingProviderName,
      receivingProviderCqcLocationId: exit.receivingProviderCqcLocationId,
      receivingProviderOdsCode: exit.receivingProviderOdsCode,
      reason: exit.reason,
      verifiedByName: exit.verifiedByName,
      verifiedByRole: exit.verifiedByRole,
      verifiedAt: iso(exit.verifiedAt),
      presentAtDeath: exit.presentAtDeath,
      funeralDirector: exit.funeralDirector,
      collectionAt: iso(exit.collectionAt),
      coronerReferredBy: exit.coronerReferredBy,
      coronerReference: exit.coronerReference,
    },
    checklist: definitions.map((definition) => {
      const row = rows.find((r) => r.itemKey === definition.key);
      const state = states[definition.key] ?? { status: "pending" as const };
      const derived = DERIVED_FROM_RECORDS.has(definition.key) || fromSafety.has(definition.key);
      const recordsDone =
        DERIVED_FROM_RECORDS.has(definition.key) &&
        !status.outstandingReturns.includes(definition.key);
      const draft = drafts.get(definition.key);
      const effective = recordsDone ? "done" : state.status;
      return {
        key: definition.key,
        title: definition.title,
        owner: definition.owner,
        returnItem: definition.returnItem,
        allowNotRequired: definition.allowNotRequired,
        notification: definition.notification
          ? {
              recipient: definition.notification.recipient,
              statutory: definition.notification.statutory,
              due:
                definition.notification.due.kind === "rate"
                  ? { kind: "rate" as const, rateKey: definition.notification.due.rateKey }
                  : { kind: definition.notification.due.kind },
            }
          : null,
        hazardIds: [...definition.hazardIds],
        status: effective,
        reason: state.status === "not_required" ? state.reason : null,
        doneBy: state.status === "pending" ? null : state.by || null,
        doneAt: state.status === "pending" ? null : state.at.toISOString(),
        evidenceType: draft ? "statutory_notification" : (row?.evidenceType ?? null),
        evidenceId: draft ? draft.id : (row?.evidenceId ?? null),
        derived,
        version: row?.version ?? 0,
      };
    }),
    status: {
      readyForReturn: status.readyForReturn,
      readyToClose: status.readyToClose,
      outstanding: [...status.outstanding],
      outstandingReturns: [...status.outstandingReturns],
      invalid: [...status.invalid],
    },
    deadlines: {
      moneyAndPropertyBy: iso(exit.moneyAndPropertyDueAt),
      depositBy: iso(exit.depositDueAt),
    },
    closedAt: iso(exit.closedAt),
    cancelledReason: exit.cancelledReason,
    version: exit.version,
  };
}

/** Who may write the exit checklist: a live person's planned exit, or a record that has closed. */
function requireExitWrite(p: PersonRecord) {
  if (LIVE_PERSON_STATUSES.includes(p.status as PersonStatus)) requireWrite(p, "care_plan");
  else requireWrite(p, "exit_checklist_item");
}

const DEFAULT_DETAILS: ExitDetails = {
  homeIsDwpAppointee: false,
  holdsResidentsMoney: false,
  holdsDeposit: false,
  hasLoanEquipment: false,
};

export const peopleExitRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/exit",
      tags: ["people"],
      summary: "The discharge, transfer or death workflow with its checklist and deadlines",
      security,
      request: { params: PersonParam },
      responses: { 200: jsonBody(ExitView, "Exit"), ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.person.read");
      const { id } = c.req.valid("param");
      const view = await withTenant(c, async (tx) => {
        await loadPerson(tx, id);
        const exit = await latestExit(tx, id);
        await audit(c, tx, access, {
          action: "people.exit.view",
          resourceType: exit ? "exit_record" : "person",
          resourceId: exit?.id ?? id,
        });
        return { exit: exit ? await exitOut(tx, exit) : null };
      });
      return c.json(view, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/exit",
      tags: ["people"],
      summary: "Plan a discharge or transfer before the person leaves",
      description:
        "Starts the discharge or transfer workflow in `planned` with its checklist, so the summary of care and the notifications can be done before leaving. Recording the discharge on the person's status moves it to `left`.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: PlanExit } } },
      },
      responses: { 201: jsonBody(ExitView, "Planned"), ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.admission.manage");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const view = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id, true);
        requireWrite(p, "care_plan");
        const exitId = await planExit(
          tx,
          actorOf(c),
          p,
          body.kind,
          body.details ?? DEFAULT_DETAILS,
          now,
        );
        const [exit] = await tx.select().from(exitRecord).where(eq(exitRecord.id, exitId));
        if (!exit) throw problems.conflict();
        await audit(c, tx, access, {
          action: "people.exit.plan",
          resourceType: "exit_record",
          resourceId: exitId,
          scope: { kind: body.kind },
        });
        return { exit: await exitOut(tx, exit) };
      });
      return c.json(view, 201);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/people/{id}/exit/items/{itemKey}",
      tags: ["people"],
      summary: "Record an item of the exit checklist as done, or not required with a reason",
      description:
        "Property and keys are counted from the inventory and the keys log, and statutory notifications from their drafts in the safety module, so those items cannot be ticked by hand. 'Not required' needs a reason and is allowed only where the checklist allows it.",
      security,
      request: {
        params: ItemParams,
        body: { content: { "application/json": { schema: UpdateExitItem } } },
      },
      responses: {
        200: jsonBody(ExitView, "Saved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const { id, itemKey } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      if ((body.evidenceType === undefined) !== (body.evidenceId === undefined)) {
        throw problems.invalid("Name both the kind of evidence and its id, or neither.");
      }
      // Residents' money and deposits (finance items) are confirmed only with the finance
      // approval permission, which needs a fresh sign-in (step-up), and never by whoever recorded
      // the exit (separation of duties for residents' money). Ownership comes from the domain's
      // checklist definition for the key, before anything is read, and the stored row is checked
      // against it below.
      const finance = exitItemOwner(itemKey) === "finance";
      const access = finance
        ? await requirePermission(c, "finance.ledger.approve")
        : await requireAnyPermission(c, ["people.admission.manage", "people.movement.record"]);
      const view = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id);
        requireExitWrite(p);
        const exit = await latestExit(tx, id);
        if (!exit || exit.state === "closed" || exit.state === "cancelled")
          throw problems.notFound();
        const state = await exitState(tx, exit);
        const row = state.rows.find((r) => r.itemKey === itemKey);
        if (!row) throw problems.notFound();
        requireVersion(row.version, body.version);
        if (finance && body.status !== "pending" && exit.createdBy === access.tenantUserId) {
          await writeAudit(c.get("services").appPool, access, {
            action: "people.exit.item",
            outcome: "denied",
            resourceType: "exit_checklist_item",
            resourceId: row.id,
            reason: "separation_of_duties",
            requestId: c.get("requestId"),
          });
          throw new HttpProblem(
            403,
            "separation_of_duties",
            "Someone else must confirm this.",
            "The person who recorded the exit cannot also confirm the return of the person's money or deposit.",
          );
        }
        if (
          body.evidenceType &&
          body.evidenceId &&
          !(await evidenceBelongs(tx, id, body.evidenceType, body.evidenceId))
        ) {
          throw problems.invalid("The evidence was not found in this person's record.");
        }
        if (DERIVED_FROM_RECORDS.has(itemKey)) {
          throw problems.invalid(
            "This is counted from the property inventory and the keys log: record each return there.",
          );
        }
        if (state.fromSafety.has(itemKey)) {
          throw problems.invalid(
            "This follows its statutory notification: submit it, or mark it not required, in notifications.",
          );
        }
        const proposed: ExitItemState =
          body.status === "pending"
            ? { status: "pending" }
            : body.status === "done"
              ? {
                  status: "done",
                  by: access.tenantUserId,
                  at: now,
                  evidenceId: body.evidenceId ?? null,
                }
              : {
                  status: "not_required",
                  reason: body.reason ?? "",
                  by: access.tenantUserId,
                  at: now,
                };
        const check = exitChecklistStatus(
          state.definitions,
          { ...state.states, [itemKey]: proposed },
          { property: [], keys: [], residentsMoneyBalancePence: null },
        );
        if (check.invalid.includes(itemKey)) {
          throw problems.invalid(
            row.allowNotRequired ? "Say why it is not required." : "This item must be done.",
          );
        }
        const [updated] = await tx
          .update(exitChecklistItem)
          .set({
            status: body.status,
            reason: body.status === "not_required" ? (body.reason ?? null) : null,
            doneBy: body.status === "pending" ? null : access.tenantUserId,
            doneAt: body.status === "pending" ? null : now,
            evidenceType: body.evidenceType ?? null,
            evidenceId: body.evidenceId ?? null,
          })
          .where(and(eq(exitChecklistItem.id, row.id), eq(exitChecklistItem.version, body.version)))
          .returning()
          .catch(invalidOnForeignKey("evidence"));
        if (!updated) throw problems.conflict();
        await audit(c, tx, access, {
          action: "people.exit.item",
          resourceType: "exit_checklist_item",
          resourceId: row.id,
          reason: body.reason,
          scope: { itemKey, status: body.status },
        });
        return { exit: await exitOut(tx, exit) };
      });
      return c.json(view, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/exit/moves",
      tags: ["people"],
      summary: "Move the exit workflow: awaiting returns, closed, or a planned exit cancelled",
      description:
        "checkExitWorkflowMove: everything except the returns done before awaiting returns, and everything (property, keys and money counted from their own records) before closing. Closing lets the record be archived. A planned discharge or transfer is cancelled here with a reason; a discharge or death recorded in error is corrected from the person's status.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: MoveExit } } },
      },
      responses: {
        200: jsonBody(ExitView, "Moved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.admission.manage");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const view = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id);
        const exit = await latestExit(tx, id);
        if (!exit) throw problems.notFound();
        requireVersion(exit.version, body.version);
        if (body.to === "cancelled" && exit.state !== "planned") {
          throw problems.invalid(
            "Only a planned exit is cancelled here. Correct a discharge or death recorded in error from the person's status.",
          );
        }
        const { status, definitions } = await exitState(tx, exit);
        const gate = checkExitWorkflowMove(body.to, status);
        if (!gate.ok) {
          const titles = gate.outstanding.map(
            (key) => definitions.find((d) => d.key === key)?.title ?? key,
          );
          throw problems.invalid(
            `${gate.problem === "checklist_incomplete" ? "Finish the checklist first" : "Wait for the returns first"}: ${titles.join("; ")}.`,
          );
        }
        try {
          await moveWorkflow(
            tx,
            access.tenantId,
            EXIT_WORKFLOWS[exit.kind as ExitKind],
            { subjectType: "exit_record", subjectId: exit.id, personId: id },
            {
              to: body.to as never,
              actorTenantUserId: access.tenantUserId,
              permissions: new Set(access.effective.permissions),
              reason: body.reason ?? null,
              stepUpFresh: actorOf(c).stepUpFresh,
            },
            now,
          );
        } catch (error) {
          if (error instanceof WorkflowMoveRefused) {
            await refusal(c, error, `${EXIT_WORKFLOWS[exit.kind as ExitKind].key}.${body.to}`, {
              type: "exit_record",
              id: exit.id,
            });
          }
          throw error;
        }
        const [updated] = await tx
          .update(exitRecord)
          .set({
            state: body.to,
            ...(body.to === "closed" ? { closedAt: now } : {}),
            ...(body.to === "cancelled" ? { cancelledReason: body.reason ?? null } : {}),
          })
          .where(and(eq(exitRecord.id, exit.id), eq(exitRecord.version, body.version)))
          .returning();
        if (!updated) throw problems.conflict();
        if (body.to === "closed" || body.to === "cancelled") {
          await tx
            .update(task)
            .set(
              body.to === "closed"
                ? {
                    status: "done",
                    completedAt: now,
                    completedBy: access.tenantUserId,
                    evidenceType: "exit_record",
                    evidenceId: exit.id,
                  }
                : {
                    status: "cancelled",
                    statusReason: "The planned exit was cancelled",
                    cancelCode: "planned_exit_cancelled",
                  },
            )
            .where(
              and(
                eq(task.sourceId, exit.id),
                eq(task.kind, "people.exit_checklist"),
                inArray(task.status, ["open", "in_progress"]),
              ),
            );
        }
        await audit(c, tx, access, {
          action: `people.exit.${body.to}`,
          resourceType: "exit_record",
          resourceId: exit.id,
          reason: body.reason,
          scope: { personStatus: p.status },
        });
        return { exit: await exitOut(tx, updated) };
      });
      return c.json(view, 200);
    },
  );
