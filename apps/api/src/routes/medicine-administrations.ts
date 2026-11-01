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
  type CdWitnessInput,
  pageFor,
  witnessPolicyFor,
  writeCdEntry,
} from "../services/controlled-drugs";
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
  readonly recordedAt: Date;
  readonly givenBeforeRecorded: AdministrationInput["givenBeforeRecorded"];
  readonly leaveOut?: string;
}): { input: AdministrationInput; versionIds: ReadonlySet<string> } {
  const versionIds = entryVersionIds(args.entry, args.entries);
  // What stands now, less the record being corrected: never the records it replaced, which would
  // count again (clinical review H4).
  const current = effective(args.rows).filter((r) => r.id !== args.leaveOut);
  const recordedDueTimes = current
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
      recordedAt: args.recordedAt,
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
      history: givenDoses(current, args.byId),
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
  if (entry?.directions.kind !== "regular" || !input.dueAt) return null;
  const dueAt = input.dueAt;
  const dose = marEntryDoses(entry, { from: dueAt, to: new Date(dueAt.getTime() + 1) }).find(
    (d) => d.dueAt.getTime() === dueAt.getTime(),
  );
  if (dose?.dose.kind !== "variable") return null;
  const v = variableDoseFor(input.dosingRecords, versionIds, dose.date, dose.time);
  return v.ok ? v.recordId : null;
}

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
    (row.unitCode ?? null) === (body.amount?.unitCode ?? null) &&
    (row.reasonNote ?? null) === (body.reason?.note ?? null) &&
    (row.timingReason ?? null) === (body.timingReason ?? null) &&
    (row.intervalOverrideReason ?? null) === (body.intervalOverrideReason ?? null) &&
    (row.amountDifferenceReason ?? null) === (body.amountDifferenceReason ?? null) &&
    (body.givenAt === null ||
      row.deviceAt?.toISOString() === new Date(body.givenAt).toISOString() ||
      row.givenAt.toISOString() === new Date(body.givenAt).toISOString())
  );
}

/**
 * Any unique clash on insert reads the same: the id is in use (here, in another organisation or
 * for someone out of scope) or the dose was recorded meanwhile. Nothing says which (security
 * review L5); under the person's lock only the first can happen.
 */
