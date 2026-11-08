import type { RetentionDue } from "@harbour/contracts";
import { Card, StatusChip } from "@harbour/ui";
import { CircleMinus, ClipboardList } from "lucide-react";
import { CountTable } from "@/components/platform/CountTable";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { classWords, DUE_COLUMNS, dueCounts, dueRows, dueView } from "@/lib/retention-report";

/**
 * Records due for destruction (retention sweeps plan slice 5; 5.9 report first): the latest
 * nightly retention report's counts per kind of record, from `GET /v1/retention/due`. It only
 * counts; nothing here destroys or changes a record. `due` is null when the reader's retention
 * role is not organisation-wide, which the report needs.
 */
export function RetentionReport({ due }: { readonly due: RetentionDue | null }) {
  const view = due ? dueView(due) : null;
  return (
    <Card as="section" title={t("retention.due.title")} headingLevel={2}>
      <div className="flex flex-col gap-3">
        <p className="m-0 max-w-prose font-semibold">{t("retention.due.onlyCounts")}</p>
        {view === null ? (
          <p className="m-0 max-w-prose">{t("retention.due.tenantOnly")}</p>
        ) : view.kind === "off" ? (
          <>
            <p className="m-0">
              <StatusChip
                status="notApplicable"
                label={t("retention.due.off")}
                icon={CircleMinus}
              />
            </p>
            <p className="m-0 max-w-prose">{t("retention.due.offBody")}</p>
          </>
        ) : (
          <>
            <p className="m-0">
              <StatusChip status="info" label={t("retention.due.on")} icon={ClipboardList} />
            </p>
            {view.kind === "waiting" ? (
              <p className="m-0 max-w-prose">{t("retention.due.waiting")}</p>
            ) : (
              <Report report={view.report} />
            )}
          </>
        )}
      </div>
    </Card>
  );
}

function Report({ report }: { readonly report: NonNullable<RetentionDue["report"]> }) {
  const totals = dueCounts(report.totals);
  const header = (column: (typeof DUE_COLUMNS)[number]) => t("retention.due.column", { column });
  return (
    <>
      <p className="m-0">
        <time dateTime={report.asOf}>
          {t("retention.due.asOf", { dateTime: formatDateTime(report.asOf) ?? "" })}
        </time>
      </p>
      <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {DUE_COLUMNS.map((column) => (
          <div key={column} className="min-w-0">
            <dt className="text-body-dense font-semibold">{header(column)}</dt>
            <dd className="m-0">{t("retention.due.records", { count: totals[column] })}</dd>
          </div>
        ))}
      </dl>
      <p className="m-0 max-w-prose">{t("retention.due.meaning")}</p>
      <CountTable
        caption={t("retention.due.caption")}
        columns={[
          { id: "recordClass", header: t("retention.due.classColumn") },
          ...DUE_COLUMNS.map((column) => ({ id: column, header: header(column), numeric: true })),
        ]}
        rows={dueRows(report.lines).map((row) => ({
          id: row.recordClass ?? "unread",
          cells: { recordClass: classWords(row.recordClass, t), ...row.counts },
        }))}
      />
      <p className="m-0 text-body-dense">
        {t("retention.due.tables", { read: report.tablesRead, skipped: report.tablesSkipped })}
      </p>
    </>
  );
}
