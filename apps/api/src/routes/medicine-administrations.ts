import { randomUUID } from "node:crypto";
import {
  AdministrationList,
  AdministrationRecorded,
  AdministrationsQuery,
  CheckDosingRecord,
  CorrectAdministration,
  DosingRecordList,
  DosingRecordOut,
  MedicineRound,
  RecordAdministration,
  RecordDosingRecord,
  RoundQuery,
  WitnessAdministration,
} from "@harbour/contracts";
import {
  medication,
  medicationAdministration,
  medicationAdministrationWitness,
  medicationDosingRecord,
  type Transaction,
} from "@harbour/db";
import {
  type AdministrationEscalation,
  type AdministrationInput,
  type AdministrationOutcome,
  type CompetenceOverride,
  can,
  checkAdministration,
  checkCompetenceGate,
  checkCorrection,
  checkDosingRecord,
  doseNotices,
  doseWindow,
  driftCorrectedTime,
  entryVersionIds,
  formatDose,
  isTimeCritical,
  type MarEntry,
  type MedicinesCompetence,
  marEntryDoses,
  marEntryStatus,
  prnStatus,
  recordDosingRecord,
  SCHEDULED_DOSE_WORDS,
  scheduledDoseState,
  ukIsoDate,
  variableDoseFor,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, gte, lte } from "drizzle-orm";
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
  type AdministrationRow,
  administrationOut,
  closeOutstandingDoseTask,
  dosingRecordOf,
  dosingRecordOut,
  effective,
  givenDoses,
  medicinesRates,
  personAdministrations,
  personDosingRecords,
  raiseEscalationTasks,
  supersededBy,
  witnessesFor,
} from "../services/medicine-administrations";
import {
  guardConcurrent,
  lockPerson,
  personEntries,
  requireDocuments,
  UNCHECKED_POLICY,
} from "../services/medicines";
import { loadPerson } from "../services/people";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";

/**
 * Administrations (Phase 2 slice 22; MEDS-002; medicines.md section 13). Slice 3's rules decide
 * every record (`checkAdministration`, `checkCorrection`); these routes read the facts the rules
 * need under the person's lock (every version of the person's entries, the doses already
 * recorded, the dosing records, the member's competence from the port and the rates), store what
 * the rules allow at the server's time, raise the escalations as tasks, and audit by id only.
 */

const tags = ["medicines"];
const ADMINISTER = "medicines.emar.administer" as const;
const MANAGE = "medicines.record.manage" as const;
const READERS = [MANAGE, ADMINISTER, "care.plan.read"] as const;
const PersonParam = z.object({ id: z.uuid() });
const RecordParam = z.object({ id: z.uuid() });
const EntryParam = z.object({ entryId: z.uuid() });
const HOUR_MS = 3_600_000;

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
    `administration_${issues[0]?.problem ?? "refused"}`,
    "This cannot be recorded like this.",
    issues.map((i) => i.message).join(" "),
  );
}

interface Competence {
  readonly competence: MedicinesCompetence;
  readonly override: CompetenceOverride | null;
}

async function competenceOf(
  c: Context<AppEnv>,
  tenantId: string,
  memberId: string,
  at: Date,
): Promise<Competence> {
  const port = c.get("services").medicines.competence;
  return {
    competence: await port.forMember(tenantId, memberId, at),
    override: await port.overrideFor(tenantId, memberId, at),
  };
}

/** What the rules need about the person, read under their lock. */
async function factsFor(tx: Transaction, personId: string, tenantId: string, now: Date) {
  const person = await loadPerson(tx, personId);
  const stored = await personEntries(tx, personId);
  const entries = stored.map((s) => s.entry);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const rows = await personAdministrations(tx, personId);
  const rates = await medicinesRates(tx, tenantId, person.nation, ukIsoDate(now));
  const dosingRecords = await personDosingRecords(tx, personId);
  return { person, entries, byId, rows, rates, dosingRecords };
}

