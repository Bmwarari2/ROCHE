import type { AdvanceCareItem } from "@harbour/contracts";
import { Card, StatusChip } from "@harbour/ui";
import { CircleCheck, Clock, HeartOff, HeartPulse, History } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { AdvanceCareForm } from "@/components/care/AdvanceCareForm";
import { ArrivalNotice } from "@/components/care/ArrivalNotice";
import { NoAccess } from "@/components/care/NoAccess";
import { RecordFrame } from "@/components/care/RecordFrame";
import { ResuscitationStatus } from "@/components/care/ResuscitationStatus";
import { WithdrawAdvanceCare } from "@/components/care/WithdrawAdvanceCare";
import { getShellContext, tenantApi } from "@/lib/api";
import { can, tabHref } from "@/lib/care-record";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { personNames } from "@/lib/people";
import { getPerson, readOrFail } from "@/lib/person-record";
import { readResuscitation } from "@/lib/record-data";
import { firstParam, recordMetadata } from "@/lib/record-metadata";
import { ukToday } from "@/lib/uk-time";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function RecordCard({
  item,
  personId,
  canWrite,
}: {
  readonly item: AdvanceCareItem;
  readonly personId: string;
  readonly canWrite: boolean;
}) {
  const active = item.status === "active";
  return (
    <Card as="article" title={t("care.advance.kind", { kind: item.kind })} headingLevel={4}>
      <div className="flex flex-col gap-2" data-advance-care={item.kind}>
        <p className="m-0 flex flex-wrap items-center gap-2">
          <StatusChip
            status={active ? "done" : "notApplicable"}
            label={t("care.advance.status", { status: item.status })}
            icon={active ? CircleCheck : History}
          />
          {item.cprDecision ? (
            <StatusChip
              status={item.cprDecision === "do_not_attempt_cpr" ? "info" : "neutral"}
              label={t("care.advance.cpr", { decision: item.cprDecision })}
              icon={item.cprDecision === "do_not_attempt_cpr" ? HeartOff : HeartPulse}
            />
          ) : null}
          {active && item.reviewOverdue ? (
            <StatusChip status="overdue" label={t("care.advance.reviewOverdue")} icon={Clock} />
          ) : null}
        </p>
        {item.clinicianName ? (
          <p className="m-0">
            {item.clinicianRole
              ? t("care.advance.clinician", { name: item.clinicianName, role: item.clinicianRole })
              : t("care.advance.clinicianNoRole", { name: item.clinicianName })}
          </p>
        ) : null}
        <p className="m-0 flex flex-wrap gap-x-4 text-callout text-text-secondary">
          <span>{t("care.advance.completedOn", { date: formatDate(item.completedOn) ?? "" })}</span>
          {item.reviewDueOn ? (
            <span>{t("care.advance.reviewDue", { date: formatDate(item.reviewDueOn) ?? "" })}</span>
          ) : null}
        </p>
        {item.details ? (
          <div>
            <p className="m-0 text-callout font-semibold">{t("care.advance.details")}</p>
            <p className="m-0 whitespace-pre-line">{item.details}</p>
          </div>
        ) : null}
        {item.withdrawnReason ? (
          <p className="m-0">
            {t("care.advance.withdrawn", {
              date: formatDateTime(item.withdrawnAt) ?? "",
              reason: item.withdrawnReason,
            })}
          </p>
        ) : null}
        {canWrite && active ? (
          <WithdrawAdvanceCare
            personId={personId}
            recordId={item.id}
            version={item.version}
            kind={item.kind}
          />
        ) : null}
        <p className="m-0 text-callout">
          <Link href={`/people/${personId}/history/advance_care_record/${item.id}`}>
            {t("care.advance.historyLink")}
          </Link>
        </p>
      </div>
    </Card>
  );
}

/** The page title names the tab, never the person. */
export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("advance-care");
}

/**
 * The advance care tab (register row CARE-015; hazard HZ-015): the resuscitation decision in force
 * as the header shows it, every ReSPECT plan, DNACPR decision, ADRT and advance care plan, and
 * for staff who may, a form to record one or withdraw one.
 */
async function AdvanceCareTab({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await params;
  const withdrawn = firstParam((await searchParams).withdrawn);
  const { person } = await getPerson(id);
  if (!person) return null;
  const { me } = await getShellContext();
  if (!can(me.permissions, "care.plan.read")) return <NoAccess />;
  const api = await tenantApi();
  const list = readOrFail(
    await api.GET("/v1/people/{id}/advance-care", {
      params: { path: { id }, query: { includeInactive: "true" } },
    }),
    tabHref(id, "advance-care"),
  );
  if (!list) return <NoAccess />;
  const names = personNames(person);
  const canWrite = can(me.permissions, "care.respect.record");
  const inForce = list.items.filter((item) => item.status === "active");
  const earlier = list.items.filter((item) => item.status !== "active");

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-eyebrow">{t("care.advance.title")}</h2>
        <p className="m-0 max-w-prose text-text-secondary">
          {t("care.advance.description", { name: names.preferred })}
        </p>
      </div>
      {withdrawn ? (
        <ArrivalNotice>{t("care.advance.withdraw.arrived", { kind: withdrawn })}</ArrivalNotice>
      ) : null}
      <Card as="section" title={t("care.header.resuscitation")} headingLevel={3}>
        <ResuscitationStatus status={readResuscitation(list.resuscitation)} />
      </Card>
      {canWrite ? (
        <Card as="section" title={t("care.advance.form.title")} headingLevel={3}>
          <AdvanceCareForm personId={id} today={ukToday()} />
        </Card>
      ) : null}
      <section aria-labelledby="advance-in-force" className="flex flex-col gap-3">
        <h3 id="advance-in-force" className="m-0 text-body font-semibold">
          {t("care.advance.inForce.title")}
        </h3>
        {inForce.length === 0 ? (
          <p className="m-0 text-text-secondary">{t("care.advance.empty")}</p>
        ) : (
          inForce.map((item) => (
            <RecordCard key={item.id} item={item} personId={id} canWrite={canWrite} />
          ))
        )}
      </section>
      {earlier.length > 0 ? (
        <section aria-labelledby="advance-earlier" className="flex flex-col gap-3">
          <h3 id="advance-earlier" className="m-0 text-body font-semibold">
            {t("care.advance.history.title")}
          </h3>
          {earlier.map((item) => (
            <RecordCard key={item.id} item={item} personId={id} canWrite={false} />
          ))}
        </section>
      ) : null}
    </>
  );
}

/** The tab inside the record's frame: the point-of-care header, read again on every tab, and the tabs. */
export default async function AdvanceCarePage(props: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="advance-care">
      <AdvanceCareTab {...props} />
    </RecordFrame>
  );
}
