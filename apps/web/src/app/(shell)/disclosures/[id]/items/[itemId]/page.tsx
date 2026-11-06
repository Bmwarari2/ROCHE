import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { ItemDecisionForm } from "@/components/safety-events/DisclosureForms";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import {
  canManageDisclosures,
  disclosuresShown,
  itemDecisionChip,
  plainName,
  plainValue,
  recordKind,
  recordReference,
  recordWhen,
} from "@/lib/disclosures";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: t("disclosures.item.pageTitle") };

const shown = (value: unknown): string =>
  plainValue(value, t, { date: formatDate, dateTime: formatDateTime });

/**
 * One collected record, reviewed before anything leaves: every field, other people's names found
 * in it said in words beside the field (never by colour alone), and the decision on it.
 */
export default async function DisclosureItemPage({
  params,
}: {
  params: Promise<{ id: string; itemId: string }>;
}) {
  const { id, itemId } = await params;
  if (!isUuid(id) || !isUuid(itemId)) notFound();
  const { me } = await getShellContext();
  const title = t("disclosures.item.pageTitle");
  if (!disclosuresShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/disclosures/{id}/items/{itemId}", {
    params: { path: { id, itemId } },
  });
  if (!data) {
    if (problemCode(error) === "missing_permission") return <SafetyForbidden title={title} />;
    if (response.status === 404) notFound();
    return failWith(error, response, `/disclosures/${id}/items/${itemId}`);
  }
  const fields = Object.keys(data.record ?? {});
  const namesIn = (field: string) => [
    ...new Set(data.highlights.filter((h) => h.field === field).map((h) => h.name)),
  ];
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        title={
          recordWhen(data.record)
            ? t("disclosures.item.titleWhen", {
                kind: recordKind(data.tableName),
                when: formatDateTime(recordWhen(data.record)) ?? "",
                reference: recordReference(data.recordId),
              })
            : t("disclosures.item.title", {
                kind: recordKind(data.tableName),
                reference: recordReference(data.recordId),
              })
        }
      />
      <p className="m-0 flex flex-wrap items-center gap-2">
        <SafetyChip chip={itemDecisionChip(data.decision, t)} />
        <Link
          href={`/disclosures/${id}`}
          className="inline-flex min-h-target items-center underline"
        >
          {t("disclosures.item.back")}
        </Link>
      </p>
      <Card as="section" headingLevel={2} title={t("disclosures.item.record")}>
        {data.record ? (
          <dl className="m-0 flex flex-col gap-3">
            {fields.map((field) => (
              <div key={field} className="flex flex-col gap-1">
                <dt className="text-body-dense font-semibold">{plainName(field)}</dt>
                <dd className="m-0 whitespace-pre-wrap break-words">
                  {shown(data.record?.[field])}
                  {namesIn(field).length > 0 ? (
                    <span className="mt-1 block text-body-dense font-semibold">
                      {t("disclosures.item.names", { names: namesIn(field).join(", ") })}
                    </span>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="m-0">{t("disclosures.item.gone")}</p>
        )}
      </Card>
      {canManageDisclosures(me.permissions) && data.record && data.contentSha256 ? (
        <Card as="section" headingLevel={2} title={t("disclosures.item.legend")}>
          <ItemDecisionForm
            id={id}
            itemId={itemId}
            fields={fields.map((field) => ({ name: field, label: plainName(field) }))}
            decision={data.decision}
            contentSha256={data.contentSha256}
            version={data.version}
            redacted={data.redactedFields}
          />
        </Card>
      ) : null}
    </div>
  );
}
