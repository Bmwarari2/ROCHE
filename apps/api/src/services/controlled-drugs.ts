import type { StockCheckOut } from "@harbour/contracts";
import {
  controlledDrugEntry,
  controlledDrugPage,
  type controlledDrugStockCheck,
  controlledDrugWitnessAssertion,
  service,
  type Transaction,
} from "@harbour/db";
import {
  type CdEntry,
  type CdEntryIssue,
  type CdMovement,
  type CdWitnessPolicy,
  cdBalanceAfter,
  cdPageKey,
  checkCdEntry,
  defaultCdWitnessPolicy,
  formatDoseQuantity,
  type MarEntry,
  type ServiceType,
} from "@harbour/domain";
import { and, asc, eq, isNull } from "drizzle-orm";
import { problems } from "../http/problem";
import { guardConcurrent } from "./medicines";

/**
 * Between the register tables and slice 3's controlled drugs rules (medicines.md section 14;
 * slice 34): pages, entries as the rules read them, the witness policy, the second signature and
 * writing an entry the rules allow.
 */

export type PageRow = typeof controlledDrugPage.$inferSelect;
export type EntryRow = typeof controlledDrugEntry.$inferSelect;
export type StockCheckRow = typeof controlledDrugStockCheck.$inferSelect;
type AssertionRow = typeof controlledDrugWitnessAssertion.$inferSelect;

export type CdWitnessInput = { witnessAssertionId: string } | { noWitnessReason: string };

/** The strictest witness policy among the location's services (rule 27); `required` with none. */
export async function witnessPolicyFor(
  tx: Transaction,
  locationId: string,
): Promise<CdWitnessPolicy> {
  const rows = await tx
    .select({ type: service.serviceType })
    .from(service)
    .where(and(eq(service.locationId, locationId), eq(service.status, "active")));
  if (rows.length === 0) return "required";
  return rows.some((r) => defaultCdWitnessPolicy(r.type as ServiceType) === "required")
    ? "required"
    : "where_available";
}

export async function pageEntries(tx: Transaction, pageId: string): Promise<EntryRow[]> {
  return tx
    .select()
    .from(controlledDrugEntry)
    .where(eq(controlledDrugEntry.pageId, pageId))
    .orderBy(asc(controlledDrugEntry.seq));
}

export function cdEntryOf(page: PageRow, r: EntryRow): CdEntry {
  return {
    id: r.id,
    pageKey: cdPageKey(page.personId, { vmpId: page.vmpId }),
    movement: r.movement as CdMovement,
    quantity: Number(r.quantity),
    correctsId: r.correctsId,
    corrects: (r.corrects as CdEntry["corrects"]) ?? null,
    reason: r.reason,
    balanceAfter: Number(r.balanceAfter),
    at: r.occurredAt,
    recordedBy: r.recordedBy,
    witnessedBy: r.witnessId,
    noWitnessReason: r.noWitnessReason,
  };
}

/** The page for a person and a MAR entry's product, opened when it has none (rule 24). */
export async function pageFor(
  tx: Transaction,
  entry: MarEntry,
  openedBy: string,
): Promise<{ page: PageRow; opened: boolean }> {
  const [existing] = await tx
    .select()
    .from(controlledDrugPage)
    .where(
      and(
        eq(controlledDrugPage.personId, entry.personId),
        eq(controlledDrugPage.vmpId, entry.product.vmpId),
      ),
    );
  if (existing) return { page: existing, opened: false };
  const unit =
    entry.directions.kind === "when_required"
      ? entry.directions.dose.unit
      : entry.directions.schedule.times[0]?.dose.unit;
  if (!unit) throw problems.invalid("This medicine has no dose unit to count in.");
  const [page] = await guardConcurrent(() =>
    tx
      .insert(controlledDrugPage)
      .values({
        personId: entry.personId,
        vmpId: entry.product.vmpId,
        productName: entry.product.name,
        unitCode: unit.code,
        unitName: unit.name,
        openedBy,
      })
      .returning(),
  );
  return { page: page as PageRow, opened: true };
}

/** A witness's assertion as stored, for refusals in words before the database's own check. */
async function assertionFor(tx: Transaction, id: string): Promise<AssertionRow | null> {
  const [row] = await tx
    .select()
    .from(controlledDrugWitnessAssertion)
    .where(
      and(eq(controlledDrugWitnessAssertion.id, id), isNull(controlledDrugWitnessAssertion.usedAt)),
    );
  return row ?? null;
}