/** The input the rules read, from the request and the stored facts. */
function inputFor(args: {
  readonly personId: string;
  readonly entry: MarEntry;
  readonly entries: readonly MarEntry[];
  readonly body: z.infer<typeof RecordAdministration> | z.infer<typeof CorrectAdministration>;
  readonly at: Date;
  readonly administrator: { id: string } & Competence;
  readonly rows: readonly AdministrationRow[];
  readonly byId: ReadonlyMap<string, MarEntry>;
  readonly dosingRecords: Awaited<ReturnType<typeof personDosingRecords>>;
  readonly givenBeforeRecorded: { reason: string } | null;
  readonly leaveOut?: string;
}): { input: AdministrationInput; versionIds: ReadonlySet<string> } {
  const versionIds = entryVersionIds(args.entry, args.entries);
  const rows = args.rows.filter((r) => r.id !== args.leaveOut);
  const recordedDueTimes = effective(rows)
    .filter((r) => versionIds.has(r.medicationId) && r.dueAt !== null)
    .map((r) => r.dueAt as Date);
  const dueAt = args.body.dueAt ? new Date(args.body.dueAt) : null;
  return {
    versionIds,
    input: {
      personId: args.personId,
      entry: args.entry,
      dueAt,
      outcome: args.body.outcome as AdministrationOutcome,
      reason: args.body.reason,
      amount: args.body.amount,
      amountDifferenceReason: args.body.amountDifferenceReason,
      at: args.at,
      timingReason: args.body.timingReason,
      intervalOverrideReason: args.body.intervalOverrideReason,
      administrator: { id: args.administrator.id, competence: args.administrator.competence },
      competenceOverride: args.administrator.override,
      policy: UNCHECKED_POLICY,
      alreadyRecorded:
        dueAt !== null && recordedDueTimes.some((t) => t.getTime() === dueAt.getTime()),
      givenBeforeRecorded: args.givenBeforeRecorded,
      recordedDueTimes,
      versionIds,
      history: givenDoses(rows, args.byId),
      dosingRecords: args.dosingRecords,
    },
  };
}

/** The checked dosing record a variable dose was given from, for the record. */
function dosingRecordUsed(
  input: AdministrationInput,
  versionIds: ReadonlySet<string>,
): string | null {
  const entry = input.entry;
  if (!entry || entry.directions.kind !== "regular" || !input.dueAt) return null;
  const dueAt = input.dueAt;
  const dose = marEntryDoses(entry, { from: dueAt, to: new Date(dueAt.getTime() + 1) }).find(
    (d) => d.dueAt.getTime() === dueAt.getTime(),
  );
  if (!dose || dose.dose.kind !== "variable") return null;
  const v = variableDoseFor(input.dosingRecords, versionIds, dose.date, dose.time);
  return v.ok ? v.recordId : null;
}

const RECORDED_AFTER =
  "Recorded after it was given: for the nurse in charge to review under your organisation's policy.";

function sameRecord(
  row: AdministrationRow,
  personId: string,
  body: z.infer<typeof RecordAdministration> | z.infer<typeof CorrectAdministration>,
): boolean {
  return (
    row.personId === personId &&
    row.medicationId === body.entryId &&
    (row.dueAt?.toISOString() ?? null) ===
      (body.dueAt ? new Date(body.dueAt).toISOString() : null) &&
    row.outcome === body.outcome &&
    (row.reasonCode ?? null) === (body.reason?.code ?? null) &&
    (row.quantity === null ? null : Number(row.quantity)) === (body.amount?.quantity ?? null) &&
    (row.unitCode ?? null) === (body.amount?.unitCode ?? null)
  );
}

async function outFor(tx: Transaction, row: AdministrationRow, rows: readonly AdministrationRow[]) {
  return administrationOut(row, supersededBy(rows), await witnessesFor(tx, [row.id]));
}

