import { Card, EmptyState } from "@harbour/ui";
import { ClipboardList, PenLine } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { NoAccess } from "@/components/care/NoAccess";
import { RecordFrame } from "@/components/care/RecordFrame";
import { recordWords } from "@/components/medicines/ConflictRecords";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { correctHref, entryUnit } from "@/lib/administration-corrections";
import { getShellContext, tenantApi } from "@/lib/api";
import { tabHref } from "@/lib/care-record";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { medicinesRoundShown } from "@/lib/medicine-round";
import { medicinesHref } from "@/lib/medicines";
import { getPerson, readOrFail } from "@/lib/person-record";
import { firstParam, recordMetadata } from "@/lib/record-metadata";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("medicines", t("medicines.administrations.title"));
}

/** The records shown: the last seven days, which the API reads in one period. */
const DAYS = 7;

/**
 * A person's administration records for the last seven days, newest first (HZ-004; medicines.md
 * 14.4): each corrected record struck through beside the record that replaced it, and the way to
 * correct a record still in force. The API decides who may correct (its author, or someone who
 * manages the medicines record) and what a controlled drug's correction needs.
 */
async function Administrations({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await params;
  const { person } = await getPerson(id);
  if (!person) return null;
  const { me } = await getShellContext();
  if (!medicinesRoundShown(me.permissions)) return <NoAccess />;
  const api = await tenantApi();
  const to = new Date();
  const from = new Date(to.getTime() - DAYS * 86_400_000);
  const [read, record] = await Promise.all([
    api.GET("/v1/people/{id}/medicine-administrations", {
      params: { path: { id }, query: { from: from.toISOString(), to: to.toISOString() } },
    }),
    api.GET("/v1/people/{id}/medicines", { params: { path: { id } } }),
  ]);
  const data = readOrFail(read, tabHref(id, "medicines"));
  if (!data) return <NoAccess />;
  const entries = new Map((record.data?.entries ?? []).map((e) => [e.id, e] as const));
  const rows = [...data.administrations].reverse();
  const query = await searchParams;
  return (
    <>
      {firstParam(query.done) === "corrected" ? (
        <RecordedArrival message={t("medicines.correct.done")} param="done" />
      ) : null}
      <Card as="section" title={t("medicines.administrations.title")} headingLevel={2}>
        <div className="flex flex-col gap-3">
          <p className="m-0 max-w-prose">{t("medicines.administrations.intro", { days: DAYS })}</p>
          {rows.length === 0 ? (
            <EmptyState
              icon={<ClipboardList size={20} strokeWidth={1.5} aria-hidden="true" />}
              title={t("medicines.administrations.none")}
            />
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {rows.map((r) => {
                const entry = entries.get(r.entryId);
                const words = recordWords(r, entry ? (entryUnit(entry)?.name ?? null) : null);
                const product = entry?.product.name ?? t("medicines.conflicts.someMedicine");
                return (
                  <li key={r.id} className="flex flex-col gap-1 border-b border-border py-2">
                    <p className="m-0 font-semibold">{product}</p>
                    {r.supersededById ? (
                      <p className="m-0">
                        <del>{words}</del>{" "}
                        <span>
                          {t("medicines.administrations.corrected", {
                            at:
                              formatDateTime(
                                rows.find((x) => x.id === r.supersededById)?.recorded.at ?? null,
                              ) ?? "none",
                          })}
                        </span>
                      </p>
                    ) : (
                      <p className="m-0">{words}</p>
                    )}
                    {r.correctionReason ? (
                      <p className="m-0">
                        {t("medicines.conflicts.correctedBecause", { reason: r.correctionReason })}
                      </p>
                    ) : null}
                    {r.supersededById === null ? (
                      <p className="m-0">
                        <Link
                          href={correctHref(id, r.id)}
                          className="inline-flex min-h-target items-center gap-2 underline"
                        >
                          <PenLine size={18} strokeWidth={1.5} aria-hidden="true" />
                          {t("medicines.administrations.correct", {
                            product,
                            at: formatDateTime(r.givenAt) ?? "none",
                          })}
                        </Link>
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Card>
      <p className="m-0">
        <Link href={medicinesHref(id)} className="inline-flex min-h-target items-center underline">
          {t("medicines.administrations.back")}
        </Link>
      </p>
    </>
  );
}

export default async function AdministrationsPage(props: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="medicines">
      <Administrations {...props} />
    </RecordFrame>
  );
}
