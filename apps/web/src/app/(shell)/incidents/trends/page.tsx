import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { ChartColumn, Info, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Notice } from "@/components/care/Notice";
import { IncidentTrendsTable } from "@/components/safety/IncidentTrendsTable";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { can } from "@/lib/care-record";
import { t } from "@/lib/i18n";
import { monthLabel, trendMonths, trendTable } from "@/lib/incident-trends";
import { INCIDENT_LIST_LIMIT } from "@/lib/incidents";

export const metadata: Metadata = { title: t("safety.trends.title") };

const iconProps = { size: 20, strokeWidth: 1.5, "aria-hidden": true } as const;

/**
 * Incident trends (register row SAFE-010; safety.md section 5): how many incidents and near misses
 * were recorded at the chosen location in each of the last six UK calendar months, by type, from
 * the incidents the reader can list (`GET /v1/incidents`, one read per month). Counts only, as
 * recorded: the page says it does not judge what they mean (medical-device boundary). A month
 * whose read reached the API's limit says its counts are at least that.
 */
export default async function IncidentTrendsPage() {
  const { me, locationId } = await getShellContext();
  const title = t("safety.trends.title");
  if (!can(me.permissions, "safety.incident.read")) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const months = trendMonths(new Date());
  const lists = await Promise.all(
    months.map(async (month) => {
      const query = {
        ...(locationId ? { locationId } : {}),
        from: month.from,
        to: month.to,
      };
      const { data, error, response } = await api.GET("/v1/incidents", { params: { query } });
      if (data) return data.items;
      if (problemCode(error) === "missing_permission") return null;
      return failWith(error, response, "/incidents/trends");
    }),
  );
  if (lists.some((list) => list === null)) return <SafetyForbidden title={title} />;
  const table = trendTable(
    months,
    lists.map((list) => list ?? []),
    t,
  );
  const location = me.locations.find((l) => l.id === locationId);
  const count = (n: number, key: string) =>
    table.capped.includes(key) ? t("safety.trends.atLeast", { count: n }) : String(n);
  const cells = (counts: readonly number[]) => counts.map((n, i) => count(n, months[i]?.key ?? ""));

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <nav aria-label={t("common.breadcrumb")} className="text-body-dense">
        <Link href="/incidents" className="underline">
          {t("safety.incidents.title")}
        </Link>
        <span aria-hidden="true" className="px-2 text-text-secondary">
          ›
        </span>
        <span aria-current="page">{title}</span>
      </nav>
      <PageHeader
        eyebrow={location ? location.name : me.tenant.name}
        title={title}
        description={t("safety.trends.description")}
      />
      <Notice icon={<Info {...iconProps} />} title={t("safety.trends.countsOnly")}>
        {t("safety.trends.countsOnlyHint")}
      </Notice>
      {table.capped.length > 0 ? (
        <Notice
          tone="warning"
          icon={<TriangleAlert {...iconProps} />}
          title={t("safety.trends.capped", { limit: INCIDENT_LIST_LIMIT })}
        />
      ) : null}
      {table.rows.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<ChartColumn size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("safety.trends.empty")}
          />
        </Card>
      ) : (
        <IncidentTrendsTable
          caption={t("safety.trends.caption", {
            from: monthLabel(months[0] ?? { year: 0, month: 0 }, t),
            to: monthLabel(months.at(-1) ?? { year: 0, month: 0 }, t),
          })}
          typeHeader={t("safety.trends.type")}
          totalHeader={t("safety.trends.total")}
          months={months.map((m) => monthLabel(m, t))}
          rows={[...table.rows, table.total].map((row) => ({
            id: row.type,
            label: row.label,
            cells: cells(row.counts),
            total:
              table.capped.length > 0
                ? t("safety.trends.atLeast", { count: row.total })
                : String(row.total),
          }))}
        />
      )}
    </div>
  );
}
