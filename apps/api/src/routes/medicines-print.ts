import {
  allergy,
  controlledDrugPage,
  controlledDrugStockCheck,
  medicationAdministration,
  type Transaction,
} from "@harbour/db";
import {
  formatDoseQuantity,
  isTimeCritical,
  type MarEntry,
  marEntryDoses,
  marEntryEnd,
  marEntryStatus,
  marEntryTimesBeforeRecorded,
  ukStartOfDay,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, gte, isNull, lt } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import { type AppEnv, requireAnyPermission, type TenantAccess, withTenant } from "../http/context";
import { problems } from "../http/problem";
import { renderCdRegisterPdf } from "../services/cd-register-pdf";
import { pageEntries, stockCheckOut } from "../services/controlled-drugs";
import {
  initialsOf,
  type MarOutcome,
  type MarPrintEntry,
  type MarRecord,
  renderMarPdf,
} from "../services/mar-pdf";
import { effective } from "../services/medicine-administrations";
import { directionsInWords, personEntries, UNCHECKED_POLICY } from "../services/medicines";
import { loadPerson } from "../services/people";
import { staffNames } from "../services/staff";
import { allergyStatementOf } from "../services/transfer-pack";
import { createRouter, errorResponses, notFoundResponse, security } from "./openapi";

/**
 * The printable MAR chart and controlled drugs register page (Phase 2 slice 50; MEDS-014;
 * medicines.md section 17), as PDFs drawn from the record when asked and never stored. Reading needs
 * a permission that reads the MAR (or, for the register, the controlled drugs register). Each print
 * is audited by id only. Each page says when it was printed and that it is not the live record
 * (HZ-122).
 */

const tags = ["medicines"];
const MAR_READERS = [
  "medicines.record.manage",
  "medicines.emar.administer",
  "care.plan.read",
] as const;
const CD_READERS = ["medicines.cd.administer", "medicines.cd.witness", ...MAR_READERS] as const;
const Month = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
  .meta({ description: "The calendar month, yyyy-mm (UK time)." });
const PdfBody = {
  content: { "application/pdf": { schema: z.string().meta({ format: "binary" }) } },
};

function audit(
  c: Context<AppEnv>,
  tx: Transaction,
  access: TenantAccess,
  input: Parameters<typeof auditInTx>[2],
) {
  return auditInTx(tx, access, { ...input, requestId: c.get("requestId") });
}

function pdf(c: Context<AppEnv>, bytes: Uint8Array, filename: string) {
  return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
    "content-type": "application/pdf",
    "content-disposition": `attachment; filename="${filename}"`,
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
    "content-security-policy": "default-src 'none'; sandbox",
  });
}

/** The month's UK start (inclusive) and the next month's (exclusive), and its name. */
export function marMonth(month: string): { from: Date; to: Date; label: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  const from = ukStartOfDay(`${month}-01`);
  const label = new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "Europe/London",
  }).format(new Date(from.getTime() + 12 * 3_600_000));
  return { from, to: ukStartOfDay(`${next}-01`), label };
}

const OUTCOMES: ReadonlySet<string> = new Set([
  "given",
  "refused",
  "omitted",
  "withheld",
  "not_available",
  "self_administered",
  "given_by_family",
]);

/** The unit's name for an amount recorded in the entry's own unit; the code otherwise. */
function unitName(entry: MarEntry, unitCode: string | null): string {
  const d = entry.directions;
  const dose = d.kind === "when_required" ? d.dose : d.schedule.times[0]?.dose;
  return dose && dose.unit.code === unitCode ? dose.unit.name : (unitCode ?? "");
}

