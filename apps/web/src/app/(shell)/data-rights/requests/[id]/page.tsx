import { ButtonLink, Card, StatusChip } from "@harbour/ui";
import { CircleAlert, Download, FileSearch, SearchX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { Notice } from "@/components/care/Notice";
import { ClockChip } from "@/components/data-rights/ClockChip";
import { DataRightsFrame } from "@/components/data-rights/DataRightsFrame";
import {
  CollectForm,
  ErasureForm,
  ExtensionForm,
  IdentityForm,
  PauseForm,
} from "@/components/data-rights/DsarForms";
import { PersonNeeds } from "@/components/safety/PersonNeeds";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { dataRightsShown, REQUESTS_PAGE } from "@/lib/data-rights";
import {
  bundleBlocker,
  bundlePage,
  decisionChip,
  itemPage,
  partName,
  requestPage,
} from "@/lib/dsar";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { firstParam } from "@/lib/record-metadata";

const read = cache(async (id: string) =>
  (await tenantApi()).GET("/v1/dsar-cases/{id}", { params: { path: { id } } }),
);

/** The page title names the record by its date, never who it is about. */
export async function generateMetadata({ params }: { readonly params: Params }): Promise<Metadata> {
  const { id } = await params;
  const data = isUuid(id) ? (await read(id)).data : undefined;
  return { title: t("dataRights.request.pageTitle", { date: formatDate(data?.receivedOn) ?? "" }) };
}

type Params = Promise<{ readonly id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const DONE = new Set([
  "created",
  "identity",
  "paused",
  "resumed",
  "extended",
  "collected",
  "decided",
  "responded",
  "erasure",
]);
/** The records listed on the page; the rest are reviewed in turn as these are decided. */
const SHOWN_ITEMS = 200;
const icon = { size: 20, strokeWidth: 1.5, "aria-hidden": true } as const;

/**
 * One data subject request (PLAT-022; platform.md, the DSAR workbench rules 2 to 8), in the order
 * the work is done: confirm who is asking (the clock starts), pause or extend the clock, find the
 * records with what could not be searched named first, review each record, then check and send
 * the response. The API works out the clock on every read and checks every rule again.
 */
export default async function RequestPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const title = t("dataRights.requests.title");
  if (!dataRightsShown(me)) {
    return <SafetyForbidden title={title} hint={t("dataRights.orgWideOnly")} />;
  }
  const path = requestPage(id);
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
  const items =
    c.collectedAt === null
      ? null
      : await api.GET("/v1/dsar-cases/{id}/items", { params: { path: { id } } });
  if (items && !items.data) failWith(items.error, items.response, path);
  const listed = items?.data?.items ?? [];
  const done = firstParam((await searchParams).done);
  const open = c.status === "open";
  const paused = c.pauses.some((p) => p.to === null);
  const blocker = bundleBlocker(c);

  return (
    <DataRightsFrame
      tab="requests"
      eyebrow={t("dataRights.request.kind", { kind: c.requestKind })}
      title={c.subject.name}
    >
      <nav aria-label={t("common.breadcrumb")} className="text-body-dense">
        <Link href={REQUESTS_PAGE} className="inline-flex min-h-target items-center underline">
          {t("dataRights.requests.title")}
        </Link>
      </nav>
      {person ? <PersonNeeds person={person} /> : null}
      {done && DONE.has(done) ? (
        <RecordedArrival message={t("dataRights.case.done", { done })} param="done" />
      ) : null}
      {c.clockProblem ? (
        <Notice
          tone="warning"
          icon={<CircleAlert {...icon} />}
          title={t("dataRights.clock.problem")}
        >
          {c.clockProblem}
        </Notice>
      ) : null}

      <Card as="section" title={t("dataRights.case.clock")} headingLevel={2}>
        {/* The clock, and who is asking: both say where the request stands. */}
        <div className="flex flex-col gap-2">
          <ClockChip clock={c.clock} respondedOn={c.respondedOn} withWords />
          {c.clock?.startedOn ? (
            <p className="m-0">
              {t("dataRights.clock.started", { date: formatDate(c.clock.startedOn) ?? "" })}
            </p>
          ) : null}
          {c.clock && c.clock.pausedDays > 0 ? (
            <p className="m-0">{t("dataRights.clock.paused", { days: c.clock.pausedDays })}</p>
          ) : null}
          {c.clock?.extended && c.clock.originalDueOn ? (
            <p className="m-0">
              {t("dataRights.clock.extended", {
                original: formatDate(c.clock.originalDueOn) ?? "",
                due: formatDate(c.clock.dueOn) ?? "",
              })}
            </p>
          ) : null}
          {c.clock?.state === "closed" && c.clock.late !== null ? (
            <p className="m-0">
              {t("dataRights.clock.late", {
                late: c.clock.late ? "yes" : "no",
                due: formatDate(c.clock.dueOn) ?? "",
              })}
            </p>
          ) : null}
          <h3 className="m-0 mt-2 text-body font-semibold">{t("dataRights.case.requester")}</h3>
          <p className="m-0">
            {c.requesterKind === "representative" && c.authority
              ? t("dataRights.case.requesterOther", {
                  name: c.requesterName ?? "",
                  authority: t("dataRights.new.authorityOption", { authority: c.authority }),
                  channel: c.channel,
                })
              : t("dataRights.case.requesterSelf", { channel: c.channel })}
          </p>
          <p className="m-0 text-text-secondary">
            {t("dataRights.requests.received", { date: formatDate(c.receivedOn) ?? "" })}
          </p>
        </div>
      </Card>

      {c.status !== "open" ? (
        <Card as="section" title={t("dataRights.closed.title")} headingLevel={2}>
          <div className="flex flex-col gap-2">
            {c.outcome ? (
              <p className="m-0">
                {t("dataRights.closed.outcome", {
                  outcome: t("dataRights.bundle.outcomeOption", { outcome: c.outcome }),
                  date: formatDate(c.respondedOn) ?? "",
                })}
              </p>
            ) : null}
            {c.outcomeReason ? <p className="m-0">{c.outcomeReason}</p> : null}
            {c.bundleSha256 && c.bundleIssuedAt ? (
              <p className="m-0 break-all">
                {t("dataRights.closed.issued", {
                  dateTime: formatDateTime(c.bundleIssuedAt) ?? "",
                  sha: c.bundleSha256,
                })}
              </p>
            ) : null}
            {c.bundleStored ? (
              <>
                <p className="m-0">{t("dataRights.closed.kept")}</p>
                <div>
                  <ButtonLink
                    href={`${bundlePage(id)}/download?issued=1`}
                    variant="secondary"
                    icon={<Download size={18} strokeWidth={1.5} aria-hidden />}
                  >
                    {t("dataRights.closed.download")}
                  </ButtonLink>
                </div>
              </>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Card as="section" title={t("dataRights.identity.title")} headingLevel={2}>
        {!c.identityRequired ? (
          <p className="m-0">{t("dataRights.identity.notNeeded")}</p>
        ) : c.identityVerifiedOn && c.identityMethod ? (
          <p className="m-0">
            {t("dataRights.identity.done", {
              date: formatDate(c.identityVerifiedOn) ?? "",
              method: t("dataRights.identity.method", { method: c.identityMethod }),
            })}
          </p>
        ) : open ? (
          <IdentityForm id={id} version={c.version} />
        ) : null}
      </Card>

      {open ? (
        <Card as="section" title={t("dataRights.pause.title")} headingLevel={2}>
          <div className="flex flex-col gap-6">
            <p className="m-0 max-w-prose">{t("dataRights.pause.intro")}</p>
            {c.pauses.length > 0 ? (
              <div>
                <h3 className="m-0 text-body font-semibold">{t("dataRights.pause.list")}</h3>
                <ul className="m-0 mt-1 ps-5">
                  {c.pauses.map((p) => (
                    <li key={p.from}>
                      {p.to
                        ? t("dataRights.pause.item", {
                            from: formatDate(p.from) ?? "",
                            to: formatDate(p.to) ?? "",
                          })
                        : t("dataRights.pause.itemOpen", { from: formatDate(p.from) ?? "" })}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <h3 className="m-0 text-body font-semibold">
              {t(paused ? "dataRights.pause.end" : "dataRights.pause.start")}
            </h3>
            <PauseForm id={id} version={c.version} paused={paused} />
            <h3 className="m-0 text-body font-semibold">{t("dataRights.extension.submit")}</h3>
            {c.extension ? (
              <p className="m-0">
                {t("dataRights.extension.done", {
                  months: c.extension.months,
                  date: formatDate(c.extension.decidedOn) ?? "",
                  grounds: t("dataRights.extension.groundsOption", {
                    grounds: c.extension.grounds,
                  }),
                  reason: c.extension.reason,
                })}
              </p>
            ) : (
              <ExtensionForm id={id} version={c.version} />
            )}
          </div>
        </Card>
      ) : null}

      <Card as="section" title={t("dataRights.collect.title")} headingLevel={2}>
        <div className="flex flex-col gap-4">
          <p className="m-0 max-w-prose">{t("dataRights.collect.intro")}</p>
          {c.notSearched.length > 0 ? (
            <Notice
              tone="warning"
              icon={<SearchX {...icon} />}
              title={t("dataRights.notSearched.title")}
            >
              <p className="m-0">
                {t("dataRights.notSearched.intro", { count: c.notSearched.length })}
              </p>
              <ul className="m-0 mt-2 flex flex-col gap-2 ps-5">
                {c.notSearched.map((n) => (
                  <li key={n.table}>
                    <span className="font-semibold">{partName(n.table)}</span>:{" "}
                    {t("dataRights.notSearched.reason", { reason: n.reason })} {n.guidance}
                  </li>
                ))}
              </ul>
            </Notice>
          ) : null}
          <p className="m-0">
            {c.collectedAt
              ? t("dataRights.collect.at", { dateTime: formatDateTime(c.collectedAt) ?? "" })
              : t("dataRights.collect.never")}
          </p>
          {open ? <CollectForm id={id} again={c.collectedAt !== null} /> : null}
        </div>
      </Card>

      {c.collectedAt ? (
        <Card as="section" title={t("dataRights.items.title")} headingLevel={2}>
          <div className="flex flex-col gap-4">
            <p className="m-0 max-w-prose">{t("dataRights.items.intro")}</p>
            <p className="m-0">
              {t("dataRights.items.counts", {
                total: c.items.total,
                pending: c.items.pending,
                disclosed: c.items.disclosed,
                withheld: c.items.withheld,
              })}
            </p>
            {listed.length === 0 ? (
              <p className="m-0">{t("dataRights.items.empty")}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-body-dense">
                  <caption className="hb-visually-hidden">{t("dataRights.items.title")}</caption>
                  <thead>
                    <tr className="border-b border-border text-start">
                      <th scope="col" className="py-2 pe-4 text-start">
                        {t("dataRights.items.part")}
                      </th>
                      <th scope="col" className="py-2 pe-4 text-start">
                        {t("dataRights.items.record")}
                      </th>
                      <th scope="col" className="py-2 pe-4 text-start">
                        {t("dataRights.items.decision")}
                      </th>
                      <th scope="col" className="py-2 text-start">
                        <span className="hb-visually-hidden">{t("dataRights.items.review")}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {listed.slice(0, SHOWN_ITEMS).map((item) => {
                      const chip = decisionChip(item.decision, t);
                      const part = partName(item.tableName);
                      const record = item.recordId.slice(0, 8);
                      return (
                        <tr key={item.id} className="border-b border-border align-top">
                          <td className="py-2 pe-4">{part}</td>
                          <td className="py-2 pe-4 font-mono">{record}</td>
                          <td className="py-2 pe-4">
                            <StatusChip status={chip.status} label={chip.label} />
                          </td>
                          <td className="py-2">
                            {open ? (
                              <Link
                                className="inline-flex min-h-target items-center underline"
                                href={itemPage(id, item.id)}
                                aria-label={t("dataRights.items.reviewLabel", { part, record })}
                              >
                                {t("dataRights.items.review")}
                              </Link>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {listed.length > SHOWN_ITEMS ? (
              <p className="m-0">
                {t("dataRights.items.more", { shown: SHOWN_ITEMS, total: listed.length })}
              </p>
            ) : null}
          </div>
        </Card>
      ) : null}

      {open ? (
        <Card as="section" title={t("dataRights.bundle.title")} headingLevel={2}>
          {blocker ? (
            <p className="m-0">
              {t("dataRights.bundle.notReady", { reason: blocker, pending: c.items.pending })}
            </p>
          ) : (
            <ButtonLink
              href={bundlePage(id)}
              icon={<FileSearch size={18} strokeWidth={1.5} aria-hidden />}
            >
              {t("dataRights.bundle.open")}
            </ButtonLink>
          )}
        </Card>
      ) : null}

      {c.requestKind === "portability" ? (
        <Card as="section" title={t("dataRights.portability.title")} headingLevel={2}>
          <p className="m-0 max-w-prose">
            {t(
              c.portability.applies
                ? "dataRights.portability.applies"
                : "dataRights.portability.notApplies",
            )}
          </p>
        </Card>
      ) : null}

      {c.requestKind === "erasure" ? (
        <Card as="section" title={t("dataRights.erasure.title")} headingLevel={2}>
          <div className="flex flex-col gap-4">
            <p className="m-0 max-w-prose">{t("dataRights.erasure.intro")}</p>
            {c.erasure ? (
              <>
                <p className="m-0">
                  {t("dataRights.erasure.result", {
                    dateTime: formatDateTime(c.erasure.assessedAt) ?? "",
                    erasable: c.erasure.erasable,
                    retained: c.erasure.retained,
                    held: c.erasure.held,
                  })}
                </p>
                <ul className="m-0 ps-5">
                  {c.erasure.byClass.map((row) => (
                    <li key={`${row.recordClass}-${row.outcome}`}>
                      {row.outcome === "retained" && row.until
                        ? t("dataRights.erasure.until", {
                            name: partName(row.recordClass),
                            count: row.count,
                            date: formatDate(row.until) ?? "",
                          })
                        : t("dataRights.erasure.class", {
                            name: partName(row.recordClass),
                            count: row.count,
                            outcome: row.outcome,
                          })}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {open && c.collectedAt ? <ErasureForm id={id} version={c.version} /> : null}
          </div>
        </Card>
      ) : null}

      {c.requestKind === "rectification" ? (
        <Card as="section" title={t("dataRights.rectification.title")} headingLevel={2}>
          <p className="m-0 max-w-prose">{t("dataRights.rectification.intro")}</p>
        </Card>
      ) : null}
    </DataRightsFrame>
  );
}
