import {
  allergy,
  controlledDrugPage,
  controlledDrugStockCheck,
  type Transaction,
} from "@harbour/db";
import { ukStartOfDay } from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import { type AppEnv, requireAnyPermission, type TenantAccess, withTenant } from "../http/context";
import { problems } from "../http/problem";
import { requireWithinLimit } from "../http/rate-limit";
import { renderCdRegisterPdf } from "../services/cd-register-pdf";
import { pageEntries, stockCheckOut } from "../services/controlled-drugs";
import { marPrintEntries, renderMarPdf, uniqueInitials } from "../services/mar-pdf";
import { effective, personAdministrations } from "../services/medicine-administrations";
import { personEntries } from "../services/medicines";
import { loadPerson } from "../services/people";
import { staffNames } from "../services/staff";
import { allergyStatementOf, communicationStatementOf } from "../services/transfer-pack";
import {
  createRouter,
  errorResponses,
  limitedResponse,
  notFoundResponse,
  security,
} from "./openapi";

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
/** A month from January 2000 to next year: a print never reaches outside the UK clock's range. */
const Month = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
  .refine((m) => {
    const year = Number(m.slice(0, 4));
    return year >= 2000 && year <= new Date().getUTCFullYear() + 1;
  }, "A month from 2000 to next year")
  .meta({ description: "The calendar month, yyyy-mm (UK time), from 2000 to next year." });
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
        ...limitedResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [...MAR_READERS]);
      const { db, medicinesPrintLimiter } = c.get("services");
      await requireWithinLimit(db, access, medicinesPrintLimiter);
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
        // The records that stand, over all the person's records, so a correction made in another
        // month still supersedes (clinical review B1); the month is chosen afterwards.
        const standing = effective(await personAdministrations(tx, id));
        const entries = marPrintEntries(
          stored.map((s) => s.entry),
          standing,
          window,
          printedAt,
        );
        const givers = [
          ...new Set(
            entries.flatMap((e) =>
              [...e.doses.map((d) => d.record), ...e.prnRecords, ...e.unmatched].flatMap((r) =>
                r?.by ? [r.by] : [],
              ),
            ),
          ),
        ];
        const names = await staffNames(tx, givers);
        await audit(c, tx, access, {
          action: "medicines.mar.printed",
          resourceType: "person",
          resourceId: id,
          scope: { month },
        });
        return { p, allergies, entries, givers, names };
      });
      const people = read.givers.flatMap((g) => {
        const s = read.names(g);
        return s ? [{ id: g, name: s.displayName }] : [];
      });
      const initials = uniqueInitials(people);
      const bytes = renderMarPdf({
        person: {
          name: [read.p.givenName, read.p.familyName].filter(Boolean).join(" "),
          preferredName: read.p.preferredName,
          dateOfBirth: read.p.dateOfBirth,
          nhsNumber: read.p.nhsNumber,
          locationName: read.p.locationName,
        },
        month: window,
        allergies: allergyStatementOf(read.p, read.allergies),
        communication: communicationStatementOf(read.p),
        entries: read.entries,
        staff: (who) => {
          const person = people.find((x) => x.id === who);
          const code = who ? initials.get(who) : undefined;
          return person && code ? { name: person.name, initials: code } : null;
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
        ...limitedResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [...CD_READERS]);
      await requireWithinLimit(
        c.get("services").db,
        access,
        c.get("services").medicinesPrintLimiter,
      );
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
