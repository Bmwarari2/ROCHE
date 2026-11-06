import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { AcknowledgeNoticeForm, ImageConsentForm } from "@/components/staff/PrivacyForms";
import { StaffChip } from "@/components/staff/StaffChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { t } from "@/lib/i18n";
import { firstParam } from "@/lib/record-metadata";
import { consentChip, noticeLabel, PRIVACY_PAGE, privacyDone, privacyShown } from "@/lib/staff";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: t("privacy.title") };

/**
 * My privacy (WORK-011; workforce.md section 12): the organisation's staff privacy notice and
 * whether the member has acknowledged the version in force, and their decision on each optional
 * use of their photo or image. Consent is the basis only for these uses (B3a); no decision means
 * no use, and withdrawing is as easy as giving it.
 */
export default async function PrivacyPage({
  searchParams,
}: {
  readonly searchParams: SearchParams;
}) {
  const done = firstParam((await searchParams).done);
  const { me } = await getShellContext();
  const title = t("privacy.title");
  if (!privacyShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const got = await api.GET("/v1/me/staff-privacy");
  if (!got.data) failWith(got.error, got.response, PRIVACY_PAGE);
  const privacy = got.data;
  const version = privacy.currentNoticeVersion;
  // The notice in force is an organisation document (H-940), named by its title and version and
  // linked; an earlier label set before that is named as it was.
  const notice = privacy.notice;
  const label = notice ? noticeLabel(notice, t) : (version ?? "");

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader eyebrow={me.tenant.name} title={title} description={t("privacy.description")} />
      {done && privacyDone(done, t) ? (
        <RecordedArrival message={privacyDone(done, t) ?? ""} param="done" />
      ) : null}
      <Card as="section" title={t("privacy.notice.title")} headingLevel={2}>
        <div className="flex flex-col gap-3">
          {version === null ? (
            <p className="m-0">{t("privacy.notice.none")}</p>
          ) : (
            <>
              {notice ? (
                <p className="m-0">
                  <a href={`/documents/${notice.documentId}`}>
                    {t("privacy.notice.open", { notice: label })}
                  </a>
                </p>
              ) : null}
              {privacy.acknowledged ? (
                <p className="m-0">{t("privacy.notice.done", { notice: label })}</p>
              ) : (
                <>
                  <p className="m-0">
                    {t(notice ? "privacy.notice.ask" : "privacy.notice.askManager", {
                      notice: label,
                    })}
                  </p>
                  <AcknowledgeNoticeForm version={version} label={label} />
                </>
              )}
            </>
          )}
        </div>
      </Card>
      <Card as="section" title={t("privacy.image.title")} headingLevel={2}>
        <div className="flex flex-col gap-6">
          <p className="m-0">{t("privacy.image.about")}</p>
          {privacy.imageConsent.map((c) => (
            <section
              key={c.purpose}
              aria-labelledby={`purpose-${c.purpose}`}
              className="flex flex-col gap-2 border-b border-border pb-4"
            >
              <h3 id={`purpose-${c.purpose}`} className="m-0 text-body font-semibold">
                {t("privacy.image.heading", { purpose: c.purpose })}
              </h3>
              <p className="m-0">
                <StaffChip chip={consentChip(c.decision, t)} />
              </p>
              <ImageConsentForm purpose={c.purpose} decision={c.decision} />
            </section>
          ))}
        </div>
      </Card>
    </div>
  );
}
