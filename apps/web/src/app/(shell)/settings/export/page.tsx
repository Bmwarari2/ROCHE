import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { Archive } from "lucide-react";
import type { Metadata } from "next";
import { CancelExport, DownloadExport, RequestExport } from "@/components/exports/ExportActions";
import { PrintRefusal } from "@/components/operations/PrintRefusal";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import {
  downloadProblem,
  EXPORT_PAGE,
  exportChip,
  exportShown,
  exportStateOf,
  mayCancel,
  mayRequest,
  sizeWords,
} from "@/lib/exports";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { firstParam } from "@/lib/record-metadata";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: t("export.title") };

const DONE = new Set(["requested", "cancelled", "downloaded"]);

/**
 * The organisation's full export (PLAT-015; platform-completions.md rules 12 to 15; HZ-070), for
 * holders of `platform.export.create` (the owner): ask for one (free, one at a time), see where
 * each stands as an icon and a word and when its link expires, download it once after a warning
 * that it holds everyone's records, or cancel it. Every export route needs a fresh step-up, so
 * the page sends the person to confirm it is you first.
 */
export default async function ExportPage({
  searchParams,
}: {
  readonly searchParams: SearchParams;
}) {
  const { me } = await getShellContext();
  const title = t("export.title");
  if (!exportShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const listed = await api.GET("/v1/exports");
  if (!listed.data) failWith(listed.error, listed.response, EXPORT_PAGE);
  const items = listed.data.items;
  const query = await searchParams;
  const done = firstParam(query.done);
  const at = firstParam(query.at) ?? "";
  const problem = downloadProblem(firstParam(query.problem));
  const when = (iso: string | null) => formatDateTime(iso) ?? "";

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader eyebrow={me.tenant.name} title={title} description={t("export.description")} />
      {done && DONE.has(done) ? (
        <RecordedArrival message={t("export.done", { done })} param="done" />
      ) : null}
      {problem ? (
        <PrintRefusal
          key={`${problem}-${at}`}
          title={t("export.problem.title")}
          hint={t("export.problem", { problem })}
        />
      ) : null}
      <Card as="section" title={t("export.new.title")} headingLevel={2}>
        <div className="flex flex-col gap-3">
          <p className="m-0">{t("export.new.about")}</p>
          {mayRequest(items) ? <RequestExport /> : <p className="m-0">{t("export.new.inHand")}</p>}
        </div>
      </Card>
      <Card as="section" title={t("export.list.title")} headingLevel={2}>
        {items.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<Archive size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("export.list.empty")}
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {items.map((item) => {
              const state = exportStateOf(item);
              const size = sizeWords(item.bytes, t);
              return (
                <li key={item.id} className="flex flex-col gap-2 border-b border-border pb-3">
                  <h3 className="m-0 text-body font-semibold">
                    {t("export.item.title", {
                      kind: item.kind,
                      dateTime: when(item.requestedAt),
                    })}
                  </h3>
                  <p className="m-0 flex flex-wrap items-center gap-2">
                    <SafetyChip chip={exportChip(state, t)} />
                    {size ? <span className="text-body-dense">{size}</span> : null}
                  </p>
                  {item.requestedBy ? (
                    <p className="m-0 text-body-dense">
                      {t("export.item.by", { name: item.requestedBy.displayName })}
                    </p>
                  ) : null}
                  {state === "ready" && item.expiresAt ? (
                    <p className="m-0 text-body-dense">
                      {t("export.item.expires", { dateTime: when(item.expiresAt) })}
                    </p>
                  ) : null}
                  {state === "downloaded" ? (
                    <p className="m-0 text-body-dense">
                      {t("export.item.downloaded", { dateTime: when(item.downloadedAt) })}
                    </p>
                  ) : null}
                  {item.warnings.length > 0 ? (
                    <p className="m-0 text-body-dense">
                      {t("export.item.warnings", { count: item.warnings.length })}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    {item.mayDownload ? <DownloadExport id={item.id} /> : null}
                    {mayCancel(state) ? <CancelExport id={item.id} /> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
