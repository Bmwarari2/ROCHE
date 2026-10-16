import { buttonClassName, Card, EmptyState, PageHeader, StatusChip } from "@harbour/ui";
import { CircleCheck, Clock, FileDown, FileText } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DeclareOutageForm } from "@/components/operations/DeclareOutageForm";
import { PrintRefusal } from "@/components/operations/PrintRefusal";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import {
  downtimeAccess,
  outageStateChip,
  outageTitle,
  outageWindow,
  printProblem,
  printProblemWords,
} from "@/lib/downtime";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { firstParam } from "@/lib/record-metadata";

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: t("operations.downtime.title") };

/**
 * A location's downtime page (OPS-028; hazards HZ-017 and HZ-021): the downtime pack, opened or
 * printed with a fresh sign-in (a whole-home record) and never stored by the web app, and the
 * location's outages with where each stands. Declaring an outage is offered only to holders of
 * `operations.downtime.manage` who work here, and only while none is open (outages never overlap).
 */
export default async function DowntimePage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { locationId } = await params;
  if (!isUuid(locationId)) notFound();
  const { me } = await getShellContext();
  const title = t("operations.downtime.title");
  const access = downtimeAccess(me, locationId);
  if (!access) notFound();
  if (!access.pack && !access.manage) return <SafetyForbidden title={title} />;
  const location = me.locations.find((l) => l.id === locationId);
  const query = await searchParams;
  const print = printProblem(firstParam(query.print));
  const hintId = `pack-hint-${locationId}`;

  const api = await tenantApi();
  const listed = access.outages
    ? await api.GET("/v1/locations/{id}/outages", { params: { path: { id: locationId } } })
    : null;
  if (listed && !listed.data) failWith(listed.error, listed.response, `/downtime/${locationId}`);
  const outages = listed?.data?.items ?? [];
  const open = outages.find((o) => o.state === "declared") ?? null;

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={location?.name ?? me.tenant.name}
        title={title}
        description={t("operations.downtime.description")}
      />
      {print ? (
        <PrintRefusal {...printProblemWords(print, firstParam(query.from) ?? null, t)} />
      ) : null}
      {access.pack ? (
        <Card as="section" title={t("operations.pack.title")} headingLevel={2}>
          <div className="flex flex-col gap-3">
            <p className="m-0">{t("operations.pack.about")}</p>
            <p id={hintId} className="m-0 text-body-dense text-text-secondary">
              {t("operations.pack.stepUpHint")}
            </p>
            <p className="m-0 text-body-dense">{t("operations.pack.printedFreshness")}</p>
            <div className="flex flex-wrap gap-2">
              <Link
                href={`/downtime/${locationId}/pack`}
                prefetch={false}
                aria-describedby={hintId}
                className={buttonClassName({ variant: "primary" })}
              >
                <FileText size={18} strokeWidth={1.5} aria-hidden="true" />
                {t("operations.pack.open")}
              </Link>
              {/* A native link: the browser downloads the PDF; nothing is kept by the web app. */}
              <a
                href={`/downtime/${locationId}/pack/print`}
                aria-describedby={hintId}
                className={buttonClassName({ variant: "secondary" })}
              >
                <FileDown size={18} strokeWidth={1.5} aria-hidden="true" />
                {t("operations.pack.print")}
              </a>
            </div>
          </div>
        </Card>
      ) : null}
      {access.outages ? (
        <Card as="section" title={t("operations.outages.title")} headingLevel={2}>
          {outages.length === 0 ? (
            <EmptyState
              headingLevel={3}
              icon={<CircleCheck size={32} strokeWidth={1.5} aria-hidden="true" />}
              title={t("operations.outages.empty")}
            />
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {outages.map((item) => (
                <li key={item.id}>
                  <article
                    aria-labelledby={`outage-${item.id}`}
                    className="flex flex-col gap-1 border-b border-border pb-3"
                  >
                    <h3 id={`outage-${item.id}`} className="m-0 text-body font-semibold">
                      <Link
                        href={`/downtime/${locationId}/outages/${item.id}`}
                        className="inline-flex min-h-target items-center underline"
                      >
                        {outageTitle(item, t)}
                      </Link>
                    </h3>
                    <p className="m-0 flex flex-wrap items-center gap-2">
                      <SafetyChip chip={outageStateChip(item.state, t)} />
                      {item.declaredLate ? (
                        <StatusChip
                          status="due"
                          label={t("operations.outage.declaredLate")}
                          icon={Clock}
                        />
                      ) : null}
                    </p>
                    <p className="m-0 text-body-dense">{outageWindow(item, t)}</p>
                    {item.state === "closed" && item.backEntryDueAt ? (
                      <p className="m-0 text-body-dense">
                        {t("operations.outage.backEntryDue", {
                          dateTime: formatDateTime(item.backEntryDueAt) ?? "",
                        })}
                      </p>
                    ) : null}
                  </article>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}
      {access.manage ? (
        <Card as="section" title={t("operations.outage.form.title")} headingLevel={2}>
          {open ? (
            <p className="m-0">
              {t("operations.outage.form.oneOpen")}{" "}
              <Link
                href={`/downtime/${locationId}/outages/${open.id}`}
                className="inline-flex min-h-target items-center underline"
              >
                {outageTitle(open, t)}
              </Link>
            </p>
          ) : (
            <DeclareOutageForm locationId={locationId} />
          )}
        </Card>
      ) : null}
    </div>
  );
}