export const medicinesPrintRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/mar/print",
      tags,
      summary: "The MAR chart for a month, to print (PDF)",
      description:
        "One person, one calendar month: the allergies, a key to the codes, each medicine's doses by day with outcome, giver's initials, covert and corrected marks, and when-required doses. Every page names the person and says when it was printed and that it is not the live record (HZ-122). Audited by the person's id.",
      security,
      request: { params: z.object({ id: z.uuid() }), query: z.object({ month: Month }) },
      responses: {
        200: { ...PdfBody, description: "The MAR chart" },
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [...MAR_READERS]);
      const { id } = c.req.valid("param");
      const { month } = c.req.valid("query");
      const window = marMonth(month);
      const printedAt = new Date();
      const read = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id);
        const allergies = await tx
          .select()
          .from(allergy)
          .where(and(eq(allergy.personId, id), isNull(allergy.deletedAt)));
        const stored = await personEntries(tx, id);
        const rows = effective(
          await tx
            .select()
            .from(medicationAdministration)
            .where(
              and(
                eq(medicationAdministration.personId, id),
                gte(medicationAdministration.givenAt, window.from),
                lt(medicationAdministration.givenAt, window.to),
              ),
            )
            .orderBy(asc(medicationAdministration.givenAt)),
        ).filter((r) => OUTCOMES.has(r.outcome));
        const names = await staffNames(
          tx,
          rows.map((r) => r.administeredBy),
        );
        await audit(c, tx, access, {
          action: "medicines.mar.printed",
          resourceType: "person",
          resourceId: id,
          scope: { month },
        });
        return { p, allergies, stored, rows, names };
      });
      const record = (r: (typeof read.rows)[number], entry: MarEntry): MarRecord => ({
        outcome: r.outcome as MarOutcome,
        givenAt: r.givenAt,
        by: r.administeredBy,
        covert: r.covert,
        corrected: r.supersedesId !== null,
        amount:
          r.quantity !== null
            ? `${formatDoseQuantity(Number(r.quantity))} ${unitName(entry, r.unitCode)}`
            : null,
      });
      const entries: MarPrintEntry[] = read.stored.flatMap(({ entry }) => {
        const mine = read.rows.filter((r) => r.medicationId === entry.id);
        const regular = entry.directions.kind === "regular";
        const doses = regular
          ? [
              ...marEntryDoses(entry, window).map((d) => ({ d, notDue: false })),
              ...marEntryTimesBeforeRecorded(entry, window).map((d) => ({ d, notDue: true })),
            ].map(({ d, notDue }) => {
              const r = mine.find((x) => x.dueAt?.getTime() === d.dueAt.getTime());
              return {
                dueAt: d.dueAt,
                date: d.date,
                time: d.time,
                dayName:
                  d.dayName ??
                  new Intl.DateTimeFormat("en-GB", {
                    weekday: "short",
                    timeZone: "Europe/London",
                  }).format(d.dueAt),
                notDue,
                record: r ? record(r, entry) : null,
              };
            })
          : [];
        const prnRecords = regular ? [] : mine.map((r) => record(r, entry));
        const end = marEntryEnd(entry);
        const inMonth =
          entry.startsAt.getTime() < window.to.getTime() &&
          (end === null || end.getTime() > window.from.getTime());
        if (doses.length === 0 && prnRecords.length === 0 && (!inMonth || entry.withdrawn))
          return [];
        return [
          {
            productName: entry.product.name,
            route: entry.route.name,
            directions: directionsInWords(entry),
            kind: regular ? ("regular" as const) : ("when_required" as const),
            startsAt: entry.startsAt,
            endsAt: end,
            prescriber: entry.prescriber,
            status: marEntryStatus(entry, printedAt, UNCHECKED_POLICY).words,
            timeCritical: isTimeCritical(entry),
            doses,
            prnRecords,
          },
        ];
      });
      const bytes = renderMarPdf({
        person: {
          name: [read.p.givenName, read.p.familyName].filter(Boolean).join(" "),
          dateOfBirth: read.p.dateOfBirth,
          nhsNumber: read.p.nhsNumber,
          room: null,
          locationName: read.p.locationName,
        },
        month: window,
        allergies: allergyStatementOf(read.p, read.allergies),
        entries,
        staff: (who) => {
          const s = read.names(who);
          return s ? { name: s.displayName, initials: initialsOf(s.displayName) } : null;
        },
        printedAt,
      });
      return pdf(c, bytes, `mar-${month}.pdf`);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/controlled-drugs/pages/{pageId}/print",
      tags,
      summary: "A controlled drugs register page, to print (PDF)",
      description:
        "The page heading, every entry in order with its signatures and running balance, each correction under the entry it corrects, and every stock check. Every page says when it was printed and that it is not the live record (HZ-122). Replaces the plain print view (H-1331). Audited.",
      security,
      request: { params: z.object({ pageId: z.uuid() }) },
      responses: {
        200: { ...PdfBody, description: "The register page" },
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [...CD_READERS]);
      const { pageId } = c.req.valid("param");
      const printedAt = new Date();
      const read = await withTenant(c, async (tx) => {
        const [page] = await tx
          .select()
          .from(controlledDrugPage)
          .where(eq(controlledDrugPage.id, pageId));
        if (!page) throw problems.notFound();
        const p = await loadPerson(tx, page.personId);
        const entries = await pageEntries(tx, page.id);
        const checks = await tx
          .select()
          .from(controlledDrugStockCheck)
          .where(eq(controlledDrugStockCheck.pageId, page.id))
          .orderBy(asc(controlledDrugStockCheck.checkedAt));
        const names = await staffNames(tx, [
          ...entries.flatMap((r) => [r.recordedBy, r.witnessId]),
          ...checks.flatMap((s) => [s.checkedBy, s.witnessId]),
        ]);
        await audit(c, tx, access, {
          action: "medicines.cd.printed",
          resourceType: "controlled_drug_page",
          resourceId: page.id,
          scope: { personId: page.personId, entries: entries.length },
        });
        return { page, p, entries, checks, names };
      });
      const people = [
        ...new Set([
          ...read.entries.flatMap((r) => [r.recordedBy, r.witnessId]),
          ...read.checks.flatMap((s) => [s.checkedBy, s.witnessId]),
        ]),
      ].flatMap((pid) => {
        const s = pid ? read.names(pid) : null;
        return s && pid ? [{ id: pid, name: s.displayName }] : [];
      });
      const sorted = [...read.entries].sort((a, b) => a.seq - b.seq);
      const bytes = renderCdRegisterPdf({
        person: {
          name: [read.p.givenName, read.p.familyName].filter(Boolean).join(" "),
          dateOfBirth: read.p.dateOfBirth,
          nhsNumber: read.p.nhsNumber,
          locationName: read.p.locationName,
        },
        page: {
          productName: read.page.productName,
          unitName: read.page.unitName,
          balance: sorted.length > 0 ? Number(sorted[sorted.length - 1]?.balanceAfter ?? 0) : 0,
        },
        entries: sorted.map((r) => ({
          id: r.id,
          seq: r.seq,
          movement: r.movement,
          quantity: Number(r.quantity),
          balanceAfter: Number(r.balanceAfter),
          correctsId: r.correctsId,
          corrects: r.corrects as "quantity" | "detail" | null,
          reason: r.reason,
          counterparty: r.counterparty,
          reference: r.reference,
          occurredAt: r.occurredAt.toISOString(),
          recorded: { id: r.recordedBy, at: r.recordedAt.toISOString() },
          witnessId: r.witnessId,
          noWitnessReason: r.noWitnessReason,
        })),
        stockChecks: read.checks.map((s) => {
          const out = stockCheckOut(s, read.page.unitName);
          return {
            counted: out.counted,
            expected: out.expected,
            resultInWords: out.resultInWords,
            reason: out.reason,
            checked: out.checked,
            witnessId: out.witnessId,
            noWitnessReason: out.noWitnessReason,
          };
        }),
        people,
        printedAt,
      });
      return pdf(c, bytes, `cd-register-${pageId}.pdf`);
    },
  );
