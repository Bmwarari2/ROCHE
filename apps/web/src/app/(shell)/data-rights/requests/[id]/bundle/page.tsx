import { ButtonLink, Card } from "@harbour/ui";
import { Download, SearchX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { Notice } from "@/components/care/Notice";
import { DataRightsFrame } from "@/components/data-rights/DataRightsFrame";
import { RespondForm } from "@/components/data-rights/DsarForms";
import { PersonNeeds } from "@/components/safety/PersonNeeds";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { dataRightsShown } from "@/lib/data-rights";
import { bundleBlocker, bundlePage, fieldText, partName, requestPage } from "@/lib/dsar";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";

const read = cache(async (id: string) =>
  (await tenantApi()).GET("/v1/dsar-cases/{id}", { params: { path: { id } } }),
);

/** The page title names the record by its date, never who it is about. */
export async function generateMetadata({ params }: { readonly params: Params }): Promise<Metadata> {
  const { id } = await params;
  const data = isUuid(id) ? (await read(id)).data : undefined;
  return {
    title: t("dataRights.bundle.pageTitleFor", { date: formatDate(data?.receivedOn) ?? "" }),
  };
}

type Params = Promise<{ readonly id: string }>;

/** Records shown on the page; the file holds every one. */
const SHOWN_RECORDS = 100;

/**
 * The response as it will be sent (PLAT-022; the DSAR workbench rule 5): the counts, what could
 * not be searched, each record with parts taken out reading [redacted], the fingerprint, a file
 * to send, and the form that records the response and closes the request. Reading the bundle and
 * responding need a fresh step-up; the API's refusal sends the person to sign in again.
 */
export default async function BundlePage({ params }: { readonly params: Params }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const title = t("dataRights.bundle.pageTitle");
  if (!dataRightsShown(me)) {
    return <SafetyForbidden title={title} hint={t("dataRights.orgWideOnly")} />;
  }
  const path = bundlePage(id);
  const api = await tenantApi();
  const found = await api.GET("/v1/dsar-cases/{id}", { params: { path: { id } } });
  if (found.response.status === 404) notFound();
  if (!found.data) failWith(found.error, found.response, path);
  const c = found.data;
  // The person's communication needs, so the response goes in the format they need (AIS).
  const person =
    c.subject.kind === "person" && c.subject.personId
      ? (await api.GET("/v1/people/{id}", { params: { path: { id: c.subject.personId } } })).data
      : undefined;
  // Closed, or not ready: the request page says what is left to do.
  if (c.status !== "open" || bundleBlocker(c) !== null) redirect(requestPage(id));
  const bundle = await api.GET("/v1/dsar-cases/{id}/bundle", { params: { path: { id } } });
  if (!bundle.data) failWith(bundle.error, bundle.response, path);
  const b = bundle.data;
  return (
    <DataRightsFrame tab="requests" title={title} eyebrow={c.subject.name}>
      <nav aria-label={t("common.breadcrumb")} className="text-body-dense">
        <Link href={requestPage(id)} className="inline-flex min-h-target items-center underline">
          {t("dataRights.item.back")}
        </Link>
      </nav>
      {person ? <PersonNeeds person={person} /> : null}
      <Card as="section" title={t("dataRights.bundle.records")} headingLevel={2}>
        <div className="flex flex-col gap-4">
          <p className="m-0 max-w-prose">{t("dataRights.bundle.intro")}</p>
          <p className="m-0">
            {t("dataRights.bundle.counts", {
              records: b.records.length,
              redacted: b.redactedCount,
              withheld: b.withheldCount,
            })}
          </p>
          {b.notSearched.length > 0 ? (
            <Notice
              tone="warning"
              icon={<SearchX size={20} strokeWidth={1.5} aria-hidden />}
              title={t("dataRights.notSearched.title")}
            >
              <ul className="m-0 flex flex-col gap-1 ps-5">
                {b.notSearched.map((n) => (
                  <li key={n.table}>
                    <span className="font-semibold">{partName(n.table)}</span>:{" "}
                    {t("dataRights.notSearched.reason", { reason: n.reason })}
                  </li>
                ))}
              </ul>
            </Notice>
          ) : null}
          <p className="m-0 break-all text-text-secondary">
            {t("dataRights.bundle.fingerprint", { sha: b.sha256 })}
          </p>
          <div>
            <ButtonLink
              href={`${path}/download`}
              variant="secondary"
              icon={<Download size={18} strokeWidth={1.5} aria-hidden />}
            >
              {t("dataRights.bundle.download")}
            </ButtonLink>
          </div>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {b.records.slice(0, SHOWN_RECORDS).map((r) => (
              <li key={`${r.table}-${r.recordId}`}>
                <details className="rounded-input border border-border p-3">
                  <summary className="flex min-h-target cursor-pointer items-center font-semibold">
                    {t("dataRights.bundle.record", {
                      part: partName(r.table),
                      record: r.recordId.slice(0, 8),
                    })}
                  </summary>
                  <dl className="m-0 mt-2 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[minmax(10rem,1fr)_3fr]">
                    {Object.entries(r.fields).map(([field, value]) => (
                      <div key={field} className="contents">
                        <dt className="font-semibold">{partName(field)}</dt>
                        <dd className="m-0 whitespace-pre-wrap break-words">
                          {fieldText(value) ?? t("dataRights.item.empty")}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </details>
              </li>
            ))}
          </ul>
          {b.records.length > SHOWN_RECORDS ? (
            <p className="m-0">
              {t("dataRights.bundle.more", { shown: SHOWN_RECORDS, total: b.records.length })}
            </p>
          ) : null}
        </div>
      </Card>
      <Card as="section" title={t("dataRights.bundle.respond")} headingLevel={2}>
        <RespondForm id={id} version={c.version} />
      </Card>
    </DataRightsFrame>
  );
}
