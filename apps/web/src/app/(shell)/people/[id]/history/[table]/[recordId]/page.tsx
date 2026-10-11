import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NoAccess } from "@/components/care/NoAccess";
import { VersionList } from "@/components/care/VersionList";
import { getShellContext, problemCode, tenantApi } from "@/lib/api";
import { can, tabHref } from "@/lib/care-record";
import { isUuid } from "@/lib/context-cookies";
import { isHistoryTable } from "@/lib/history";
import { t } from "@/lib/i18n";
import { getPerson, readOrFail } from "@/lib/person-record";
import { recordMetadata } from "@/lib/record-metadata";

type Params = Promise<{ id: string; table: string; recordId: string }>;

/** The page title names the tab and the kind of record, never the person. */
export async function generateMetadata({ params }: { readonly params: Params }): Promise<Metadata> {
  const { table } = await params;
  return recordMetadata(
    "history",
    t("care.history.versions.title", {
      record: t("care.history.recordName", { table: isHistoryTable(table) ? table : "other" }),
    }),
  );
}

/** Every earlier version of one care plan, section, action, risk assessment or advance care record. */
export default async function RecordHistoryPage({ params }: { readonly params: Params }) {
  const { id, table, recordId } = await params;
  const { person } = await getPerson(id);
  if (!person) return null;
  if (!isHistoryTable(table) || !isUuid(recordId)) notFound();
  const { me } = await getShellContext();
  if (!can(me.permissions, "care.plan.read")) return <NoAccess />;
  const path = tabHref(id, "history");
  const api = await tenantApi();
  const result = await api.GET("/v1/people/{id}/care-history/{table}/{recordId}", {
    params: { path: { id, table, recordId } },
  });
  if (problemCode(result.error) === "not_found") notFound();
  const history = readOrFail(result, path);
  if (!history) return <NoAccess />;
  const record = t("care.history.recordName", { table });

  return (
    <>
      <p className="m-0 text-callout">
        <Link href={path}>{t("care.history.back")}</Link>
      </p>
      <h2 className="m-0 text-eyebrow">{t("care.history.versions.title", { record })}</h2>
      <VersionList
        history={history}
        tenantUserId={me.tenantUserId}
        label={t("care.history.versions.title", { record })}
      />
    </>
  );
}
