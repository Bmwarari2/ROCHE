import { ButtonLink, Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { ThreadMessages } from "@/components/safety-silos/AnonymousSpeakUp";
import { RaiseSpeakUpForm, SpeakUpMessageForm } from "@/components/safety-silos/SpeakUpForms";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isFamilyMember } from "@/lib/family-feed";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { anonymousPagePath, isSpeakUpLead, speakUpShown, speakUpStateChip } from "@/lib/speak-up";

export const metadata: Metadata = { title: t("speakUp.title") };

/**
 * Speaking up (SAFE-012; ADR-0089): raising a named or confidential concern, the concerns the
 * member raised with their replies, and the address of the anonymous page to share. The lead and
 * case members open their cases from here.
 */
export default async function SpeakUpPage() {
  const { me, tenantId } = await getShellContext();
  const title = t("speakUp.title");
  if (!speakUpShown(me.permissions, isFamilyMember(me))) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/speak-up/mine", {});
  if (!data) return failWith(error, response, "/speak-up");
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        title={title}
        description={t("speakUp.description")}
        primaryAction={
          <ButtonLink href="/speak-up/cases" variant="secondary">
            {isSpeakUpLead(me.permissions)
              ? t("speakUp.cases.title")
              : t("speakUp.cases.memberTitle")}
          </ButtonLink>
        }
      />
      <Card as="section" headingLevel={2} title={t("speakUp.raiseTitle")}>
        <RaiseSpeakUpForm />
      </Card>
      <Card as="section" headingLevel={2} title={t("speakUp.anonymousTitle")}>
        <div className="flex flex-col gap-2">
          <p className="m-0">{t("speakUp.anonymousBody")}</p>
          <p className="m-0 break-all font-mono">{anonymousPagePath(tenantId)}</p>
        </div>
      </Card>
      <section className="flex flex-col gap-3" aria-labelledby="my-concerns">
        <h2 id="my-concerns" className="m-0 text-heading">
          {t("speakUp.mine.title")}
        </h2>
        {data.items.length === 0 ? (
          <p className="m-0">{t("speakUp.mine.empty")}</p>
        ) : (
          data.items.map((item) => (
            <Card
              key={item.id}
              as="article"
              headingLevel={3}
              title={t("speakUp.mine.itemTitle", {
                category: t("speakUp.category", { value: item.category }),
                date: formatDate(item.receivedOn) ?? "",
              })}
            >
              <div className="flex flex-col gap-3">
                <p className="m-0 flex flex-wrap gap-2">
                  <SafetyChip chip={speakUpStateChip(item.state, t)} />
                </p>
                <p className="m-0 text-body-dense">
                  {t("speakUp.identity", { value: item.identity })}
                </p>
                <p className="m-0 whitespace-pre-wrap">{item.summary}</p>
                {item.outcome ? (
                  <div className="flex flex-col gap-1">
                    <h4 className="m-0 text-body font-semibold">{t("speakUp.thread.outcome")}</h4>
                    <p className="m-0 whitespace-pre-wrap">{item.outcome}</p>
                  </div>
                ) : null}
                <ThreadMessages messages={item.messages} />
                {item.state !== "closed" ? <SpeakUpMessageForm id={item.id} mode="mine" /> : null}
              </div>
            </Card>
          ))
        )}
      </section>
    </div>
  );
}
