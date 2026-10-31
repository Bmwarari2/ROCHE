import { buttonClassName, Card, EmptyState, PageHeader } from "@harbour/ui";
import { ClipboardCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { QualityChip } from "@/components/quality/QualityChip";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext, tenantApi } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { readOrFail } from "@/lib/person-record";
import { auditStateChip, auditsShown, scheduleChip, scoreText } from "@/lib/quality-programme";

export const metadata: Metadata = { title: t("quality.audits.title") };

type Summary = {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly locationId: string;
  readonly auditedOn: string;
  readonly state: "in_progress" | "completed";
  readonly scorePercent: number | null;
};

function AuditList({
  items,
  places,
}: {
  readonly items: readonly Summary[];
  readonly places: ReadonlyMap<string, string>;
}) {
  return (
    <ul className="m-0 flex list-none flex-col gap-4 p-0">
      {items.map((audit) => {
        const about = `audit-${audit.id}`;
        return (
          <li key={audit.id} className="flex flex-col gap-1 border-b border-border pb-3">
            <h3 className="m-0 text-body font-semibold">
              <Link
                href={`/quality/audits/${audit.id}`}
                aria-describedby={about}
                className="inline-flex min-h-target items-center underline"
              >
                {audit.title}
              </Link>
            </h3>
            <span>
              <QualityChip chip={auditStateChip(audit.state, t)} />
            </span>
            <span id={about} className="text-body-dense text-text-secondary">
              {t("quality.audits.itemDetail", {
                place: places.get(audit.locationId) ?? t("quality.audits.unknownPlace"),
                date: formatDate(audit.auditedOn) ?? "",
                score: audit.state === "completed" ? scoreText(audit.scorePercent, t) : "",
                completed: String(audit.state === "completed"),
              })}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The audit programme (QUAL-004; quality.md sections 19 and 20): when each scheduled audit is next
 * due (overdue said in words with the date), audits in progress, mock inspections and completed
 * audits with their scores, and the ways to start an audit and manage templates.
 */
export default async function AuditsPage() {
  const { me } = await getShellContext();
  const title = t("quality.audits.title");
  if (!auditsShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const [audits, schedules] = await Promise.all([
    api.GET("/v1/quality/audits", { params: { query: {} } }),
    api.GET("/v1/quality/audit-schedules", { params: { query: {} } }),
  ]);
  const list = readOrFail(audits, "/quality/audits");
  const due = readOrFail(schedules, "/quality/audits");
  if (!list || !due) return <SafetyForbidden title={title} />;
  const places = new Map(me.locations.map((l) => [l.id, l.name]));
  const inProgress = list.items.filter((a) => a.state === "in_progress");
  const mock = list.items.filter((a) => a.kind === "mock_inspection" && a.state === "completed");
  const completed = list.items.filter(
    (a) => a.kind !== "mock_inspection" && a.state === "completed",
  );
  const date = (iso: string) => formatDate(iso) ?? iso;

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6 break-words">
      <PageHeader
        title={title}
        description={t("quality.audits.description")}
        primaryAction={
          <Link href="/quality/audits/new" className={buttonClassName({ variant: "primary" })}>
            {t("quality.audits.start")}
          </Link>
        }
        secondaryActions={
          <Link
            href="/quality/audits/templates"
            className={buttonClassName({ variant: "secondary" })}
          >
            {t("quality.audits.templates")}
          </Link>
        }
      />
      <Card as="section" title={t("quality.audits.schedules")} headingLevel={2}>
        {due.items.length === 0 ? (
          <p className="m-0">{t("quality.audits.noSchedules")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {due.items.map((s) => (
              <li key={s.id} className="flex flex-col gap-1 border-b border-border pb-3">
                <span className="font-semibold">
                  {t("quality.audits.scheduleItem", {
                    title: s.templateTitle,
                    place: places.get(s.locationId) ?? t("quality.audits.unknownPlace"),
                  })}
                </span>
                <span>
                  <QualityChip chip={scheduleChip(s, date, t)} />
                </span>
                <span className="text-body-dense text-text-secondary">
                  {t("quality.audits.scheduleDetail", {
                    months: s.frequencyMonths,
                    last: s.lastCompletedOn ? date(s.lastCompletedOn) : "",
                    hasLast: String(s.lastCompletedOn !== null),
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {list.items.length === 0 ? (
        <EmptyState
          icon={<ClipboardCheck size={32} strokeWidth={1.5} aria-hidden="true" />}
          title={t("quality.audits.empty")}
          description={t("quality.audits.emptyHint")}
        />
      ) : (
        <>
          <Card as="section" title={t("quality.audits.inProgress")} headingLevel={2}>
            {inProgress.length === 0 ? (
              <p className="m-0">{t("quality.audits.noneInProgress")}</p>
            ) : (
              <AuditList items={inProgress} places={places} />
            )}
          </Card>
          <Card as="section" title={t("quality.audits.mockInspections")} headingLevel={2}>
            {mock.length === 0 ? (
              <p className="m-0">{t("quality.audits.noMock")}</p>
            ) : (
              <AuditList items={mock} places={places} />
            )}
          </Card>
          <Card as="section" title={t("quality.audits.completed")} headingLevel={2}>
            {completed.length === 0 ? (
              <p className="m-0">{t("quality.audits.noneCompleted")}</p>
            ) : (
              <AuditList items={completed} places={places} />
            )}
          </Card>
        </>
      )}
    </div>
  );
}
