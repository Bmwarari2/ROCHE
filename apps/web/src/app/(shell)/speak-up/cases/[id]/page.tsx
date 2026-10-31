import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { ThreadMessages } from "@/components/safety-silos/AnonymousSpeakUp";
import {
  SpeakUpMembersForm,
  SpeakUpMessageForm,
  SpeakUpStepForm,
} from "@/components/safety-silos/SpeakUpForms";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { isSpeakUpLead, speakUpStateChip } from "@/lib/speak-up";

export const metadata: Metadata = { title: t("speakUp.case.title") };

/**
 * One speak-up case (ADR-0089): what was raised, who raised it only where the reader may know,
 * the messages, and for the lead the next steps and the case's members. Nobody else reaches it.
 */
export default async function SpeakUpCasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const title = t("speakUp.case.title");
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/speak-up/cases/{id}", {
    params: { path: { id } },
  });
  if (!data) {
    const code = problemCode(error);
    if (code === "missing_permission" || code?.startsWith("mfa_")) {
      return <SafetyForbidden title={title} />;
    }
    if (response.status === 404) notFound();
    return failWith(error, response, `/speak-up/cases/${id}`);
  }
  const lead = isSpeakUpLead(me.permissions);
  const staff = lead
    ? ((await api.GET("/v1/speak-up/staff", {})).data?.items ?? []).filter((s) => s !== null)
    : [];
  const members = data.members.flatMap((m) => (m ? [m.id] : []));
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        title={t("speakUp.mine.itemTitle", {
          category: t("speakUp.category", { value: data.category }),
          date: formatDate(data.receivedOn) ?? "",
        })}
      />
      <p className="m-0 flex flex-wrap items-center gap-2">
        <SafetyChip chip={speakUpStateChip(data.state, t)} />
        <span>{t("speakUp.identity", { value: data.identity })}</span>
      </p>
      <Card as="section" headingLevel={2} title={t("speakUp.case.raised")}>
        <div className="flex flex-col gap-2">
          <p className="m-0 whitespace-pre-wrap">{data.summary}</p>
          <p className="m-0 text-body-dense">
            {data.reporter
              ? t("speakUp.case.reporter", { name: data.reporter.displayName })
              : t("speakUp.case.reporterHidden", { identity: data.identity })}
          </p>
          {!data.canReply ? (
            <p className="m-0 font-semibold">{t("speakUp.case.cannotReply")}</p>
          ) : null}
        </div>
      </Card>
      {data.outcome ? (
        <Card as="section" headingLevel={2} title={t("speakUp.thread.outcome")}>
          <p className="m-0 whitespace-pre-wrap">{data.outcome}</p>
        </Card>
      ) : null}
      <Card as="section" headingLevel={2} title={t("speakUp.case.messages")}>
        <div className="flex flex-col gap-4">
          <ThreadMessages messages={data.messages} />
          {data.canReply && data.state !== "closed" ? (
            <SpeakUpMessageForm id={data.id} mode="case" />
          ) : null}
        </div>
      </Card>
      {data.moves.map((to) => (
        <Card key={to} as="section" headingLevel={2} title={t("speakUp.step.title", { to })}>
          <SpeakUpStepForm id={data.id} version={data.version} to={to} />
        </Card>
      ))}
      {lead ? (
        <Card as="section" headingLevel={2} title={t("speakUp.members.title")}>
          <SpeakUpMembersForm id={data.id} staff={staff} members={members} />
        </Card>
      ) : null}
    </div>
  );
}
