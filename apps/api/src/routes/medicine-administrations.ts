import { randomUUID } from "node:crypto";
import {
  AdministrationList,
  AdministrationRecorded,
  AdministrationsQuery,
  CheckDosingRecord,
  ConflictRaised,
  CorrectAdministration,
  DEVICE_HEADER,
  DosingRecordList,
  DosingRecordOut,
  MedicineRound,
  type PointOfCare,
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
  driftCorrectedTime,
  entryVersionIds,
  type MarEntry,
  type MedicinesCompetence,
  marEntryDoses,
  POINT_OF_CARE_WORDS,
  type PointOfCareIssue,
  pointOfCareIssues,
  recordDosingRecord,
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
  pageEntries,
  pageFor,
  requireCdRecording,
  witnessPolicyFor,
  writeCdEntry,
} from "../services/controlled-drugs";
import {
  type DeviceSignaturesInput,
  deviceSignatureProblems,
  deviceWitnessAssertion,
} from "../services/device-signatures";
import { offlineWindowDaysOf } from "../services/devices";
import { dmdGtinMatches } from "../services/dmd";

/** The time in a UUIDv7 (its first 48 bits, in milliseconds), or null for another version. */
function uuidV7Time(id: string): Date | null {
  const hex = id.replace(/-/g, "");
  if (hex.length !== 32 || hex[12] !== "7") return null;
  return new Date(Number.parseInt(hex.slice(0, 12), 16));
}

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
  conflictForClientRecord,
  pendingConflicts,
  raiseConflict,
  roundFor,
} from "../services/medicine-rounds";
import {
  neverFailingTheDose,
  raiseOutOfStockTask,
  stockOnCorrection,
  stockOnDose,
} from "../services/medicine-stock";
import {
  guardConcurrent,
  lockPerson,
  personEntries,
  requireDocuments,
  UNCHECKED_POLICY,
} from "../services/medicines";
import { authorityMarks } from "../services/medicines-authority";
import { loadPerson } from "../services/people";
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
  /** The request's own transaction, when called inside one, so no second connection opens. */
  tx?: Transaction,
): Promise<Competence> {
  const port = c.get("services").medicines.competence;
  return {
    competence: await port.forMember(tenantId, memberId, at, tx),
    override: await port.overrideFor(tenantId, memberId, at),
  };
}

