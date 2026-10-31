import { Card, StatusChip } from "@harbour/ui";
import { CircleAlert, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { Notice } from "@/components/care/Notice";
import { DataRightsFrame } from "@/components/data-rights/DataRightsFrame";
import { DecisionForm } from "@/components/data-rights/DsarForms";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { dataRightsShown } from "@/lib/data-rights";
import {
  decisionChip,
  fieldText,
  itemPage,
  partName,
  requestPage,
  splitHighlights,
} from "@/lib/dsar";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";

const read = cache(async (id: string) =>
  (await tenantApi()).GET("/v1/dsar-cases/{id}", { params: { path: { id } } }),
);

/** The page title names the record by its date, never who it is about. */
export async function generateMetadata({ params }: { readonly params: Params }): Promise<Metadata> {
  const { id } = await params;
  const data = isUuid(id) ? (await read(id)).data : undefined;
  return { title: t("dataRights.item.pageTitle", { date: formatDate(data?.receivedOn) ?? "" }) };
}

type Params = Promise<{ readonly id: string; readonly itemId: string }>;

const icon = { size: 20, strokeWidth: 1.5, "aria-hidden": true } as const;

/**
 * One collected record for a person to decide (PLAT-022; the DSAR workbench rule 4). Opening it
 * needs a fresh step-up and is audited against the subject; the API's refusal sends the person to
 * sign in again and back here. Other people's names are marked in the text (a bold underline and
 * the words "Name of another person", never colour alone) and listed, but nothing is taken out
 * except by the reviewer's decision.
 */
export default async function ItemPage({ params }: { readonly params: Params }) {
  const { id, itemId } = await params;
  if (!isUuid(id) || !isUuid(itemId)) notFound();
  const { me } = await getShellContext();
  const title = t("dataRights.item.title");
  if (!dataRightsShown(me)) {
    return <SafetyForbidden title={title} hint={t("dataRights.orgWideOnly")} />;
  }
  const path = itemPage(id, itemId);
  const api = await tenantApi();
  const found = await api.GET("/v1/dsar-cases/{id}/items/{itemId}", {
    params: { path: { id, itemId } },
  });
  if (found.response.status === 404) notFound();
  if (!found.data) failWith(found.error, found.response, path);
  const item = found.data;
  const fields = Object.entries(item.record ?? {});
  const chip = decisionChip(item.decision, t);

  return (
    <DataRightsFrame
      tab="requests"
      title={title}
      eyebrow={t("dataRights.item.part", { part: partName(item.tableName) })}
    >
      <nav aria-label={t("common.breadcrumb")} className="text-body-dense">
        <Link href={requestPage(id)} className="inline-flex min-h-target items-center underline">
          {t("dataRights.item.back")}
        </Link>
      </nav>
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip status={chip.status} label={chip.label} />
        {item.reviewedAt ? (
          <span>
            {t("dataRights.item.decided", {
              decision: chip.label,
              name: item.reviewedBy?.displayName ?? "",
              dateTime: formatDateTime(item.reviewedAt) ?? "",
            })}
          </span>
        ) : null}
      </div>

      {item.record === null ? (
        <Notice tone="warning" icon={<CircleAlert {...icon} />} title={t("dataRights.item.gone")} />
      ) : (
        <Card as="section" title={t("dataRights.item.names.title")} headingLevel={2}>
          <div className="flex flex-col gap-2">
            {item.highlights.length > 0 ? (
              <>
                <p className="m-0 max-w-prose">{t("dataRights.item.names.intro")}</p>
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                  {item.highlights.map((h) => (
                    <li key={`${h.field}-${h.start}`} className="flex items-center gap-2">
                      <Users size={16} strokeWidth={1.5} aria-hidden="true" />
                      {t("dataRights.item.names.item", { name: h.name, field: partName(h.field) })}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="m-0 max-w-prose">{t("dataRights.item.names.none")}</p>
            )}
          </div>
        </Card>
      )}

      {item.record !== null ? (
        <Card as="section" title={t("dataRights.item.fields")} headingLevel={2}>
          <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[minmax(10rem,1fr)_3fr]">
            {fields.map(([field, value]) => {
              const shown = fieldText(value);
              const marks = item.highlights.filter((h) => h.field === field);
              return (
                <div key={field} className="contents">
                  <dt className="font-semibold">{partName(field)}</dt>
                  <dd className="m-0 whitespace-pre-wrap break-words">
                    {shown === null ? (
                      <span className="text-text-secondary">{t("dataRights.item.empty")}</span>
                    ) : (
                      splitHighlights(shown, marks).map((part, index) =>
                        part.name ? (
                          <mark
                            // biome-ignore lint/suspicious/noArrayIndexKey: parts are fixed for the render.
                            key={index}
                            className="rounded-sm border-b-2 border-warning bg-bg-secondary px-0.5 font-semibold text-inherit"
                          >
                            <span className="hb-visually-hidden">
                              {t("dataRights.item.highlight")}:{" "}
                            </span>
                            {part.text}
                          </mark>
                        ) : (
                          // biome-ignore lint/suspicious/noArrayIndexKey: parts are fixed for the render.
                          <span key={index}>{part.text}</span>
                        ),
                      )
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </Card>
      ) : null}

      {item.contentSha256 ? (
        <Card as="section" title={t("dataRights.item.decision")} headingLevel={2}>
          <DecisionForm
            caseId={id}
            itemId={itemId}
            version={item.version}
            sha256={item.contentSha256}
            fields={fields.map(([field]) => field)}
            current={{
              decision: item.decision,
              redactedFields: item.redactedFields,
              reason: item.reason,
            }}
            path={path}
          />
        </Card>
      ) : null}
    </DataRightsFrame>
  );
}