/** Why an assertion does not stand for this entry, in words, or null. */
export async function assertionProblem(
  tx: Transaction,
  witness: CdWitnessInput,
  expect: {
    readonly pageId: string;
    readonly movement: string;
    readonly quantity: number;
    readonly administrationId: string | null;
    readonly recordedBy: string;
    /** Who gave the dose, for an administration: never its witness. */
    readonly givenBy?: string | null;
    readonly now: Date;
  },
): Promise<{ witnessId: string | null; issue: CdEntryIssue | null }> {
  if (!("witnessAssertionId" in witness)) return { witnessId: null, issue: null };
  const a = await assertionFor(tx, witness.witnessAssertionId);
  const mismatch = (message: string) => ({
    witnessId: a?.witnessId ?? null,
    issue: { problem: "witness_required" as const, message },
  });
  if (!a || a.expiresAt.getTime() <= expect.now.getTime()) {
    return mismatch("The witness's signature has expired or been used. Ask them to sign again.");
  }
  if (
    a.pageId !== expect.pageId ||
    a.movement !== expect.movement ||
    Number(a.quantity) !== expect.quantity ||
    (a.administrationId ?? null) !== expect.administrationId ||
    a.recorderId !== expect.recordedBy
  ) {
    return mismatch(
      "The witness signed for something else. They sign again for exactly what is recorded.",
    );
  }
  if (a.witnessId === expect.recordedBy || a.witnessId === expect.givenBy) {
    return {
      witnessId: a.witnessId,
      issue: {
        problem: "witness_is_recorder",
        message:
          "The witness must be someone other than the person recording the entry or giving the dose.",
      },
    };
  }
  return { witnessId: a.witnessId, issue: null };
}

export interface NewCdEntry {
  readonly id: string;
  readonly page: PageRow;
  readonly movement: CdMovement;
  readonly quantity: number;
  readonly occurredAt: Date;
  readonly correctsId: string | null;
  readonly corrects: "quantity" | "detail" | null;
  readonly reason: string | null;
  readonly counterparty: string | null;
  readonly reference: string | null;
  readonly witness: CdWitnessInput;
  readonly administrationId: string | null;
  readonly recordedBy: string;
  readonly givenBy?: string | null;
  readonly policy: CdWitnessPolicy;
  readonly now: Date;
}

/**
 * Checks an entry against its page with slice 3's rules and the witness's signature, then writes
 * it with the balance the rules give. Returns every problem, or the stored row.
 */
export async function writeCdEntry(
  tx: Transaction,
  e: NewCdEntry,
): Promise<{ ok: true; row: EntryRow } | { ok: false; issues: readonly CdEntryIssue[] }> {
  const rows = await pageEntries(tx, e.page.id);
  const page = rows.map((r) => cdEntryOf(e.page, r));
  const last = rows.at(-1);
  const { witnessId, issue } = await assertionProblem(tx, e.witness, {
    pageId: e.page.id,
    movement: e.movement,
    quantity: e.quantity,
    administrationId: e.administrationId,
    recordedBy: e.recordedBy,
    givenBy: e.givenBy ?? null,
    now: e.now,
  });
  const noWitnessReason = "noWitnessReason" in e.witness ? e.witness.noWitnessReason : null;
  const candidate: CdEntry = {
    id: e.id,
    pageKey: cdPageKey(e.page.personId, { vmpId: e.page.vmpId }),
    movement: e.movement,
    quantity: e.quantity,
    correctsId: e.correctsId,
    corrects: e.corrects,
    reason: e.reason,
    balanceAfter: cdBalanceAfter(last ? Number(last.balanceAfter) : 0, e.movement, e.quantity),
    at: e.occurredAt,
    recordedBy: e.recordedBy,
    witnessedBy: witnessId,
    noWitnessReason,
  };
  const checked = checkCdEntry(page, candidate, e.policy);
  const issues = [...(checked.ok ? [] : checked.issues), ...(issue ? [issue] : [])];
  if (issues.length > 0) return { ok: false, issues };
  const [row] = await guardConcurrent(() =>
    tx
      .insert(controlledDrugEntry)
      .values({
        id: e.id,
        personId: e.page.personId,
        pageId: e.page.id,
        seq: (last?.seq ?? 0) + 1,
        movement: e.movement,
        quantity: String(e.quantity),
        balanceAfter: String(candidate.balanceAfter),
        correctsId: e.correctsId,
        corrects: e.corrects,
        reason: e.reason,
        counterparty: e.counterparty,
        reference: e.reference,
        occurredAt: e.occurredAt,
        recordedBy: e.recordedBy,
        witnessId,
        witnessAssertionId: "witnessAssertionId" in e.witness ? e.witness.witnessAssertionId : null,
        noWitnessReason,
        flags: checked.ok ? [...checked.flags] : [],
        administrationId: e.administrationId,
      })
      .returning(),
  );
  return { ok: true, row: row as EntryRow };
}

export function stockCheckOut(r: StockCheckRow, unitName: string): StockCheckOut {
  const difference = Number(r.difference);
  // formatDoseQuantity takes only a dose (more than zero), so a balanced count is not formatted.
  const amount = difference === 0 ? "0" : formatDoseQuantity(Math.abs(difference));
  return {
    id: r.id,
    counted: Number(r.counted),
    expected: Number(r.expected),
    difference,
    resultInWords:
      difference === 0
        ? "Balanced"
        : `${difference > 0 ? "Over" : "Short"} by ${amount} ${unitName}: an incident is raised`,
    reason: r.reason,
    checked: { id: r.checkedBy, at: r.checkedAt.toISOString() },
    witnessId: r.witnessId,
    noWitnessReason: r.noWitnessReason,
  };
}
