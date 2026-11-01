import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ImportSteps, UndoImport } from "@/components/imports/ImportReview";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { IMPORT_PAGE, importChip, importPage, importShown, undoWords } from "@/lib/imports";
import { firstParam } from "@/lib/record-metadata";

export const metadata: Metadata = { title: t("import.batch.title") };

type Params = Promise<{ id: string }>;

/** What a step said on arriving back here (focus on the heading, the words in a status). */
const ARRIVALS = new Set(["uploaded", "committed", "undone", "discarded"]);
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * One import (PLAT-014; rules 21 to 26; HZ-130): while staged, check it (a dry run), acknowledge
 * the possible duplicates shown, accept that it cannot be undone when phones are in use, and
 * commit with a fresh step-up, or discard it; once committed, the allergy status checks it raised
 * and undo while the API says it is available, otherwise a plain statement that it is not.
 */
export default async function ImportBatchPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { me } = await getShellContext();
  const title = t("import.batch.title");
  if (!importShown(me.permissions)) return <SafetyForbidden title={title} />;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const api = await tenantApi();
  const got = await api.GET("/v1/imports/{id}", { params: { path: { id } } });
  if (got.response.status === 404) notFound();
  if (!got.data) failWith(got.error, got.response, importPage(id));
  const batch = got.data;
  const query = await searchParams;
  const done = firstParam(query.done);
  const when = (iso: string | null) => formatDateTime(iso) ?? "";
  const home = me.locations.find((l) => l.id === batch.locationId)?.name;
  const undo = undoWords(batch, t, when);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("import.batch.description", {
          rows: batch.rows,
          known: home ? "yes" : "no",
          home: home ?? "",
          dateTime: when(batch.uploadedAt),
        })}
      />
      {done && ARRIVALS.has(done) ? (
        <RecordedArrival message={t("import.done", { done })} param="done" />
      ) : null}
      <p className="m-0">
        <Link href={IMPORT_PAGE}>{t("import.batch.back")}</Link>
      </p>
      <Card as="section" title={t("import.batch.state")} headingLevel={2}>
        <div className="flex flex-col gap-2">
          <p className="m-0 flex flex-wrap items-center gap-2">
            <SafetyChip chip={importChip(batch.status, t)} />
          </p>
          {batch.status === "staged" ? (
            <p className="m-0 text-body-dense">
              {t("import.batch.expires", { dateTime: when(batch.expiresAt) })}
            </p>
          ) : null}
          {batch.committedAt ? (
            <p className="m-0 text-body-dense">
              {t("import.batch.committed", {
                records: batch.records ?? 0,
                dateTime: when(batch.committedAt),
              })}
            </p>
          ) : null}
          {undo ? <p className="m-0">{undo}</p> : null}
          {batch.status === "committed" && batch.undoAvailable ? (
            <UndoImport batch={batch} />
          ) : null}
        </div>
      </Card>
      <ImportSteps batch={batch} />
    </div>
  );
}
