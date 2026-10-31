import type { LetterTemplateVersionItem } from "@harbour/contracts";
import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DraftPanel } from "@/components/comms/DraftPanel";
import { MergeFieldHelp } from "@/components/comms/MergeFieldHelp";
import { EndVersion, StartDraft } from "@/components/comms/TemplateActions";
import { TemplateArrival } from "@/components/comms/TemplateArrival";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  mergeFieldNames,
  templateActions,
  templateName,
  templatesNavShown,
  versionChip,
} from "@/lib/letters";
import { firstParam } from "@/lib/record-metadata";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: t("comms.templates.templateTitle") };

const DONE = new Set(["drafted", "saved", "approved", "retired", "discarded", "started"]);

/** A version's words as they are stored: merge fields shown as typed, never filled in. */
function VersionText({ version }: { readonly version: LetterTemplateVersionItem }) {
  return (
    <div className="flex flex-col gap-2">
      {version.issues.length > 0 ? (
        <ul className="m-0 flex flex-col gap-1 ps-5">
          {version.issues.map((issue) => (
            <li key={`${issue.problem}:${issue.message}`}>
              {t("comms.templates.problemAt", { message: issue.message })}
            </li>
          ))}
        </ul>
      ) : null}
      {version.subject ? (
        <p className="m-0">
          <span className="font-semibold">{t("comms.templates.form.subject")}: </span>
          {version.subject}
        </p>
      ) : null}
      <pre className="m-0 max-w-prose whitespace-pre-wrap break-words font-sans">
        {version.body}
      </pre>
      {version.personalDataFields.length > 0 ? (
        <p className="m-0 text-body-dense">
          {t("comms.templates.personalFields", {
            fields: mergeFieldNames(version.personalDataFields),
          })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * One template (comms.md rules 18 to 23; HZ-051): the version in use, the draft with each problem
 * the API found shown at its field, and the actions the viewer may take: edit or discard the
 * draft, approve it (never its author or an editor, who are told why), retire the version in use,
 * or start a new draft. Earlier versions are listed with their reasons.
 */
export default async function TemplatePage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  if (!templatesNavShown(me.permissions)) {
    return <SafetyForbidden title={t("comms.templates.title")} />;
  }
  const path = `/letters/${id}`;
  const query = await searchParams;
  const done = firstParam(query.done);
  const at = firstParam(query.at) ?? "first";
  const api = await tenantApi();
  const [listed, versions] = await Promise.all([
    api.GET("/v1/letter-templates"),
    api.GET("/v1/letter-templates/{id}/versions", { params: { path: { id } } }),
  ]);
  if (!listed.data) failWith(listed.error, listed.response, path);
  const template = listed.data.items.find((item) => item.id === id);
  if (!template) notFound();
  if (!versions.data) failWith(versions.error, versions.response, path);
  const actions = templateActions(template, me.permissions, me.tenantUserId);
  const { current, draft } = template;
  const earlier = versions.data.items.filter(
    (v): v is LetterTemplateVersionItem => v !== null && v.id !== current?.id && v.id !== draft?.id,
  );

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <nav aria-label={t("common.breadcrumb")} className="text-body-dense">
        <Link href="/letters" className="inline-flex min-h-target items-center underline">
          {t("comms.templates.title")}
        </Link>
      </nav>
      <PageHeader
        eyebrow={t("comms.templates.summary", { kind: template.kind, channel: template.channel })}
        title={templateName(template, t)}
      />
      {done && DONE.has(done) ? (
        <TemplateArrival key={at} message={t("comms.templates.arrived", { done })} />
      ) : null}

      {draft ? (
        <Card as="section" title={t("comms.templates.draftTitle")} headingLevel={2}>
          <div className="flex flex-col gap-4">
            <p className="m-0 flex flex-wrap gap-2">
              <SafetyChip chip={versionChip("draft", t)} />
            </p>
            <p className="m-0 text-body-dense">
              {draft.issues.length === 0
                ? t("comms.templates.noProblems")
                : t("comms.templates.problems", { count: draft.issues.length })}
            </p>
            <DraftPanel
              path={path}
              target={{ templateId: id, versionId: draft.id, version: draft.version }}
              channel={template.channel}
              words={{ name: draft.name, subject: draft.subject, body: draft.body }}
              issues={draft.issues}
              canEdit={actions.edit}
              canApprove={actions.approve}
              readOnly={<VersionText version={draft} />}
            />
            {draft.styleWarnings.length > 0 ? (
              <section aria-labelledby="style-title" className="flex flex-col gap-1">
                <h3 id="style-title" className="m-0 text-body font-semibold">
                  {t("comms.templates.styleTitle")}
                </h3>
                <ul className="m-0 ps-5">
                  {draft.styleWarnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </section>
            ) : null}
            {actions.ownDraft ? (
              <p className="m-0 max-w-prose">{t("comms.templates.refusal.ownDraft")}</p>
            ) : null}
            {actions.discard ? (
              <EndVersion
                how="discard"
                path={path}
                target={{ templateId: id, versionId: draft.id, version: draft.version }}
              />
            ) : null}
          </div>
        </Card>
      ) : null}

      <Card as="section" title={t("comms.templates.currentTitle")} headingLevel={2}>
        {current ? (
          <div className="flex flex-col gap-4">
            <p className="m-0 flex flex-wrap items-center gap-2">
              <SafetyChip chip={versionChip("approved", t)} />
              <span className="text-body-dense">
                {t("comms.templates.versionLine", {
                  number: current.versionNumber,
                  when: formatDateTime(current.approvedAt) ?? "",
                })}
              </span>
            </p>
            <VersionText version={current} />
            {actions.startDraft ? <StartDraft templateId={id} path={path} /> : null}
            {actions.retire ? (
              <EndVersion
                how="retire"
                path={path}
                target={{ templateId: id, versionId: current.id, version: current.version }}
              />
            ) : null}
          </div>
        ) : (
          <p className="m-0">{t("comms.templates.notInUseBody")}</p>
        )}
      </Card>

      {earlier.length > 0 ? (
        <Card as="section" title={t("comms.templates.earlierTitle")} headingLevel={2}>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {earlier.map((version) => (
              <li key={version.id} className="flex flex-col gap-1">
                <p className="m-0 flex flex-wrap items-center gap-2">
                  <SafetyChip chip={versionChip(version.state, t)} />
                  <span>
                    {t("comms.templates.versionNumber", { number: version.versionNumber })}
                  </span>
                </p>
                {version.retirementReason || version.discardReason ? (
                  <p className="m-0 text-body-dense">
                    {t("comms.templates.endedBecause", {
                      reason: version.retirementReason ?? version.discardReason ?? "",
                    })}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {actions.edit ? <MergeFieldHelp /> : null}
    </div>
  );
}
