import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import { DraftForm, GovernanceForm, PrepareDpia, SignDpia } from "@/components/dpia/DpiaForms";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { DPIA_PAGE, dpiaChip, dpiaShown, prefillOf } from "@/lib/dpia";
import { formatDateTime } from "@/lib/format";
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
  const done = firstParam((await searchParams).done);
  const open = dpia.open;
  const signingFor = open?.status === "prepared" && may("platform.dpia.sign") ? open : null;
  const draftPrefill = prefillOf((open ?? dpia.signed)?.prefill ?? {});

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader eyebrow={me.tenant.name} title={title} description={t("dpia.description")} />
      {done && DONE.has(done) ? (
        <RecordedArrival message={t("dpia.done", { done })} param="done" />
      ) : null}
      <Card as="section" title={t("dpia.status.title")} headingLevel={2}>
        <div className="flex flex-col gap-3">
          <p className="m-0">
            <SafetyChip chip={dpiaChip(dpia.state, t)} />
          </p>
          {dpia.signed?.signedAt ? (
            <p className="m-0 text-body-dense">
              {t("dpia.status.signed", {
                name: dpia.signed.signedBy?.displayName ?? "",
                dateTime: formatDateTime(dpia.signed.signedAt) ?? "",
              })}
            </p>
          ) : null}
          {dpia.reviewDueAt ? (
            <p className="m-0 text-body-dense">
              {t("dpia.status.reviewBy", {
                date: formatDateTime(dpia.reviewDueAt)?.split(" ")[0] ?? "",
              })}
            </p>
          ) : null}
          {dpia.triggers.length > 0 ? (
            <ul className="m-0 flex flex-col gap-1 ps-5">
              {dpia.triggers.map((trigger) => (
                <li key={trigger.kind}>{t("dpia.trigger", { kind: trigger.kind })}</li>
              ))}
            </ul>
          ) : null}
          {dpia.missingConfig.length > 0 ? (
            <div className="flex flex-col gap-1">
              <p className="m-0 font-semibold">{t("dpia.missing.title")}</p>
              <ul className="m-0 flex flex-col gap-1 ps-5">
                {dpia.missingConfig.map((key) => (
                  <li key={key}>{t("dpia.missing", { key: key.replace(".", "_") })}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </Card>
      {may("platform.tenant.manage") ? (
        <Card as="section" title={t("dpia.settings.title")} headingLevel={2}>
          <GovernanceForm settings={dpia.settings} members={leads} />
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