async function uniqueId<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const code =
      (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
    if (code === "23505") {
      throw problems.conflict("This record id cannot be used. Read the record again and resend.");
    }
    return guardConcurrent(() => Promise.reject(error));
  }
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
    readonly administeredBy: string;
    readonly overrides: readonly CompetenceOverride[];
    readonly supersedesId: string | null;
    readonly correctionReason: string | null;
    readonly cdEntryId?: string | null;
    readonly now: Date;
  },
) {
  const i = args.input;
  const [row] = await uniqueId(() =>
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
        administeredBy: args.administeredBy,
        recordedBy: access.tenantUserId,
        competenceOverride:
          args.overrides.length > 0
            ? args.overrides.map((o) => ({
                memberId: o.memberId,
                approvedBy: o.approvedBy,
                from: o.from.toISOString(),
                until: o.until.toISOString(),
              }))
            : null,
        flags: [...new Set(args.flags)],
        supersedesId: args.supersedesId,
        correctionReason: args.correctionReason,
        cdEntryId: args.cdEntryId ?? null,
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
          // Visible first (RLS), then serialised on the person (security review L9).
          await loadPerson(tx, personId);
          await lockPerson(tx, personId);
          const facts = await factsFor(tx, personId, access.tenantId, now);
          const resent = facts.rows.find((r) => r.id === body.id);
          if (resent) {
            if (!sameRecord(resent, personId, body) || resent.supersedesId !== null) {
              throw problems.conflict(
                "This record id cannot be used. Read the record again and resend.",
              );
            }
            return { status: 200 as const, administration: await outFor(tx, resent, facts.rows) };
          }
          const entry = facts.byId.get(body.entryId);
          if (!entry) throw problems.notFound();
          // A controlled drug given moves stock: its register entry is written with the record, with
          // a fresh step-up and the witness's signature (slice 34; ADR-0084).
          const cd =
            body.outcome === "given" && (await isControlledDrug(tx, entry.id))
              ? { cdEntryId: randomUUID() }
              : null;
          if (cd) requireCdSignatures(access, body.controlledDrug, body.id, personId, deny);

          // The time is the server's: on the round a dose is recorded as it is given. Only a dose
          // recorded after it was given carries its own time, which slice 3's rules require to be
          // before the server's (#162); devices send theirs from slice 68 (security review M1).
          const gbr = body.givenBeforeRecorded;
          if (!gbr && (body.givenAt || body.givenBy)) {
            throw deny([
              {
                problem: "given_at_only_after_giving",
                message:
                  "On the round a dose is recorded at the time it is given. If it was given earlier, record it as given before it was recorded, with why.",
              },
            ]);
          }
          if (gbr && !body.givenAt) {
            throw deny([{ problem: "given_at_required", message: "Say when the dose was given." }]);
          }
          let at = now;
          let deviceAt: Date | null = null;
          let drifted = false;
          if (gbr && body.givenAt) {
            deviceAt = new Date(body.givenAt);
            const corrected = driftCorrectedTime(deviceAt, body.deviceOffsetMs, facts.rates);
            at = corrected.at;
            drifted = corrected.drifted;
          }
          // Who gave it: the recorder, or (recorded after giving) the member named, whose
          // competence then the rules check; the recorder's competence now is checked too.
          const giverId = gbr ? (body.givenBy ?? access.tenantUserId) : access.tenantUserId;
          const giver = {
            id: giverId,
            ...(gbr ? await competenceOf(c, access.tenantId, giverId, at) : me),
          };
          const { input, versionIds } = inputFor({
            personId,
            entry,
            entries: facts.entries,
            body,
            at,
            recordedAt: now,
            administrator: giver,
            rows: facts.rows,
            byId: facts.byId,
            dosingRecords: facts.dosingRecords,
            givenBeforeRecorded: gbr
              ? {
                  reason: gbr.reason,
                  recordedBy: {
                    id: access.tenantUserId,
                    competence: me.competence,
                    override: me.override,
                  },
                }
              : null,
          });
          const checked = checkAdministration(input, facts.rates);
          if (!checked.ok) throw deny(checked.issues);
          const { stored, escalations } = await store(c, tx, access, {
            id: body.id,
            personId,
            locationId: facts.person.locationId,
            input,
            versionIds,
            prescribed: checked.prescribed,
            flags: [...checked.flags, ...(drifted ? ["clock_drift"] : [])],
            escalations: checked.escalations,
            givenBeforeRecordedReason: gbr?.reason ?? null,
            deviceAt,
            deviceOffsetMs: gbr ? body.deviceOffsetMs : null,
            administeredBy: giverId,
            overrides: checked.flags.includes("competence_override")
              ? [giver.override, gbr ? me.override : null].filter(
                  (o): o is CompetenceOverride => o !== null,
                )
              : [],
            supersedesId: null,
            correctionReason: null,
            cdEntryId: cd?.cdEntryId ?? null,
            now,
          });
          if (cd && body.amount) {
            await writeRegisterEntry(c, tx, access, deny, {
              id: cd.cdEntryId,
              entry,
              locationId: facts.person.locationId,
              movement: "administration",
              quantity: body.amount.quantity,
              unitCode: body.amount.unitCode,
              correctsId: null,
              corrects: null,
              reason: null,
              occurredAt: at,
              witness: body.controlledDrug as CdWitnessInput,
              administrationId: body.id,
              now,
            });
          }
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
              throw problems.conflict(
                "This record id cannot be used. Read the record again and resend.",
              );
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
          // A correction says what happened then, never later than now (security review M2).
          if (at.getTime() > now.getTime()) {
            throw deny([
              {
                problem: "given_at_in_future",
                message: "A correction says what happened at a time that has passed.",
              },
            ]);
          }
          // What the corrected record says is checked as a record made after the event, the member
          // named being whoever gave the dose then (rule 23): the member the record named, unless
          // the correction names another.
          const giverId = body.givenBy ?? original.administeredBy;
          const giver = {
            id: giverId,
            ...(await competenceOf(c, access.tenantId, giverId, at)),
          };
          const { input, versionIds } = inputFor({
            personId,
            entry,
            entries: facts.entries,
            body,
            at,
            recordedAt: now,
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
              outcome: original.outcome as AdministrationOutcome,
              amount:
                original.quantity !== null && original.unitCode !== null
                  ? { quantity: Number(original.quantity), unitCode: original.unitCode }
                  : null,
              administeredBy: original.administeredBy,
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
              },
            },
            facts.rates,
          );
          if (!checked.ok) throw deny(checked.issues);
          const cdMove = (await isControlledDrug(tx, entry.id))
            ? registerMoveForCorrection(original, body, at)
            : null;
          if (cdMove) requireCdSignatures(access, body.controlledDrug, body.id, personId, deny);
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
            administeredBy: giverId,
            overrides: checked.flags.includes("competence_override")
              ? [giver.override, me.override].filter((o): o is CompetenceOverride => o !== null)
              : [],
            supersedesId: original.id,
            correctionReason: body.correctionReason,
            cdEntryId: cdMove?.id ?? null,
            now,
          });
          if (cdMove) {
            await writeRegisterEntry(c, tx, access, deny, {
              ...cdMove,
              entry,
              locationId: facts.person.locationId,
              unitCode: body.amount?.unitCode ?? null,
              reason: cdMove.movement === "correction" ? body.correctionReason : null,
              occurredAt: now,
              witness: body.controlledDrug as CdWitnessInput,
              administrationId: body.id,
              now,
            });
          }
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
      const now = new Date();
      const me = await competenceOf(c, access.tenantId, access.tenantUserId, now);
      const out = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          // The second signature needs the witness's own fresh step-up (ADR-0084); a refusal is
          // audited like any other (security review L6).
          if (!stepUpFresh(access)) {
            throw new AuditedRefusal(problems.stepUp(), {
              action: "medicines.administration.witnessed",
              outcome: "denied",
              resourceType: "medication_administration",
              resourceId: id,
              scope: { problems: ["step_up_required"] },
            });
          }
          const [first] = await tx
            .select({ personId: medicationAdministration.personId })
            .from(medicationAdministration)
            .where(eq(medicationAdministration.id, id));
          if (!first) throw problems.notFound();
          await lockPerson(tx, first.personId);
          const rows = await personAdministrations(tx, first.personId);
          const row = rows.find((r) => r.id === id) as AdministrationRow;
          const deny = (problem: string, message: string) =>
            new AuditedRefusal(refusal([{ problem, message }]), {
              action: "medicines.administration.witnessed",
              outcome: "denied",
              resourceType: "medication_administration",
              resourceId: id,
              scope: { personId: row.personId, problems: [problem] },
            });
          if (
            row.recordedBy === access.tenantUserId ||
            row.administeredBy === access.tenantUserId
          ) {
            throw deny(
              "witness_is_recorder",
              "A witness is a second person, not the one who recorded or gave it.",
            );
          }
          if (supersededBy(rows).has(row.id)) {
            throw deny(
              "witness_corrected_record",
              "This record has been corrected. Witness the latest record for the dose.",
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
      const span = new Date(to).getTime() - new Date(from).getTime();
      // At most 31 days per read, from before to (security review L8).
      if (span < 0 || span > 31 * 24 * HOUR_MS) {
        throw problems.invalid("Choose a period of up to 31 days, its start before its end.");
      }
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

/** Whether the entry's dm+d product is a controlled drug (its schedule comes from slice 10). */
async function isControlledDrug(tx: Transaction, entryId: string): Promise<boolean> {
  const [row] = await tx
    .select({ cd: medication.cdSchedule })
    .from(medication)
    .where(eq(medication.id, entryId));
  return Boolean(row?.cd);
}

type Deny = (issues: readonly { problem: string; message: string }[]) => Error;

/** A controlled drug's stock moves only with a fresh step-up and a second signature (ADR-0084). */
function requireCdSignatures(
  access: TenantAccess,
  witness: CdWitnessInput | null,
  recordId: string,
  personId: string,
  deny: Deny,
) {
  if (!stepUpFresh(access)) {
    throw new AuditedRefusal(problems.stepUp(), {
      action: "medicines.cd.entry_recorded",
      outcome: "denied",
      resourceType: "medication_administration",
      resourceId: recordId,
      scope: { personId, problems: ["step_up_required"] },
    });
  }
  if (!witness) {
    throw deny([
      {
        problem: "cd_witness_required",
        message:
          "This is a controlled drug. Record the witness's signature, or, where your policy allows, why no witness was available.",
      },
    ]);
  }
}

/**
 * What a correction of a controlled drug's administration does to the register (medicines.md
 * 14.4): nothing when the amount given and its time stand; an administration entry when a dose
 * not given before is now given; otherwise a correction of the entry it named, by the signed
 * change in what was given (a detail correction when only the time moved).
 */
function registerMoveForCorrection(
  original: AdministrationRow,
  body: z.infer<typeof CorrectAdministration>,
  at: Date,
): {
  id: string;
  movement: "administration" | "correction";
  quantity: number;
  correctsId: string | null;
  corrects: "quantity" | "detail" | null;
} | null {
  const before = original.outcome === "given" && original.quantity ? Number(original.quantity) : 0;
  const after = body.outcome === "given" && body.amount ? body.amount.quantity : 0;
  const moved = before > 0 && after > 0 && original.givenAt.getTime() !== at.getTime();
  if (before === after && !moved) return null;
  if (before === 0 || !original.cdEntryId) {
    return after > 0
      ? {
          id: randomUUID(),
          movement: "administration",
          quantity: after,
          correctsId: null,
          corrects: null,
        }
      : null;
  }
  const change = Math.round((before - after) * 1000) / 1000;
  return {
    id: randomUUID(),
    movement: "correction",
    quantity: change,
    correctsId: original.cdEntryId,
    corrects: change === 0 ? "detail" : "quantity",
  };
}

/** Writes the register entry for an administration or its correction, on the person's page. */
async function writeRegisterEntry(
  c: Context<AppEnv>,
  tx: Transaction,
  access: TenantAccess,
  deny: Deny,
  e: {
    readonly id: string;
    readonly entry: MarEntry;
    readonly locationId: string;
    readonly movement: "administration" | "correction";
    readonly quantity: number;
    readonly unitCode: string | null;
    readonly correctsId: string | null;
    readonly corrects: "quantity" | "detail" | null;
    readonly reason: string | null;
    readonly occurredAt: Date;
    readonly witness: CdWitnessInput;
    readonly administrationId: string;
    readonly now: Date;
  },
) {
  const { page } = await pageFor(tx, e.entry, access.tenantUserId);
  if (e.unitCode !== null && e.unitCode !== page.unitCode) {
    throw deny([
      {
        problem: "cd_unit",
        message: `The register counts this medicine in ${page.unitName}. Record the amount in that unit.`,
      },
    ]);
  }
  const result = await writeCdEntry(tx, {
    id: e.id,
    page,
    movement: e.movement,
    quantity: e.quantity,
    occurredAt: e.occurredAt,
    correctsId: e.correctsId,
    corrects: e.corrects,
    reason: e.reason,
    counterparty: null,
    reference: null,
    witness: e.witness,
    administrationId: e.administrationId,
    recordedBy: access.tenantUserId,
    policy: await witnessPolicyFor(tx, e.locationId),
    now: e.now,
  });
  if (!result.ok) throw deny(result.issues);
  await audit(c, tx, access, {
    action: "medicines.cd.entry_recorded",
    resourceType: "controlled_drug_entry",
    resourceId: result.row.id,
    scope: {
      personId: page.personId,
      pageId: page.id,
      movement: result.row.movement,
      seq: result.row.seq,
      administrationId: e.administrationId,
    },
  });
}

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
