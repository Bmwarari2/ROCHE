import type { OutbreakDetail } from "@harbour/contracts";
import {
  location,
  type outbreak,
  outbreakCase,
  statutoryNotification,
  type Transaction,
} from "@harbour/db";
import {
  casesStillUnwell,
  currentCases,
  type OutbreakCase,
  type OutbreakSyndrome,
  UKHSA_OUTBREAK_SOURCE,
  type UkhsaReportFields,
  ukhsaReportFields,
  ukIsoDate,
} from "@harbour/domain";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { upsertDraft } from "./safety";

/**
 * Outbreaks (safety.md section 11; SAFE-013; HZ-013; migration 0093): rows into the API's shapes,
 * the UKHSA report fields from the location and the current line list, and the report draft an
 * outbreak's clock runs on. Read in the caller's scope: row-level security decides what is seen.
 */

type OutbreakRow = typeof outbreak.$inferSelect;
type CaseRow = typeof outbreakCase.$inferSelect;

export const outbreakSummary = (row: OutbreakRow) => ({
  id: row.id,
  locationId: row.locationId,
  syndrome: row.syndrome as OutbreakSyndrome,
  organism: row.organism,
  state: row.state as "declared" | "closed",
  declaredAt: row.declaredAt.toISOString(),
  declaredBy: row.declaredBy,
  notificationId: row.notificationId,
  hptReference: row.hptReference,
  closedOn: row.closedOn,
  closedAt: row.closedAt?.toISOString() ?? null,
  closedBy: row.closedBy,
  closureReason: row.closureReason,
  version: row.version,
});

export const domainCase = (row: CaseRow): OutbreakCase => ({
  id: row.id,
  caseType: row.caseType as OutbreakCase["caseType"],
  personId: row.personId,
  tenantUserId: row.tenantUserId,
  onsetOn: row.onsetOn,
  symptoms: row.symptoms as OutbreakCase["symptoms"],
  testType: row.testType as OutbreakCase["testType"],
  testedOn: row.testedOn,
  testResult: row.testResult as OutbreakCase["testResult"],
  fluVaccinated: row.fluVaccinated as OutbreakCase["fluVaccinated"],
  covidVaccinated: row.covidVaccinated as OutbreakCase["covidVaccinated"],
  outcome: row.outcome as OutbreakCase["outcome"],
  outcomeOn: row.outcomeOn,
  supersedesId: row.supersedesId,
  createdAt: row.createdAt.toISOString(),
});

export async function outbreakCases(tx: Transaction, outbreakId: string): Promise<CaseRow[]> {
  return tx
    .select()
    .from(outbreakCase)
    .where(eq(outbreakCase.outbreakId, outbreakId))
    .orderBy(asc(outbreakCase.createdAt), asc(outbreakCase.id));
}

/** The report fields for an outbreak, from its location and its current line list. */
export async function reportFields(
  tx: Transaction,
  row: OutbreakRow,
  cases: readonly CaseRow[],
): Promise<UkhsaReportFields> {
  const [place] = await tx
    .select({
      name: location.name,
      postcode: location.postcode,
      regulatorLocationId: location.regulatorLocationId,
      regulator: location.regulator,
    })
    .from(location)
    .where(eq(location.id, row.locationId));
  return ukhsaReportFields(
    {
      syndrome: row.syndrome as OutbreakSyndrome,
      organism: row.organism,
      declaredOn: ukIsoDate(row.declaredAt),
    },
    {
      name: place?.name ?? "",
      postcode: place?.postcode ?? null,
      cqcLocationId: place?.regulator === "cqc" ? (place.regulatorLocationId ?? null) : null,
    },
    cases.map(domainCase),
  );
}

/** The report fields as the notification's content: one line each, for the person sending it. */
function reportContent(fields: UkhsaReportFields): Record<string, string> {
  const vaccination = (t: UkhsaReportFields["fluVaccination"]) =>
    `${t.yes} yes, ${t.no} no, ${t.unknown} not known`;
  return {
    setting: fields.settingName,
    postcode: fields.postcode ?? "",
    cqcLocationId: fields.cqcLocationId ?? "",
    illness: fields.syndrome,
    organism: fields.organism ?? "",
    residentsAffected: String(fields.residentCases),
    staffAffected: String(fields.staffCases),
    firstOnset: fields.firstOnsetOn ?? "",
    latestOnset: fields.latestOnsetOn ?? "",
    tests: `${fields.tested} tested, ${fields.positive} positive, ${fields.pending} pending`,
    hospitalised: String(fields.hospitalised),
    died: String(fields.died),
    fluVaccination: vaccination(fields.fluVaccination),
    covidVaccination: vaccination(fields.covidVaccination),
  };
}

