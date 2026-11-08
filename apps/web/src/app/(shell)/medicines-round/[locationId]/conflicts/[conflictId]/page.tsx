import { Card, PageHeader } from "@harbour/ui";
import { Info, PenLine } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Notice } from "@/components/care/Notice";
import { ConflictDecisionForm } from "@/components/medicines/ConflictForms";
import { ConflictRecords } from "@/components/medicines/ConflictRecords";
import { PersonHeaderCompact } from "@/components/people/PersonHeader";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import {
  conflictHref,
  conflictsHref,
  correctHref,
  correctionSince,
  decisionsFor,
  entryUnit,
  RESOLVER,
} from "@/lib/administration-corrections";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { can } from "@/lib/care-record";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { medicinesRoundShown } from "@/lib/medicine-round";
import { firstParam } from "@/lib/record-metadata";

type Params = Promise<{ locationId: string; conflictId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: t("medicines.conflicts.decideTitle") };

const iconProps = { size: 20, strokeWidth: 1.5, "aria-hidden": true } as const;

/**
 * Deciding a dose recorded twice (HZ-004; medicines.md 15.4): both records side by side, the way
 * to correct the record that stands when it is itself wrong, and the decision with what was found
 * out. Offered only the decisions the records allow; the API decides again, and for a controlled
 * drug needs medicines.cd.administer, a fresh sign-in and someone who took no part in the dose.
 */
export default async function ConflictPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { locationId, conflictId } = await params;
  if (!isUuid(locationId) || !isUuid(conflictId)) notFound();
  const { me } = await getShellContext();
  const title = t("medicines.conflicts.decideTitle");
  if (!medicinesRoundShown(me.permissions)) return <SafetyForbidden title={title} />;
  const location = me.locations.find((l) => l.id === locationId);
  if (!location) notFound();
  const api = await tenantApi();
  const read = await api.GET("/v1/medicine-administration-conflicts/{id}", {
    params: { path: { id: conflictId } },
  });
  if (problemCode(read.error) === "not_found") notFound();
  if (problemCode(read.error) === "missing_permission") return <SafetyForbidden title={title} />;
  if (!read.data) failWith(read.error, read.response, conflictsHref(locationId));
  const conflict = read.data;
  const [people, record] = await Promise.all([
    api.GET("/v1/people", { params: { query: { locationId } } }),
    api.GET("/v1/people/{id}/medicines", { params: { path: { id: conflict.personId } } }),
  ]);
  const person = (people.data?.items ?? []).find((p) => p.id === conflict.personId);
  // A dose at another home is decided from that home's list.
  if (!person) notFound();
  const entry = (record.data?.entries ?? []).find((e) => e.id === conflict.entryId);
  const medicine = entry?.product.name ?? t("medicines.conflicts.someMedicine");
  const path = conflictHref(locationId, conflictId);
  const offered = decisionsFor(conflict);
  const correction = correctionSince(conflict);
  const query = await searchParams;
  const done = firstParam(query.done);
  const resolution = conflict.resolution;

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      {done === "corrected" ? (
        <RecordedArrival message={t("medicines.conflicts.correctedArrival")} param="done" />
      ) : null}
      <PageHeader
        eyebrow={location.name}
        title={t("medicines.conflicts.cardTitle", { medicine })}
      />
      <Card as="section" title={t("medicines.conflicts.recordsTitle")} headingLevel={2}>
        <div className="flex flex-col gap-3">
          <PersonHeaderCompact person={person} headingLevel={3} />
          <p className="m-0">
            {t("medicines.conflicts.due", { at: formatDateTime(conflict.dueAt) ?? "" })}
          </p>
          <ConflictRecords
            conflict={conflict}
            unit={entry ? (entryUnit(entry)?.name ?? null) : null}
          />
        </div>
      </Card>
      {resolution ? (
        <Card as="section" title={t("medicines.conflicts.resolvedTitle")} headingLevel={2}>
          <p className="m-0">
            {t("medicines.conflicts.resolved", {
              outcome: resolution.outcome,
              at: formatDateTime(resolution.at) ?? "",
            })}
          </p>
          <p className="m-0 whitespace-pre-wrap">{resolution.note}</p>
        </Card>
      ) : (
        <>
          {conflict.controlledDrug ? (
            <Notice
              icon={<Info {...iconProps} />}
              title={t("medicines.conflicts.controlledNotice")}
            />
          ) : null}
          {conflict.current.supersededById === null ? (
            <Card as="section" title={t("medicines.conflicts.correctTitle")} headingLevel={2}>
              <div className="flex flex-col gap-3">
                <p className="m-0 max-w-prose">{t("medicines.conflicts.correctIntro")}</p>
                <p className="m-0">
                  <Link
                    href={correctHref(conflict.personId, conflict.current.id, conflictId)}
                    className="inline-flex min-h-target items-center gap-2 underline"
                  >
                    <PenLine size={18} strokeWidth={1.5} aria-hidden="true" />
                    {t("medicines.conflicts.correctLink")}
                  </Link>
                </p>
              </div>
            </Card>
          ) : null}
          {can(me.permissions, RESOLVER) ? (
            <Card as="section" title={t("medicines.conflicts.decideTitle")} headingLevel={2}>
              {offered.length === 0 ? (
                <p className="m-0">{t("medicines.conflicts.correctFirst")}</p>
              ) : (
                <ConflictDecisionForm
                  conflictId={conflictId}
                  offered={offered}
                  correctionId={correction?.id ?? null}
                  path={path}
                  done={conflictsHref(locationId)}
                />
              )}
            </Card>
          ) : (
            <p className="m-0">{t("medicines.conflicts.notYours")}</p>
          )}
        </>
      )}
      <p className="m-0">
        <Link
          href={conflictsHref(locationId)}
          className="inline-flex min-h-target items-center underline"
        >
          {t("medicines.conflicts.back")}
        </Link>
      </p>
    </div>
  );
}
