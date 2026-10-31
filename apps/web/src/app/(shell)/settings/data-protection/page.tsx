import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import { DraftForm, GovernanceForm, PrepareDpia, SignDpia } from "@/components/dpia/DpiaForms";
import { DpiaStatus } from "@/components/dpia/DpiaStatus";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { NoticeVersionForm } from "@/components/staff/PrivacyForms";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { DPIA_PAGE, dpiaShown, maySign, prefillOf } from "@/lib/dpia";
import { t } from "@/lib/i18n";
import { firstParam } from "@/lib/record-metadata";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: t("dpia.title") };

const DONE = new Set(["settings", "saved", "prepared", "signed"]);

/**
 * The organisation's DPIA and data protection governance (PLAT-023; platform-completions.md rules
 * 17 to 22). Where it stands as an icon and a word, with what Harbour still needs and why a review
 * is due; the governance settings for platform.tenant.manage; the open version's answers for
 * platform.dpia.prepare; and the prepared version's signature for the named lead, with step-up.
 * Each form is offered only to those who may use it; the API checks everything again.
 */
export default async function DataProtectionPage({
  searchParams,
}: {
  readonly searchParams: SearchParams;
}) {
  const { me } = await getShellContext();
  const title = t("dpia.title");
  if (!dpiaShown(me.permissions)) return <SafetyForbidden title={title} />;
  const may = (p: string) => me.permissions.includes(p);
  const api = await tenantApi();
  const overview = await api.GET("/v1/dpia");
  if (!overview.data) failWith(overview.error, overview.response, DPIA_PAGE);
  const dpia = overview.data;
  const members = may("platform.tenant.manage") ? await api.GET("/v1/members") : null;
  const leads = (members?.data?.items ?? [])
    .filter((m) => m.state === "active")
    .map((m) => ({ id: m.id, name: m.displayName }));
  const notice = may("platform.tenant.manage") ? await api.GET("/v1/me/staff-privacy") : null;
  const done = firstParam((await searchParams).done);
  const open = dpia.open;
  const signingFor = maySign(open, dpia.settings.leadId, me.tenantUserId, me.permissions)
    ? open
    : null;
  const draftPrefill = prefillOf((open ?? dpia.signed)?.prefill ?? {});

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader eyebrow={me.tenant.name} title={title} description={t("dpia.description")} />
      {done && DONE.has(done) ? (
        <RecordedArrival message={t("dpia.done", { done })} param="done" />
      ) : null}
      <DpiaStatus dpia={dpia} />
      {may("platform.tenant.manage") ? (
        <Card as="section" title={t("dpia.settings.title")} headingLevel={2}>
          <GovernanceForm settings={dpia.settings} members={leads} />
        </Card>
      ) : null}
      {may("platform.tenant.manage") ? (
        <Card as="section" title={t("privacy.notice.settingTitle")} headingLevel={2}>
          <div className="flex flex-col gap-4">
            <p className="m-0">{t("privacy.notice.settingAbout")}</p>
            <NoticeVersionForm current={notice?.data?.currentNoticeVersion ?? null} />
          </div>
        </Card>
      ) : null}
      {signingFor?.versionSha256 ? (
        <Card as="section" title={t("dpia.sign.title")} headingLevel={2}>
          <SignDpia id={signingFor.id} sha256={signingFor.versionSha256} />
        </Card>
      ) : null}
      {may("platform.dpia.prepare") ? (
        <Card as="section" title={t("dpia.draft.title")} headingLevel={2}>
          <div className="flex flex-col gap-6">
            <p className="m-0">{t("dpia.draft.about", { status: open?.status ?? "none" })}</p>
            <DraftForm
              key={`${open?.id ?? "new"}-${open?.version ?? 0}`}
              prefill={draftPrefill}
              answers={open?.answers ?? {}}
              residualRisk={open?.residualRisk ?? {}}
              icoReference={open?.icoReference ?? null}
              version={open?.version}
            />
            {open?.status === "draft" ? <PrepareDpia version={open.version} /> : null}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