export const REPORT_REQUIRED_CONTENT = [
  "The setting's address and postcode, and its CQC location ID",
  "How many residents and how many staff are unwell",
  "When symptoms started: the first and the latest",
  "Tests taken and their results",
  "Vaccination status of those affected",
  "Anyone in hospital, and any deaths",
];

/**
 * Hazard HZ-013: the UKHSA report an outbreak's clock runs on. A report at the location still being
 * prepared (draft or ready) is linked, so detection and declaration share one clock; otherwise a
 * draft is made now, due without delay, which the notification centre shows and escalates like any
 * other.
 */
export async function linkOrDraftReport(
  tx: Transaction,
  tenantId: string,
  row: OutbreakRow,
  now: Date,
): Promise<{ id: string; drafted: boolean }> {
  const [open] = await tx
    .select({ id: statutoryNotification.id })
    .from(statutoryNotification)
    .where(
      and(
        eq(statutoryNotification.locationId, row.locationId),
        eq(statutoryNotification.kind, "ukhsa_outbreak"),
        inArray(statutoryNotification.status, ["draft", "ready"]),
        isNull(statutoryNotification.deletedAt),
      ),
    )
    .orderBy(desc(statutoryNotification.createdAt))
    .limit(1);
  if (open) return { id: open.id, drafted: false };
  const drafted = await upsertDraft(
    tx,
    tenantId,
    {
      sourceKey: `outbreak:${row.id}`,
      kind: "ukhsa_outbreak",
      locationId: row.locationId,
      incidentId: null,
      personId: null,
      dueAt: now,
      deadlines: [
        {
          key: "without_delay",
          dueAt: now,
          wording: "Report the outbreak to the UKHSA health protection team as soon as possible.",
          statutory: false,
        },
      ],
      provisional: false,
      reasons: ["An outbreak was declared at this location."],
      requiredContent: REPORT_REQUIRED_CONTENT,
      sources: [UKHSA_OUTBREAK_SOURCE],
      classifierVersion: null,
    },
    now,
  );
  return { id: drafted.id, drafted: drafted.created };
}

/** Completes the linked report's content from the line list while it is still being prepared. */
export async function refreshReportContent(
  tx: Transaction,
  row: OutbreakRow,
  fields: UkhsaReportFields,
): Promise<void> {
  if (!row.notificationId) return;
  await tx
    .update(statutoryNotification)
    .set({ content: reportContent(fields) })
    .where(
      and(
        eq(statutoryNotification.id, row.notificationId),
        inArray(statutoryNotification.status, ["draft", "ready"]),
      ),
    );
}

/** The outbreak with its line list and report; `summarise` maps the linked notification. */
export async function outbreakDetail(
  tx: Transaction,
  row: OutbreakRow,
  summarise: (n: typeof statutoryNotification.$inferSelect) => OutbreakDetail["notification"],
): Promise<OutbreakDetail> {
  const rows = await outbreakCases(tx, row.id);
  const current = new Set(currentCases(rows.map(domainCase)).map((c) => c.id));
  const report = await reportFields(tx, row, rows);
  const [notification] = row.notificationId
    ? await tx
        .select()
        .from(statutoryNotification)
        .where(eq(statutoryNotification.id, row.notificationId))
    : [];
  return {
    ...outbreakSummary(row),
    cases: rows.map((r) => ({
      id: r.id,
      caseType: r.caseType as "resident" | "staff",
      personId: r.personId,
      tenantUserId: r.tenantUserId,
      onsetOn: r.onsetOn,
      symptoms: r.symptoms as OutbreakCase["symptoms"][number][],
      testType: r.testType as OutbreakCase["testType"],
      testedOn: r.testedOn,
      testResult: r.testResult as OutbreakCase["testResult"],
      fluVaccinated: r.fluVaccinated as OutbreakCase["fluVaccinated"],
      covidVaccinated: r.covidVaccinated as OutbreakCase["covidVaccinated"],
      outcome: r.outcome as OutbreakCase["outcome"],
      outcomeOn: r.outcomeOn,
      supersedesId: r.supersedesId,
      correctionReason: r.correctionReason,
      current: current.has(r.id),
      createdAt: r.createdAt.toISOString(),
      createdBy: r.createdBy,
    })),
    report: { ...report, missing: [...report.missing] },
    notification: notification ? summarise(notification) : null,
    stillUnwell: casesStillUnwell(rows.map(domainCase)),
  };
}