/** Stores a checked record, raises its tasks, closes an outstanding dose's task, audits it. */
async function store(
  c: Context<AppEnv>,
  tx: Transaction,
  access: TenantAccess,
  args: {
    readonly id: string;
    readonly personId: string;
    readonly locationId: string;
    readonly input: AdministrationInput;
    readonly versionIds: ReadonlySet<string>;
    readonly prescribed: unknown;
    readonly flags: readonly string[];
    readonly escalations: readonly AdministrationEscalation[];
    readonly givenBeforeRecordedReason: string | null;
    readonly deviceAt: Date | null;
    readonly deviceOffsetMs: number | null;
    readonly override: CompetenceOverride | null;
    readonly supersedesId: string | null;
    readonly correctionReason: string | null;
    readonly now: Date;
  },
) {
  const i = args.input;
  const [row] = await guardConcurrent(() =>
    tx
      .insert(medicationAdministration)
      .values({
        id: args.id,
        personId: args.personId,
        medicationId: (i.entry as MarEntry).id,
        dueAt: i.dueAt,
        outcome: i.outcome as string,
        reasonCode: i.reason?.code ?? null,
        reasonNote: i.reason?.note ?? null,
        quantity: i.amount ? String(i.amount.quantity) : null,
        unitCode: i.amount?.unitCode ?? null,
        prescribed: args.prescribed ?? null,
        dosingRecordId: dosingRecordUsed(i, args.versionIds),
        amountDifferenceReason: i.amountDifferenceReason,
        timingReason: i.timingReason,
        intervalOverrideReason: i.intervalOverrideReason,
        givenBeforeRecordedReason: args.givenBeforeRecordedReason,
        givenAt: i.at,
        deviceAt: args.deviceAt,
        deviceOffsetMs: args.deviceOffsetMs,
        recordedBy: access.tenantUserId,
        competenceOverride: args.override
          ? {
              approvedBy: args.override.approvedBy,
              from: args.override.from.toISOString(),
              until: args.override.until.toISOString(),
            }
          : null,
        flags: [...new Set(args.flags)],
        supersedesId: args.supersedesId,
        correctionReason: args.correctionReason,
      })
      .returning(),
  );
  const stored = row as AdministrationRow;
  const escalations = await raiseEscalationTasks(tx, {
    personId: args.personId,
    locationId: args.locationId,
    administrationId: stored.id,
    escalations: args.escalations,
    at: args.now,
  });
  if (i.dueAt) {
    await closeOutstandingDoseTask(tx, {
      entryIds: [...args.versionIds],
      dueAt: i.dueAt,
      administrationId: stored.id,
      by: access.tenantUserId,
      at: args.now,
    });
  }
  const corrected = args.supersedesId !== null;
  await audit(c, tx, access, {
    action: corrected ? "medicines.administration.corrected" : "medicines.administration.recorded",
    resourceType: "medication_administration",
    resourceId: stored.id,
    scope: {
      personId: args.personId,
      entryId: stored.medicationId,
      outcome: stored.outcome,
      flags: stored.flags,
      escalations: escalations.length,
      ...(corrected ? { supersedesId: args.supersedesId } : {}),
    },
  });
  await publish(tx, {
    context: "medicines",
    aggregateType: "medication_administration",
    aggregateId: stored.id,
    type: corrected ? "medicines.administration.corrected" : "medicines.administration.recorded",
    payload: { personId: args.personId, administrationId: stored.id },
  });
  return { stored, escalations };
}

function withRecordedAfter(
  escalations: readonly AdministrationEscalation[],
  always: boolean,
): AdministrationEscalation[] {
  if (!always || escalations.length > 0) return [...escalations];
  return [{ severity: "warning", reason: "review", message: RECORDED_AFTER }];
}

