import type { DowntimePackOut } from "@harbour/contracts";
import { buttonClassName, Card, PageHeader } from "@harbour/ui";
import { FileDown, RefreshCw, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Notice } from "@/components/care/Notice";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { downtimeAccess, packFreshnessChip } from "@/lib/downtime";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";

type Params = Promise<{ locationId: string }>;

export const metadata: Metadata = { title: t("operations.pack.title") };

const iconProps = { size: 20, strokeWidth: 1.5, "aria-hidden": true } as const;

/**
 * The location's downtime pack as it stands now (operations.md section 13; HZ-021): whether it is
 * in date, in an icon and words, the header lines every printed page carries, and when it was
 * made. Opening it needs a fresh sign-in and counts towards the hourly limit, so it is read only
 * on this page, never prefetched. The people's pages are read on paper: the page names no one,
 * so it says how many pages and warnings the printed pack has.
 */
export default async function DowntimePackPage({ params }: { readonly params: Params }) {
  const { locationId } = await params;
  if (!isUuid(locationId)) notFound();
  const { me } = await getShellContext();
  const title = t("operations.pack.title");
  const access = downtimeAccess(me, locationId);
  if (!access) notFound();
  if (!access.pack) return <SafetyForbidden title={title} />;
  const location = me.locations.find((l) => l.id === locationId);
  const page = `/downtime/${locationId}`;

  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/locations/{id}/downtime-pack", {
    params: { path: { id: locationId }, query: { format: "json" } },
  });
  // The route also prints a PDF; asked for JSON, it answers with the pack's object.
  const pack: DowntimePackOut | undefined = typeof data === "object" ? data : undefined;
  const code = problemCode(error);
  if (code === "not_found") notFound();
  if (code === "missing_permission") return <SafetyForbidden title={title} />;

  const breadcrumb = (
    <nav aria-label={t("common.breadcrumb")} className="text-body-dense">
      <Link href={page} className="underline">
        {t("operations.downtime.title")}
      </Link>
      <span aria-hidden="true" className="px-2 text-text-secondary">
        ›
      </span>
      <span>{title}</span>
    </nav>
  );

  if (!pack) {
    // Over the hourly limit, or no pack could be built: say so and what to use instead.
    if (response.status !== 429 && response.status !== 503) {
      failWith(error, response, `${page}/pack`);
    }
    const problem = response.status === 429 ? "limited" : "unavailable";
    return (
      <div className="mx-auto flex w-full max-w-content flex-col gap-6">
        {breadcrumb}
        <PageHeader eyebrow={location?.name ?? me.tenant.name} title={title} />
        <div role="alert">
          <Notice
            tone="warning"
            icon={<TriangleAlert {...iconProps} />}
            title={t("operations.pack.printProblem", { problem })}
          >
            {t("operations.pack.printProblemHint", { problem })}
          </Notice>
        </div>
      </div>
    );
  }

  const chip = packFreshnessChip(pack.freshness.state, t);
  const calm = pack.freshness.state === "current" && !pack.rebuildFailed;
  const rows: readonly (readonly [string, string, string])[] = [
    ["generatedAt", formatDateTime(pack.generatedAt) ?? "", pack.generatedAt],
    ["asAt", formatDateTime(pack.asAt) ?? "", pack.asAt],
    ["validUntil", formatDateTime(pack.validUntil) ?? "", pack.validUntil],
  ];

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      {breadcrumb}
      <PageHeader eyebrow={location?.name ?? me.tenant.name} title={title} />
      <p className="m-0 flex flex-wrap items-center gap-2">
        <SafetyChip chip={chip} />
      </p>
      <Notice
        tone={calm ? "info" : "warning"}
        icon={calm ? <RefreshCw {...iconProps} /> : <TriangleAlert {...iconProps} />}
        title={pack.freshness.notice}
      >
        {pack.rebuildFailed ? t("operations.pack.rebuildFailed") : null}
      </Notice>
      <Card as="section" title={t("operations.pack.headerTitle")} headingLevel={2}>
        <ul className="m-0 flex flex-col gap-1 ps-5">
          {pack.header.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the lines are fixed for this render and may repeat.
            <li key={index} className="break-words">
              {line}
            </li>
          ))}
        </ul>
      </Card>
      <Card as="section" title={t("operations.pack.aboutTitle")} headingLevel={2}>
        <div className="flex flex-col gap-3">
          <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-3">
            {rows.map(([field, value, iso]) => (
              <div key={field}>
                <dt className="text-body-dense font-semibold">
                  {t("operations.pack.field", { field })}
                </dt>
                <dd className="m-0">
                  <time dateTime={iso}>{value}</time>
                </dd>
              </div>
            ))}
          </dl>
          <p className="m-0">
            {t("operations.pack.contents", {
              pages: pack.pages.length,
              warnings: pack.warnings.length,
            })}
          </p>
          {pack.built ? (
            <p className="m-0 text-body-dense text-text-secondary">{t("operations.pack.built")}</p>
          ) : null}
          <div>
            <a href={`${page}/pack/print`} className={buttonClassName({ variant: "primary" })}>
              <FileDown size={18} strokeWidth={1.5} aria-hidden="true" />
              {t("operations.pack.print")}
            </a>
          </div>
        </div>
      </Card>
    </div>
  );
}
