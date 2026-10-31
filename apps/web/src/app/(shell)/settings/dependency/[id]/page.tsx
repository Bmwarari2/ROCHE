import type { DependencyScaleVersionItem } from "@harbour/contracts";
import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ApproveDraftButton,
  EditDraftForm,
  ReasonButton,
  StartDraftButton,
} from "@/components/dependency/DependencyForms";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import {
  DEPENDENCY_PAGE,
  dependencyScalePage,
  dependencyShown,
  mayManageScales,
  periodsWords,
  toDraft,
  versionChip,
} from "@/lib/dependency";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { firstParam } from "@/lib/record-metadata";
import { hoursWords } from "@/lib/rota";

export const metadata: Metadata = { title: t("dependency.scale.title") };

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const DONE = new Set(["created", "drafted", "saved", "approved", "discarded"]);

/** A version's definition, read only: periods, categories with minutes, skill minimums. */
function Definition({ version }: { readonly version: DependencyScaleVersionItem }) {
  const d = version.definition;
  const periodLabel = new Map(d.periods.map((p) => [p.key, p.label]));
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0">
        {t("dependency.view.periods", { count: d.periods.length, periods: periodsWords(d, t) })}
      </p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {d.categories.map((c) => (
          <li key={c.key} className="flex flex-col gap-1">
            <p className="m-0 font-semibold">{c.label}</p>
            {c.description ? <p className="m-0 text-body-dense">{c.description}</p> : null}
            <p className="m-0 text-body-dense">
              {c.careMinutes
                .map((m) =>
                  t("dependency.view.minutes", {
                    period: periodLabel.get(m.periodKey) ?? m.periodKey,
                    hours: hoursWords(m.minutes, t),
                  }),
                )
                .join("; ") || t("dependency.view.noMinutes")}
            </p>
          </li>
        ))}
      </ul>
      {d.skillMix.length > 0 ? (
        <ul className="m-0 flex flex-col gap-1 pl-5">
          {d.skillMix.map((s) => (
            <li key={`${s.skill}-${s.periodKey}`}>
              {t("dependency.view.skill", {
                skill: s.skill,
                period: periodLabel.get(s.periodKey) ?? s.periodKey,
                minimum: s.minimumStaff,
              })}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="m-0 text-body-dense">
        {d.reviewIntervalDays === null
          ? t("dependency.view.noReview")
          : t("dependency.view.review", { days: d.reviewIntervalDays })}
      </p>
    </div>
  );
}

/**
 * One dependency scale (scheduling.md section 12): the version in use, the open draft with its
 * problems (approved only by someone who neither wrote nor changed it, with none left), earlier
 * versions, and archiving with a reason.
 */
export default async function DependencyScalePage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { me } = await getShellContext();
  const title = t("dependency.scale.title");
  if (!dependencyShown(me.permissions)) return <SafetyForbidden title={title} />;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const api = await tenantApi();
  const [listed, versions] = await Promise.all([
    api.GET("/v1/dependency-scales"),
    api.GET("/v1/dependency-scales/{id}/versions", { params: { path: { id } } }),
  ]);
  if (!listed.data) failWith(listed.error, listed.response, dependencyScalePage(id));
  if (versions.response.status === 404) notFound();
  if (!versions.data) failWith(versions.error, versions.response, dependencyScalePage(id));
  const scale = listed.data.items.find((s) => s.id === id);
  if (!scale) notFound();
  const manage = mayManageScales(me.permissions) && !scale.archivedAt;
  const done = firstParam((await searchParams).done);
  const draft = scale.draft;
  const mine = draft
    ? draft.authorId === me.tenantUserId || draft.contributorIds.includes(me.tenantUserId)
    : false;

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader eyebrow={me.tenant.name} title={scale.name} description={listed.data.notice} />
      {done && DONE.has(done) ? (
        <RecordedArrival message={t("dependency.done", { done })} param="done" />
      ) : null}
      <p className="m-0">
        <Link href={DEPENDENCY_PAGE} className="inline-flex min-h-target items-center underline">
          {t("dependency.back")}
        </Link>
      </p>
      <Card as="section" title={t("dependency.scale.current")} headingLevel={2}>
        {scale.current ? (
          <div className="flex flex-col gap-3">
            <p className="m-0 flex flex-wrap items-center gap-2">
              <SafetyChip chip={versionChip("approved", t)} />
              <span>
                {t("dependency.scale.versionLine", {
                  n: scale.current.versionNumber,
                  at: formatDateTime(scale.current.approvedAt) ?? "",
                })}
              </span>
            </p>
            <Definition version={scale.current} />
          </div>
        ) : (
          <p className="m-0">{t("dependency.scale.noCurrent")}</p>
        )}
      </Card>
      {draft ? (
        <Card
          as="section"
          title={t("dependency.scale.draft", { n: draft.versionNumber })}
          headingLevel={2}
        >
          <div className="flex flex-col gap-4">
            {draft.issues.length > 0 ? (
              <div className="flex flex-col gap-1">
                <p className="m-0 font-semibold">
                  {t("dependency.scale.issues", { count: draft.issues.length })}
                </p>
                <ul className="m-0 flex flex-col gap-1 pl-5">
                  {draft.issues.map((issue) => (
                    <li key={`${issue.path}-${issue.problem}`}>{issue.message}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="m-0">{t("dependency.scale.noIssues")}</p>
            )}
            {manage ? (
              <EditDraftForm
                scaleId={scale.id}
                versionId={draft.id}
                version={draft.version}
                initial={toDraft(draft.definition)}
              />
            ) : (
              <Definition version={draft} />
            )}
            {manage ? (
              <div className="flex flex-wrap gap-3">
                {mine ? (
                  <p className="m-0 max-w-prose">{t("dependency.scale.notYours")}</p>
                ) : draft.issues.length === 0 ? (
                  <ApproveDraftButton
                    scaleId={scale.id}
                    versionId={draft.id}
                    version={draft.version}
                  />
                ) : null}
                <ReasonButton
                  kind="discard"
                  scaleId={scale.id}
                  versionId={draft.id}
                  version={draft.version}
                />
              </div>
            ) : null}
          </div>
        </Card>
      ) : manage ? (
        <Card as="section" title={t("dependency.scale.change")} headingLevel={2}>
          <div className="flex flex-col gap-3">
            <p className="m-0 max-w-prose">{t("dependency.scale.changeAbout")}</p>
            <StartDraftButton scaleId={scale.id} />
          </div>
        </Card>
      ) : null}
      <Card as="section" title={t("dependency.scale.versions")} headingLevel={2}>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {versions.data.items
            .flatMap((v) => (v ? [v] : []))
            .map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-2">
                <SafetyChip chip={versionChip(v.state, t)} />
                <span>{t("dependency.scale.versionN", { n: v.versionNumber })}</span>
                {v.discardReason ? (
                  <span className="text-body-dense">{v.discardReason}</span>
                ) : null}
              </li>
            ))}
        </ul>
      </Card>
      {manage ? (
        <Card as="section" title={t("dependency.scale.archiveTitle")} headingLevel={2}>
          <div className="flex flex-col gap-3">
            <p className="m-0 max-w-prose">{t("dependency.scale.archiveAbout")}</p>
            <ReasonButton kind="archive" scaleId={scale.id} version={scale.version} />
          </div>
        </Card>
      ) : null}
    </div>
  );
}