export const medicineAdministrationsRouter = createRouter()
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/medicine-administrations",
      tags,
      summary: "Record an administration",
      description:
        "What happened to a dose, checked by slice 3's rules at the server's time (or, for a dose recorded after it was given, at the time it was given, before now, with why). Idempotent by the client's id. Refusals are audited. Escalations become tasks for the nurse in charge.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: RecordAdministration } } },
      },
      responses: {
        200: jsonBody(AdministrationRecorded, "Already recorded with this id"),
        201: jsonBody(AdministrationRecorded, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, ADMINISTER);
      const { id: personId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const me = await competenceOf(c, access.tenantId, access.tenantUserId, now);
      const deny = (issues: readonly { problem: string; message: string }[]) =>
        new AuditedRefusal(refusal(issues), {
          action: "medicines.administration.recorded",
          outcome: "denied",
          resourceType: "medication_administration",
          resourceId: body.id,
          scope: { personId, entryId: body.entryId, problems: issues.map((x) => x.problem) },
        });
      const result = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          await lockPerson(tx, personId);
          const facts = await factsFor(tx, personId, access.tenantId, now);
          const resent = facts.rows.find((r) => r.id === body.id);
          if (resent) {
            if (!sameRecord(resent, personId, body) || resent.supersedesId !== null) {
              throw problems.conflict("This record id is already used for another record.");
            }
            return { status: 200 as const, administration: await outFor(tx, resent, facts.rows) };
          }
          const entry = facts.byId.get(body.entryId);
          if (!entry) throw problems.notFound();

          // The time: the server's on the round; a device's, drift-corrected; or, for a dose
          // recorded after it was given, the time it was given, which must be before now (#162).
          const gbr = body.givenBeforeRecorded;
          let at = now;
          let deviceAt: Date | null = null;
          let drifted = false;
          if (body.givenAt) {
            deviceAt = new Date(body.givenAt);
            const corrected = driftCorrectedTime(deviceAt, body.deviceOffsetMs, facts.rates);
            at = corrected.at;
            drifted = corrected.drifted;
          }
          if (gbr) {
            if (!body.givenAt) {
              throw deny([
                {
                  problem: "given_at_required",
                  message: "Say when the dose was given.",
                },
              ]);
            }
            if (at.getTime() >= now.getTime()) {
              throw deny([
                {
                  problem: "given_at_not_before_now",
                  message: "A dose recorded after it was given was given before now.",
                },
              ]);
            }
            // Whoever records it now needs current competence, or an override of an expired one.
            const gate = checkCompetenceGate(
              access.tenantUserId,
              me.competence,
              me.override,
              now,
              facts.rates,
            );
            if (!gate.ok) throw deny([{ problem: gate.problem, message: gate.message }]);
          } else if (
            body.givenAt &&
            Math.abs(at.getTime() - now.getTime()) > facts.rates.clockDriftMinutes * 60_000
          ) {
            throw deny([
              {
                problem: "given_at_not_now",
                message:
                  "This is recorded as given now. If it was given earlier, record it as given before it was recorded, with why.",
              },
            ]);
          }

          const giver = gbr
            ? {
                id: access.tenantUserId,
                ...(await competenceOf(c, access.tenantId, access.tenantUserId, at)),
              }
            : { id: access.tenantUserId, ...me };
          const { input, versionIds } = inputFor({
            personId,
            entry,
            entries: facts.entries,
            body,
            at,
            administrator: giver,
            rows: facts.rows,
            byId: facts.byId,
            dosingRecords: facts.dosingRecords,
            givenBeforeRecorded: gbr,
          });
          const checked = checkAdministration(input, facts.rates);
          if (!checked.ok) throw deny(checked.issues);
          const flags = [
            ...checked.flags,
            ...(gbr ? ["given_before_recorded"] : []),
            ...(drifted ? ["clock_drift"] : []),
          ];
          const { stored, escalations } = await store(c, tx, access, {
            id: body.id,
            personId,
            locationId: facts.person.locationId,
            input,
            versionIds,
            prescribed: checked.prescribed,
            flags,
            escalations: withRecordedAfter(checked.escalations, gbr !== null),
            givenBeforeRecordedReason: gbr?.reason ?? null,
            deviceAt,
            deviceOffsetMs: body.deviceOffsetMs,
            override: checked.flags.includes("competence_override") ? giver.override : null,
            supersedesId: null,
            correctionReason: null,
            now,
          });
          return {
            status: 201 as const,
            administration: await outFor(tx, stored, [...facts.rows, stored]),
            escalations,
          };
        }),
      );
      return c.json(
        { administration: result.administration, escalations: result.escalations ?? [] },
        result.status,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/medicine-administrations/{id}/corrections",
      tags,
      summary: "Correct an administration record",
      description:
        "A new record that refers to the latest record for the dose, with why; the record it corrects is kept and shown struck through. By its author or a holder of medicines.record.manage, with current competence. Checked by slice 3's checkCorrection.",
      security,
      request: {
        params: RecordParam,
        body: { content: { "application/json": { schema: CorrectAdministration } } },
      },
      responses: {
        200: jsonBody(AdministrationRecorded, "Already corrected with this id"),
        201: jsonBody(AdministrationRecorded, "Corrected"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [ADMINISTER, MANAGE]);
      const { id: originalId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const me = await competenceOf(c, access.tenantId, access.tenantUserId, now);
      const result = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          const [first] = await tx
            .select({ personId: medicationAdministration.personId })
            .from(medicationAdministration)
            .where(eq(medicationAdministration.id, originalId));
          if (!first) throw problems.notFound();
          const personId = first.personId;
          await lockPerson(tx, personId);
          const facts = await factsFor(tx, personId, access.tenantId, now);
          const original = facts.rows.find((r) => r.id === originalId) as AdministrationRow;
          const deny = (issues: readonly { problem: string; message: string }[]) =>
            new AuditedRefusal(refusal(issues), {
              action: "medicines.administration.corrected",
              outcome: "denied",
              resourceType: "medication_administration",
              resourceId: originalId,
              scope: { personId, problems: issues.map((x) => x.problem) },
            });
          const resent = facts.rows.find((r) => r.id === body.id);
          if (resent) {
            if (resent.supersedesId !== originalId || !sameRecord(resent, personId, body)) {
              throw problems.conflict("This record id is already used for another record.");
            }
            return { status: 200 as const, administration: await outFor(tx, resent, facts.rows) };
          }
          // Its author, or a holder of medicines.record.manage (rule 23).
          if (original.recordedBy !== access.tenantUserId && !can(access.effective, MANAGE)) {
            throw deny([
              {
                problem: "not_author",
                message:
                  "Only the person who recorded it, or someone who manages the medicines record, can correct it.",
              },
            ]);
          }
          const entry = facts.byId.get(body.entryId);
          if (!entry) throw problems.notFound();
          const at = new Date(body.givenAt);
          // What the corrected record says is checked as a record made after the event, the member
          // named being whoever gave the dose then (rule 23).
          const giver = {
            id: original.recordedBy,
            ...(await competenceOf(c, access.tenantId, original.recordedBy, at)),
          };
          const { input, versionIds } = inputFor({
            personId,
            entry,
            entries: facts.entries,
            body,
            at,
            administrator: giver,
            rows: facts.rows,
            byId: facts.byId,
            dosingRecords: facts.dosingRecords,
            givenBeforeRecorded: null,
            leaveOut: original.id,
          });
          const corrected = supersededBy(facts.rows);
          const checked = checkCorrection(
            {
              id: original.id,
              personId: original.personId,
              entryId: original.medicationId,
              dueAt: original.dueAt,
              at: original.givenAt,
              recordedBy: original.recordedBy,
              serverReceivedAt: original.recordedAt,
              supersededById: corrected.get(original.id) ?? null,
            },
            {
              reason: body.correctionReason,
              record: input,
              correctedBy: {
                id: access.tenantUserId,
                competence: me.competence,
                override: me.override,
                at: now,
              },
            },
            facts.rates,
          );
          if (!checked.ok) throw deny(checked.issues);
          const { stored, escalations } = await store(c, tx, access, {
            id: body.id,
            personId,
            locationId: facts.person.locationId,
            input,
            versionIds,
            prescribed: checked.prescribed,
            flags: checked.flags,
            escalations: checked.escalations,
            givenBeforeRecordedReason: null,
            deviceAt: null,
            deviceOffsetMs: null,
            override: checked.flags.includes("competence_override") ? me.override : null,
            supersedesId: original.id,
            correctionReason: body.correctionReason,
            now,
          });
          return {
            status: 201 as const,
            administration: await outFor(tx, stored, [...facts.rows, stored]),
            escalations,
          };
        }),
      );
      return c.json(
        { administration: result.administration, escalations: result.escalations ?? [] },
        result.status,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/medicine-administrations/{id}/witness",
      tags,
      summary: "Witness an administration (second signature)",
      description:
        "The witness signs with their own session and a fresh step-up (ADR-0084); never the recorder, and only with current medicines competence. Once per record.",
      security,
      request: {
        params: RecordParam,
        body: { content: { "application/json": { schema: WitnessAdministration } } },
      },
      responses: {
        200: jsonBody(AdministrationRecorded, "Witnessed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, ADMINISTER);
      const { id } = c.req.valid("param");
      if (!stepUpFresh(access)) throw problems.stepUp();
      const now = new Date();
      const me = await competenceOf(c, access.tenantId, access.tenantUserId, now);
      const out = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          const [row] = await tx
            .select()
            .from(medicationAdministration)
            .where(eq(medicationAdministration.id, id));
          if (!row) throw problems.notFound();
          const deny = (problem: string, message: string) =>
            new AuditedRefusal(refusal([{ problem, message }]), {
              action: "medicines.administration.witnessed",
              outcome: "denied",
              resourceType: "medication_administration",
              resourceId: id,
              scope: { personId: row.personId, problems: [problem] },
            });
          if (row.recordedBy === access.tenantUserId) {
            throw deny(
              "witness_is_recorder",
              "A witness is a second person, not the one who recorded it.",
            );
          }
          if (me.competence !== "current") {
            throw deny(
              "witness_not_competent",
              "Only someone whose medicines competence is current can witness a dose.",
            );
          }
          await guardConcurrent(() =>
            tx.insert(medicationAdministrationWitness).values({
              personId: row.personId,
              administrationId: row.id,
              witnessId: access.tenantUserId,
              method: "step_up",
            }),
          );
          await audit(c, tx, access, {
            action: "medicines.administration.witnessed",
            resourceType: "medication_administration",
            resourceId: row.id,
            scope: { personId: row.personId },
          });
          const rows = await personAdministrations(tx, row.personId);
          return { administration: await outFor(tx, row, rows), escalations: [] };
        }),
      );
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/medicine-administrations",
      tags,
      summary: "A person's administration records in a period",
      description:
        "Every record given in the period, with corrections linked (the corrected record shown struck through). Audited.",
      security,
      request: { params: PersonParam, query: AdministrationsQuery },
      responses: {
        200: jsonBody(AdministrationList, "The records"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [...READERS]);
      const { id: personId } = c.req.valid("param");
      const { from, to } = c.req.valid("query");
      const out = await withTenant(c, async (tx) => {
        await loadPerson(tx, personId);
        const all = await personAdministrations(tx, personId);
        const rows = await tx
          .select()
          .from(medicationAdministration)
          .where(
            and(
              eq(medicationAdministration.personId, personId),
              gte(medicationAdministration.givenAt, new Date(from)),
              lte(medicationAdministration.givenAt, new Date(to)),
            ),
          );
        const witnesses = await witnessesFor(
          tx,
          rows.map((r) => r.id),
        );
        const correctedBy = supersededBy(all);
        await audit(c, tx, access, {
          action: "medicines.administration.viewed",
          resourceType: "person",
          resourceId: personId,
          scope: { count: rows.length },
        });
        return {
          administrations: rows
            .sort((a, b) => a.givenAt.getTime() - b.givenAt.getTime())
            .map((r) => administrationOut(r, correctedBy, witnesses)),
        };
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/medicine-round",
      tags,
      summary: "The doses around a time, with their state, and the when-required status",
      description:
        "Scheduled doses from 12 hours before to 12 hours after the time, each with its window, state in words and notices; and each when-required medicine's last given, 24-hour total and when next. Audited.",
      security,
      request: { params: PersonParam, query: RoundQuery },
      responses: {
        200: jsonBody(MedicineRound, "The round"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [...READERS]);
      const { id: personId } = c.req.valid("param");
      const query = c.req.valid("query");
      const now = new Date();
      const at = query.at ? new Date(query.at) : now;
      const out = await withTenant(c, async (tx) => {
        const facts = await factsFor(tx, personId, access.tenantId, at);
        const eff = effective(facts.rows);
        const history = givenDoses(facts.rows, facts.byId);
        const range = {
          from: new Date(at.getTime() - 12 * HOUR_MS),
          to: new Date(at.getTime() + 12 * HOUR_MS),
        };
        const doses = facts.entries
          .flatMap((entry) => {
            const versionIds = entryVersionIds(entry, facts.entries);
            const status = marEntryStatus(entry, at, UNCHECKED_POLICY);
            return marEntryDoses(entry, range).map((d) => {
              const window = doseWindow(d.dueAt, isTimeCritical(entry), facts.rates);
              const recorded = eff.some(
                (r) => versionIds.has(r.medicationId) && r.dueAt?.getTime() === d.dueAt.getTime(),
              );
              const state = scheduledDoseState(window, recorded, now);
              return {
                entryId: entry.id,
                dueAt: d.dueAt.toISOString(),
                date: d.date,
                time: d.time,
                doseInWords: formatDose(d.dose),
                timeCritical: window.timeCritical,
                state,
                stateInWords: SCHEDULED_DOSE_WORDS[state],
                opensAt: window.opensAt.toISOString(),
                lateAfter: window.lateAfter.toISOString(),
                notices: [...doseNotices(entry, facts.rates)],
                entryStatus: status,
              };
            });
          })
          .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
        const whenRequired = facts.entries
          .filter(
            (e) =>
              e.directions.kind === "when_required" &&
              e.withdrawn === null &&
              marEntryStatus(e, at, UNCHECKED_POLICY).mayGive,
          )
          .map((entry) => {
            const s = prnStatus(
              entry,
              entryVersionIds(entry, facts.entries),
              history,
              at,
              facts.rates,
            );
            return {
              entryId: entry.id,
              lastGiven: s.lastGiven
                ? {
                    at: s.lastGiven.at.toISOString(),
                    by: s.lastGiven.by,
                    synced: s.lastGiven.synced,
                  }
                : null,
              givenInLast24Hours: s.givenInLast24Hours,
              maxPer24Hours: s.maxPer24Hours,
              remaining: s.remaining,
              nextAllowedAt: s.nextAllowedAt?.toISOString() ?? null,
              notices: [...s.notices],
            };
          });
        await audit(c, tx, access, {
          action: "medicines.administration.viewed",
          resourceType: "person",
          resourceId: personId,
          scope: { round: at.toISOString() },
        });
        return { at: at.toISOString(), doses, whenRequired };
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/medicines/{entryId}/dosing-records",
      tags,
      summary: "Record a dosing record for a variable dose",
      description:
        "The doses for each day and time from its source (for example the anticoagulant clinic's), not yet checked. Checked by slice 3's recordDosingRecord. Audited.",
      security,
      request: {
        params: EntryParam,
        body: { content: { "application/json": { schema: RecordDosingRecord } } },
      },
      responses: {
        201: jsonBody(DosingRecordOut, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { entryId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const out = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          const entry = await entryById(tx, entryId);
          await lockPerson(tx, entry.personId);
          await requireDocuments(tx, entry.personId, [body.source.documentId]);
          const result = recordDosingRecord(
            entry,
            { personId: entry.personId, entryId: entry.id, source: body.source, doses: body.doses },
            { id: randomUUID(), by: access.tenantUserId, at: now },
          );
          if (!result.ok) {
            throw new AuditedRefusal(refusal(result.issues), {
              action: "medicines.dosing_record.recorded",
              outcome: "denied",
              resourceType: "medication",
              resourceId: entryId,
              scope: { personId: entry.personId, problems: result.issues.map((i) => i.problem) },
            });
          }
          const r = result.record;
          const [row] = await tx
            .insert(medicationDosingRecord)
            .values({
              id: r.id,
              personId: r.personId,
              medicationId: r.entryId,
              sourceKind: r.source.kind,
              sourceReference: r.source.reference,
              sourceDocumentId: r.source.documentId,
              doses: r.doses,
              recordedBy: r.recordedBy,
            })
            .returning();
          await audit(c, tx, access, {
            action: "medicines.dosing_record.recorded",
            resourceType: "medication_dosing_record",
            resourceId: r.id,
            scope: { personId: r.personId, entryId: r.entryId, doses: r.doses.length },
          });
          return dosingRecordOut(dosingRecordOf(row as typeof medicationDosingRecord.$inferSelect));
        }),
      );
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/dosing-records/{id}/check",
      tags,
      summary: "Second-check a dosing record against its source",
      description:
        "By a second person with current medicines competence (from the competence port), who compared it with the source. Set once. Audited, refusals included.",
      security,
      request: {
        params: RecordParam,
        body: { content: { "application/json": { schema: CheckDosingRecord } } },
      },
      responses: {
        200: jsonBody(DosingRecordOut, "Checked"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const me = await competenceOf(c, access.tenantId, access.tenantUserId, now);
      const out = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          const [first] = await tx
            .select()
            .from(medicationDosingRecord)
            .where(eq(medicationDosingRecord.id, id));
          if (!first) throw problems.notFound();
          await lockPerson(tx, first.personId);
          const [row] = await tx
            .select()
            .from(medicationDosingRecord)
            .where(eq(medicationDosingRecord.id, id));
          const record = dosingRecordOf(row as typeof medicationDosingRecord.$inferSelect);
          const result = checkDosingRecord(record, {
            by: access.tenantUserId,
            at: now,
            competence: me.competence,
            comparedWithSource: body.comparedWithSource,
            outcome: body.outcome,
            difference: body.difference,
          });
          if (!result.ok) {
            throw new AuditedRefusal(refusal(result.issues), {
              action: "medicines.dosing_record.checked",
              outcome: "denied",
              resourceType: "medication_dosing_record",
              resourceId: id,
              scope: { personId: record.personId, problems: result.issues.map((i) => i.problem) },
            });
          }
          const check = result.record.secondCheck as NonNullable<typeof result.record.secondCheck>;
          const [updated] = await guardConcurrent(() =>
            tx
              .update(medicationDosingRecord)
              .set({
                checkBy: check.by,
                checkAt: check.at,
                checkOutcome: check.outcome,
                checkDifference: check.difference,
              })
              .where(eq(medicationDosingRecord.id, id))
              .returning(),
          );
          await audit(c, tx, access, {
            action: "medicines.dosing_record.checked",
            resourceType: "medication_dosing_record",
            resourceId: id,
            scope: { personId: record.personId, outcome: check.outcome },
          });
          return dosingRecordOut(
            dosingRecordOf(updated as typeof medicationDosingRecord.$inferSelect),
          );
        }),
      );
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/medicines/{entryId}/dosing-records",
      tags,
      summary: "The dosing records of a variable-dose medicine",
      description: "Every dosing record of the medicine's versions, newest last. Audited.",
      security,
      request: { params: EntryParam },
      responses: {
        200: jsonBody(DosingRecordList, "The dosing records"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [...READERS]);
      const { entryId } = c.req.valid("param");
      const out = await withTenant(c, async (tx) => {
        const entry = await entryById(tx, entryId);
        const entries = (await personEntries(tx, entry.personId)).map((s) => s.entry);
        const versionIds = entryVersionIds(entry, entries);
        const records = (await personDosingRecords(tx, entry.personId)).filter((r) =>
          versionIds.has(r.entryId),
        );
        await audit(c, tx, access, {
          action: "medicines.dosing_record.viewed",
          resourceType: "medication",
          resourceId: entryId,
          scope: { personId: entry.personId, count: records.length },
        });
        return { dosingRecords: records.map(dosingRecordOut) };
      });
      return c.json(out, 200);
    },
  );

/** One stored entry version, within the caller's scope (RLS). */
async function entryById(tx: Transaction, entryId: string): Promise<MarEntry> {
  const [row] = await tx
    .select({ personId: medication.personId })
    .from(medication)
    .where(eq(medication.id, entryId));
  if (!row) throw problems.notFound();
  const entry = (await personEntries(tx, row.personId)).find((s) => s.entry.id === entryId);
  if (!entry) throw problems.notFound();
  return entry.entry;
}