/** What the rules need about the person, read under their lock. */
export async function factsFor(tx: Transaction, personId: string, tenantId: string, now: Date) {
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
  /** The administrator's competence at the time of recording (#162: judged at both times). */
  readonly competenceAtRecording: MedicinesCompetence;
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
      competenceAtRecording: args.competenceAtRecording,
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
    row.covert === body.covert &&
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
    readonly covert: boolean;
    /** Identity and pack checks from the phone (ADR-0081), kept as they were sent. */
    readonly scanEvidence?: PointOfCare | null;
    readonly now: Date;
  },
) {
  const i = args.input;
  if (args.covert && i.outcome !== "given") {
    throw problems.invalid("Only a dose that was given can be marked as given covertly.");
  }
  // Covert and self-administered doses are marked, never refused (slice 38; HZ-026, HZ-120).
  const marks = await authorityMarks(tx, {
    personId: args.personId,
    medicationId: (i.entry as MarEntry).id,
    outcome: i.outcome as string,
    covert: args.covert,
    today: ukIsoDate(i.at),
  });
  const escalationsToRaise = [...args.escalations, ...marks.escalations];
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
        flags: [...new Set([...args.flags, ...marks.flags])],
        covert: args.covert,
        supersedesId: args.supersedesId,
        correctionReason: args.correctionReason,
        cdEntryId: args.cdEntryId ?? null,
        scanEvidence: args.scanEvidence ?? null,
      })
      .returning(),
  );
  const stored = row as AdministrationRow;
  const escalations = await raiseEscalationTasks(tx, {
    personId: args.personId,
    locationId: args.locationId,
    administrationId: stored.id,
    escalations: escalationsToRaise,
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
        202: jsonBody(
          ConflictRaised,
          "A device's second record of a dose already recorded: kept for the nurse in charge to review",
        ),
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
          // A device's upload is never dropped: a resend of a record kept as a conflict finds it.
          // Only a bearer request from a device the session was already bound to counts as an
          // upload (security review H1, re-review M1), and any request with a kept record's id
          // finds that conflict (L5).
          const upload = access.deviceBound === true;
          const kept = await conflictForClientRecord(tx, body.id, {
            personId,
            entryId: body.entryId,
            dueAt: body.dueAt,
            outcome: body.outcome,
          });
          if (kept === "mismatch") {
            throw problems.conflict(
              "This record id cannot be used. Read the record again and resend.",
            );
          }
          if (kept) return { status: 202 as const, conflict: kept };
          const entry = facts.byId.get(body.entryId);
          if (!entry) throw problems.notFound();
          // The phone's identity and pack checks (ADR-0081; HZ-001): a dose given needs both. A
          // phone's upload (it names its device) must carry them; a web record carries none yet,
          // and its empty scan_evidence reads "not checked at the point of care" (security review
          // of slice 69, H1).
          const fromDevice = Boolean(c.req.header(DEVICE_HEADER));
          const pointOfCare =
            body.pointOfCare ?? (fromDevice ? { identity: null, pack: null } : null);
          const pointOfCareProblems: PointOfCareIssue[] = pointOfCare
            ? pointOfCareIssues(body.outcome === "given", {
                identity: pointOfCare.identity,
                pack: pointOfCare.pack?.method ?? null,
                packOverride: pointOfCare.pack?.override ?? null,
              })
            : [];
          const scanned = pointOfCare?.pack?.method === "scanned" ? pointOfCare.pack : null;
          if (scanned && !scanned.gtin) pointOfCareProblems.push("pack_not_checked");
          // A scanned pack is matched here too, through dm+d, never on the phone's word alone
          // (security review of slice 69, M3): its GTIN in force today names a pack of the entry's
          // product (its AMP, or for a generic entry its VMP), and the AMPP the phone sent.
          if (scanned?.gtin && body.outcome === "given") {
            const packs = await dmdGtinMatches(tx, scanned.gtin, ukIsoDate(now));
            const product = entry.product;
            const fits = packs.some(
              (p) =>
                (product.ampId ? p.amp.id === product.ampId : p.vmp.id === product.vmpId) &&
                (scanned.amppId === null || p.pack.id === scanned.amppId),
            );
            if (!fits) {
              throw deny([
                {
                  problem: "pack_mismatch",
                  message:
                    "The pack scanned is not this medicine in the medicines data. Do not give it: check the pack with the nurse in charge.",
                },
              ]);
            }
          }
          if (pointOfCareProblems.length > 0) {
            throw deny(
              pointOfCareProblems.map((p) => ({ problem: p, message: POINT_OF_CARE_WORDS[p] })),
            );
          }
          // A controlled drug given moves stock: its register entry is written with the record, with
          // a fresh step-up and the witness's signature (slice 34; ADR-0084).
          const isCd = await isControlledDrug(tx, entry.id);
          if (isCd) refuseUnheldCdOutcome(body.outcome, deny);
          const cd = isCd && body.outcome === "given" ? { cdEntryId: randomUUID() } : null;
          if (cd) {
            // Refused before anything else where the register is not released here (H-1517).
            await requireCdRecording(
              tx,
              (await loadPerson(tx, personId)).locationId,
              deny([]).audit,
            );
            requireCdSignatures(
              access,
              body.controlledDrug,
              body.id,
              personId,
              deny,
              Boolean(c.req.header(DEVICE_HEADER)),
            );
            // The giver records a controlled drug themselves, so the witness is a second person
            // to both (security review H2).
            if (body.givenBy && body.givenBy !== access.tenantUserId) {
              throw deny([
                {
                  problem: "cd_given_by_recorder",
                  message:
                    "A controlled drug is recorded by the member who gave it, with a witness.",
                },
              ]);
            }
          }

          // The time is the server's: on the round a dose is recorded as it is given. Only a dose
          // recorded after it was given carries its own time, which slice 3's rules require to be
          // before the server's (#162); devices send theirs from slice 68 (security review M1).
          const gbr = body.givenBeforeRecorded;
          // Only a dose recorded after the event names another giver. A round record may carry the
          // time it happened, up to `medicines.record_delay_tolerance_minutes` earlier (#162's
          // rules refuse older ones and judge every record at the time given and when recorded,
          // so a typed time cannot hide a flag); never a time to come.
          if (!gbr && body.givenBy) {
            throw deny([
              {
                problem: "given_by_only_after_giving",
                message:
                  "Name who gave it only when recording a dose after it was given, with why.",
              },
            ]);
          }
          if (gbr && !body.givenAt) {
            throw deny([{ problem: "given_at_required", message: "Say when the dose was given." }]);
          }
          let at = now;
          let deviceAt: Date | null = null;
          let drifted = false;
          if (body.givenAt) {
            deviceAt = new Date(body.givenAt);
            const corrected = driftCorrectedTime(deviceAt, body.deviceOffsetMs, facts.rates);
            at = corrected.at;
            drifted = corrected.drifted;
          }
          if (at.getTime() > now.getTime() + facts.rates.clockDriftMinutes * 60_000) {
            throw deny([
              { problem: "given_at_in_future", message: "Record what has happened, at its time." },
            ]);
          }
          // A phone's record is judged at the time the phone recorded it (drift-corrected), not when
          // it arrived: a dose given offline is a round record, not one made after a delay. The time
          // must agree with the record's own UUIDv7 time and not be in the future (clinical review
          // of slice 69, B1); the server's time is still stored as recorded_at.
          let judgedAt = now;
          if (body.deviceRecordedAt) {
            const driftMs = facts.rates.clockDriftMinutes * 60_000;
            const deviceRecorded = driftCorrectedTime(
              new Date(body.deviceRecordedAt),
              body.deviceOffsetMs,
              facts.rates,
            ).at;
            const idTime = uuidV7Time(body.id);
            if (
              !c.req.header(DEVICE_HEADER) ||
              !idTime ||
              Math.abs(idTime.getTime() - new Date(body.deviceRecordedAt).getTime()) > driftMs ||
              deviceRecorded.getTime() > now.getTime() + driftMs ||
              deviceRecorded.getTime() < at.getTime()
            ) {
              throw deny([
                {
                  problem: "device_recorded_at_invalid",
                  message:
                    "The time this phone recorded the dose cannot be used. Check the phone's clock.",
                },
              ]);
            }
            judgedAt = deviceRecorded.getTime() > now.getTime() ? now : deviceRecorded;
          }
          // Who gave it: the recorder, or (recorded after giving) the member named, whose
          // competence then the rules check; the recorder's competence now is checked too.
          const giverId = gbr ? (body.givenBy ?? access.tenantUserId) : access.tenantUserId;
          const giver = {
            id: giverId,
            ...(at.getTime() !== now.getTime()
              ? await competenceOf(c, access.tenantId, giverId, at, tx)
              : me),
          };
          const { input, versionIds } = inputFor({
            personId,
            entry,
            entries: facts.entries,
            body,
            at,
            recordedAt: judgedAt,
            administrator: giver,
            competenceAtRecording:
              giverId === access.tenantUserId
                ? me.competence
                : await c
                    .get("services")
                    .medicines.competence.forMember(access.tenantId, giverId, now, tx),
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
          if (!checked.ok) {
            // Two devices recorded the same dose offline: the second is kept for review, never
            // silently dropped (medicines.md 15.4; HZ-004).
            const standing =
              upload && input.dueAt && checked.issues.some((x) => x.problem === "already_recorded")
                ? effective(facts.rows).find(
                    (r) =>
                      versionIds.has(r.medicationId) &&
                      r.dueAt?.getTime() === (input.dueAt as Date).getTime(),
                  )
                : undefined;
            if (standing) {
              const conflict = await raiseConflict(c, tx, access, {
                personId,
                locationId: facts.person.locationId,
                clientRecordId: body.id,
                entry,
                dueAt: input.dueAt as Date,
                standing,
                // The whole record as the device sent it, for the nurse in charge (clinical M7).
                uploaded: body,
                problems: checked.issues.map((x) => x.problem),
                deviceAt,
                deviceOffsetMs: body.deviceOffsetMs,
                rates: facts.rates,
              });
              return { status: 202 as const, conflict };
            }
            throw deny(checked.issues);
          }
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
            // The offset used whenever the request carried its own time (clinical M6).
            deviceOffsetMs: body.givenAt ? body.deviceOffsetMs : null,
            administeredBy: giverId,
            overrides: checked.flags.includes("competence_override")
              ? [giver.override, gbr ? me.override : null].filter(
                  (o): o is CompetenceOverride => o !== null,
                )
              : [],
            supersedesId: null,
            correctionReason: null,
            cdEntryId: cd?.cdEntryId ?? null,
            covert: body.covert,
            scanEvidence: body.pointOfCare,
            now,
          });
          // Slice 42's stock hook (medicines.md section 15 rule 3): a given dose moves the person's
          // stock of its product; a controlled drug's stock stays the register's.
          await raiseOutOfStockTask(tx, {
            record: stored,
            vmpId: entry.product.vmpId,
            locationId: facts.person.locationId,
          });
          await neverFailingTheDose(
            tx,
            { personId, locationId: facts.person.locationId, sourceId: body.id },
            (sp) =>
              stockOnDose(sp, {
                record: stored,
                vmpId: entry.product.vmpId,
                isControlledDrug: isCd,
                locationId: facts.person.locationId,
                recordedBy: access.tenantUserId,
              }),
            (error) =>
              c
                .get("services")
                .logger.warn(
                  { administrationId: body.id, code: (error as { code?: string }).code ?? null },
                  "medicines stock not moved for a dose",
                ),
          );
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
              givenBy: giverId,
              now,
              toleranceMs: facts.rates.clockDriftMinutes * 60_000,
              deviceGivenAt: body.givenAt,
            });
          }
          return {
            status: 201 as const,
            administration: await outFor(tx, stored, [...facts.rows, stored]),
            escalations,
          };
        }),
      );
      if (result.status === 202) return c.json(result.conflict, 202);
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
            ...(await competenceOf(c, access.tenantId, giverId, at, tx)),
          };
          const { input, versionIds } = inputFor({
            personId,
            entry,
            entries: facts.entries,
            body,
            at,
            recordedAt: now,
            administrator: giver,
            competenceAtRecording: await c
              .get("services")
              .medicines.competence.forMember(access.tenantId, giverId, now, tx),
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
          const isCd = await isControlledDrug(tx, entry.id);
          if (isCd) refuseUnheldCdOutcome(body.outcome, deny);
          const cdMove = isCd ? registerMoveForCorrection(original, body, at) : null;
          if (cdMove) {
            // Refused before anything else where the register is not released here (H-1517).
            await requireCdRecording(tx, facts.person.locationId, deny([]).audit);
            requireCdSignatures(
              access,
              body.controlledDrug,
              body.id,
              personId,
              deny,
              Boolean(c.req.header(DEVICE_HEADER)),
            );
            // The witness is never the giver or the recorder: the signature check and the
            // register trigger compare both (security review H2).
          }
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
            // A correction that moves no stock carries the chain's register entry forward, so a later
            // correction corrects that entry (security review M1, clinical review H1).
            cdEntryId: cdMove?.id ?? original.cdEntryId,
            // Left out, the covert mark carries forward while the dose is still given (HZ-026).
            covert: body.covert ?? (original.covert && input.outcome === "given"),
            now,
          });
          await neverFailingTheDose(
            tx,
            { personId, locationId: facts.person.locationId, sourceId: body.id },
            (sp) =>
              stockOnCorrection(sp, {
                record: stored,
                chainIds: chainOf(original, facts.rows),
                vmpId: entry.product.vmpId,
                isControlledDrug: isCd,
                locationId: facts.person.locationId,
                recordedBy: access.tenantUserId,
              }),
            (error) =>
              c
                .get("services")
                .logger.warn(
                  { administrationId: body.id, code: (error as { code?: string }).code ?? null },
                  "medicines stock not moved for a dose",
                ),
          );
          if (cdMove) {
            await writeRegisterEntry(c, tx, access, deny, {
              ...cdMove,
              entry,
              locationId: facts.person.locationId,
              unitCode: body.amount?.unitCode ?? null,
              reason: cdMove.movement === "correction" ? body.correctionReason : null,
              // A dose newly given is entered at the time given; a correction when it is made.
              occurredAt: cdMove.movement === "administration" ? at : now,
              givenBy: giverId,
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
        const range = {
          from: new Date(at.getTime() - 12 * HOUR_MS),
          to: new Date(at.getTime() + 12 * HOUR_MS),
        };
        const { doses, whenRequired } = roundFor(
          { ...facts, pending: await pendingConflicts(tx, personId) },
          range,
          at,
          now,
        );
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

/** A record and every record it corrects, newest first (the chain's stock movements, section 15). */
function chainOf(
  latest: { readonly id: string; readonly supersedesId: string | null },
  rows: readonly { readonly id: string; readonly supersedesId: string | null }[],
): string[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ids: string[] = [];
  let at: { readonly id: string; readonly supersedesId: string | null } | undefined = latest;
  while (at && !ids.includes(at.id)) {
    ids.push(at.id);
    at = at.supersedesId ? byId.get(at.supersedesId) : undefined;
  }
  return ids;
}

/** Whether the entry's dm+d product is a controlled drug (its schedule comes from slice 10). */
export async function isControlledDrug(tx: Transaction, entryId: string): Promise<boolean> {
  const [row] = await tx
    .select({ cd: medication.cdSchedule })
    .from(medication)
    .where(eq(medication.id, entryId));
  return Boolean(row?.cd);
}

type Deny = (issues: readonly { problem: string; message: string }[]) => AuditedRefusal;

/**
 * A controlled drug taken by the person themselves or given by family is not recorded here until
 * the CSO decides whether such doses move the home's stock (H-1202): recording them with no
 * register entry would leave the balance overstated (security review M3, clinical review M4).
 */
function refuseUnheldCdOutcome(outcome: string, deny: Deny) {
  if (outcome === "self_administered" || outcome === "given_by_family") {
    throw deny([
      {
        problem: "cd_outcome_not_recorded",
        message:
          "A controlled drug taken by the person themselves or given by family is not recorded here yet. Tell the nurse in charge, who records it with the register.",
      },
    ]);
  }
}

/** A controlled drug's stock moves only with a fresh step-up and a second signature (ADR-0084). */
function requireCdSignatures(
  access: TenantAccess,
  witness: CdWitnessInput | { readonly deviceSignatures: DeviceSignaturesInput } | null,
  recordId: string,
  personId: string,
  deny: Deny,
  fromDevice = false,
) {
  // Moving controlled drug stock needs medicines.cd.administer (security review H1).
  if (!can(access.effective, "medicines.cd.administer")) {
    throw new AuditedRefusal(problems.forbidden(), {
      action: "medicines.cd.entry_recorded",
      outcome: "denied",
      resourceType: "medication_administration",
      resourceId: recordId,
      scope: { personId, problems: ["missing_permission"] },
    });
  }
  // On a phone offline the recorder's own signature, verified with the witness's when the record
  // arrives, stands for the step-up (ADR-0084; slice 70); it is accepted only from a device.
  const deviceSigned = witness !== null && "deviceSignatures" in witness;
  if (deviceSigned && !fromDevice) {
    throw deny([
      {
        problem: "device_signatures_from_device",
        message: "Signatures made on a phone are sent by that phone.",
      },
    ]);
  }
  if (!deviceSigned && !stepUpFresh(access)) {
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
    readonly witness: CdWitnessInput | { readonly deviceSignatures: DeviceSignaturesInput };
    readonly administrationId: string;
    readonly givenBy: string;
    readonly now: Date;
    /** The clock-drift figure, for signatures made on a phone (slice 70). */
    readonly toleranceMs?: number;
    /** When the phone says the dose was given, as it sent it (the signed statement's). */
    readonly deviceGivenAt?: string | null;
  },
) {
  // Nothing goes in Thapsus Care's register until recording is released here (H-1517): the dose
  // is refused, audited as the caller's action, and recorded on paper instead.
  await requireCdRecording(tx, e.locationId, deny([]).audit);
  const { page, opened } = await pageFor(tx, e.entry, access.tenantUserId);
  // Offline on one phone (ADR-0084; slice 70): both signatures are verified here, and the
  // witness's becomes the register's own assertion, used at once by the entry below.
  let witness: CdWitnessInput;
  if ("deviceSignatures" in e.witness) {
    const deviceId = c.req.header(DEVICE_HEADER)?.toLowerCase() ?? "";
    const person = await loadPerson(tx, e.entry.personId);
    const minutes = await rateNumber(
      tx,
      access.tenantId,
      "medicines.cd.witness_assertion_minutes",
      person.nation,
    );
    const port = c.get("services").medicines.competence;
    const signed = e.witness.deviceSignatures;
    const witnessId = signed.witness?.witnessId ?? "";
    const windowDays = await offlineWindowDaysOf(tx, access.tenantId);
    const problems = await deviceSignatureProblems(
      tx,
      {
        tenantId: access.tenantId,
        deviceId,
        recorderId: access.tenantUserId,
        personId: e.entry.personId,
        entryId: e.entry.id,
        administrationId: e.administrationId,
        quantity: e.quantity,
        unitCode: e.unitCode ?? page.unitCode,
        locationId: e.locationId,
        vmpId: e.entry.product.vmpId,
        givenAt: e.deviceGivenAt ?? "",
        recordTime: uuidV7Time(e.administrationId),
      },
      signed,
      {
        now: e.now,
        toleranceMs: e.toleranceMs ?? 0,
        apartMs: minutes * 60_000,
        windowMs: windowDays * 86_400_000,
        witnessCompetent: async (at) =>
          (await port.forMember(access.tenantId, witnessId, at, tx)) === "current",
      },
    );
    if (!e.deviceGivenAt) {
      problems.push({ problem: "given_at_required", message: "Say when the dose was given." });
    }
    if (problems.length > 0) throw deny(problems);
    witness = signed.witness
      ? {
          witnessAssertionId: await deviceWitnessAssertion(tx, {
            personId: e.entry.personId,
            pageId: page.id,
            quantity: e.quantity,
            administrationId: e.administrationId,
            recorderId: access.tenantUserId,
            witness: signed.witness,
            expiresAt: new Date(e.now.getTime() + minutes * 60_000),
          }),
        }
      : // A lone worker where the policy allows it: why there was no witness; the register
        // refuses it where a witness is required, and flags it for manager review otherwise.
        { noWitnessReason: signed.noWitnessReason ?? "" };
  } else {
    witness = e.witness;
  }
  if (opened) {
    await audit(c, tx, access, {
      action: "medicines.cd.page_opened",
      resourceType: "controlled_drug_page",
      resourceId: page.id,
      scope: { personId: page.personId },
    });
  }
  // The register goes in time order. A dose recorded after it was given, older than the page's
  // last entry, is entered when it is recorded, naming the administration that holds the time
  // given, so the dose is never left off the MAR (clinical review H2; H-1204).
  const last = (await pageEntries(tx, page.id)).at(-1);
  const late = last !== undefined && e.occurredAt.getTime() < last.occurredAt.getTime();
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
    occurredAt: late ? e.now : e.occurredAt,
    correctsId: e.correctsId,
    corrects: e.corrects,
    reason: e.reason,
    counterparty: null,
    reference: late
      ? "Recorded after it was given: the time given is on the administration record"
      : null,
    witness,
    administrationId: e.administrationId,
    recordedBy: access.tenantUserId,
    givenBy: e.givenBy,
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
  await publish(tx, {
    context: "medicines",
    aggregateType: "controlled_drug_entry",
    aggregateId: result.row.id,
    type: "medicines.cd.entry_recorded",
    payload: { personId: page.personId, pageId: page.id, entryId: result.row.id },
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
