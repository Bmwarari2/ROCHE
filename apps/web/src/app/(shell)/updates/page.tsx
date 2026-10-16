import type { FamilyFeedList } from "@harbour/contracts";
import { buttonClassName, Card, PageHeader, StatusChip } from "@harbour/ui";
import { Undo2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { familyUpdatesShown, isFamilyMember } from "@/lib/family-feed";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: t("comms.feed.family.title") };
// Updates are read on every visit and never kept: the feed is online only (comms.md section 6).
export const dynamic = "force-dynamic";

const MFA_CODES = new Set(["mfa_enrolment_required", "mfa_verification_required"]);

/**
 * The family's updates (comms.md rules 1 to 5; COMMS-001; HZ-022, HZ-061), in a family member's
 * portal session. Only what the API returns is shown: the statement that these are not the full
 * care record, the updates a sharing decision opens, and a note where one they saw was taken
 * down. A feed closed by the person's status reads exactly like one with no decision, because the
 * API returns the same for both and this page adds nothing. The time it was checked is always
 * shown, so an empty feed is never read as "nothing has happened since" (HZ-061).
 */
export default async function FamilyUpdatesPage() {
  const { me } = await getShellContext();
  const title = t("comms.feed.family.title");
  const checkedAt = formatDateTime(new Date().toISOString()) ?? "";
  if (!familyUpdatesShown(me.permissions)) {
    // A family member whose link was revoked or not yet made is told so, never "no access".
    if (!isFamilyMember(me)) return <SafetyForbidden title={title} />;
    return (
      <div className="mx-auto flex w-full max-w-content flex-col gap-6">
        <PageHeader eyebrow={me.tenant.name} title={title} />
        <Card>
          <div className="flex flex-col gap-2">
            <p className="m-0">{t("comms.feed.family.noLink")}</p>
            <p className="m-0 text-body-dense text-text-secondary">
              {t("comms.feed.family.checkedAt", { when: checkedAt })}
            </p>
          </div>
        </Card>
      </div>
    );
  }
  const api = await tenantApi();
  const read = await api.GET("/v1/family/feed");
  const refusal = read.data ? null : problemCode(read.error);
  if (!read.data && !(refusal && MFA_CODES.has(refusal))) {
    failWith(read.error, read.response, "/updates");
  }
  const feeds: FamilyFeedList["items"] = read.data?.items ?? [];

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader eyebrow={me.tenant.name} title={title} />
      {refusal ? (
        <Card>
          <div className="flex flex-col gap-3">
            <p className="m-0">{t("comms.feed.family.mfa")}</p>
            <div>
              <Link href="/settings/security" className={buttonClassName({ variant: "primary" })}>
                {t("comms.feed.family.mfaLink")}
              </Link>
            </div>
          </div>
        </Card>
      ) : feeds.length === 0 ? (
        <Card>
          <div className="flex flex-col gap-2">
            <p className="m-0">{t("comms.feed.family.noLink")}</p>
            <p className="m-0 text-body-dense text-text-secondary">
              {t("comms.feed.family.checkedAt", { when: checkedAt })}
            </p>
          </div>
        </Card>
      ) : (
        feeds.map((feed, index) => (
          <Card
            key={feed.personId}
            as="section"
            headingLevel={2}
            title={
              feeds.length > 1
                ? t("comms.feed.family.feedTitleOf", { n: index + 1, of: feeds.length })
                : t("comms.feed.family.feedTitle")
            }
          >
            <div className="flex flex-col gap-4">
              <p className="m-0 max-w-prose font-semibold">{feed.statement}</p>
              <p className="m-0 text-body-dense text-text-secondary">
                {feed.lastUpdateAt
                  ? t("comms.feed.family.lastUpdate", {
                      when: formatDateTime(feed.lastUpdateAt) ?? "",
                      checked: checkedAt,
                    })
                  : t("comms.feed.family.checkedAt", { when: checkedAt })}
              </p>
              {feed.entries.length === 0 ? (
                <p className="m-0">{t("comms.feed.family.empty")}</p>
              ) : (
                <ol className="m-0 flex list-none flex-col gap-4 p-0">
                  {feed.entries.map((entry) => (
                    <li
                      key={entry.itemId}
                      className="flex flex-col gap-1 border-b border-border pb-4"
                    >
                      {entry.display === "withdrawn_notice" ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusChip
                            status="neutral"
                            icon={Undo2}
                            label={t("comms.feed.family.withdrawnChip")}
                          />
                          <span>{entry.text}</span>
                        </div>
                      ) : (
                        <p className="m-0 max-w-prose whitespace-pre-wrap break-words">
                          {entry.text}
                        </p>
                      )}
                      <p className="m-0 text-body-dense text-text-secondary">
                        {entry.addedLater
                          ? t("comms.feed.family.happenedAdded", {
                              kind: entry.kind,
                              happened: entry.happened,
                              added: entry.addedLater,
                            })
                          : t("comms.feed.family.happened", {
                              kind: entry.kind,
                              happened: entry.happened,
                            })}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </Card>
        ))
      )}
    </div>
  );
}
