import { ButtonLink, Card, EmptyState, PageHeader } from "@harbour/ui";
import { Inbox, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Notice } from "@/components/care/Notice";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { caseReference, isSpeakUpLead, nextPageHref, speakUpStateChip } from "@/lib/speak-up";

export const metadata: Metadata = { title: t("speakUp.cases.title") };

/**
 * The Freedom to Speak Up lead's cases, and a member's cases they are named on (ADR-0089): newest
 * first, a page at a time, with "possible flood" in words for the lead when today's anonymous
 * concerns have reached the organisation's daily limit. Titled by category and date, never a name.
 */
export default async function SpeakUpCasesPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { cursor } = await searchParams;
  const { me } = await getShellContext();
  const lead = isSpeakUpLead(me.permissions);
  const title = lead ? t("speakUp.cases.title") : t("speakUp.cases.memberTitle");
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/speak-up/cases", {
    params: { query: cursor ? { cursor, limit: 50 } : { limit: 50 } },
  });
  if (!data) {
    const code = problemCode(error);
    if (code === "missing_permission" || code?.startsWith("mfa_")) {
      return <SafetyForbidden title={title} />;
    }
    return failWith(error, response, "/speak-up/cases");
  }
  const next = nextPageHref(data.nextCursor);
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader title={title} description={t("speakUp.cases.description")} />
      {data.possibleFlood ? (
        <Notice
          tone="warning"
          icon={<TriangleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
          title={t("speakUp.cases.flood", {
            count: data.possibleFlood.count,
            cap: data.possibleFlood.cap,
          })}
        />
      ) : null}
      {data.items.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<Inbox size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("speakUp.cases.empty")}
          />
        </Card>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {data.items.map((item) => (
            <li key={item.id}>
              <Card
                as="article"
                headingLevel={2}
                title={
                  <Link
                    href={`/speak-up/cases/${item.id}`}
                    className="inline-flex min-h-target items-center underline"
                  >
                    {t("speakUp.mine.itemTitle", {
                      category: t("speakUp.category", { value: item.category }),
                      date: formatDate(item.receivedOn) ?? "",
                      ref: caseReference(item.id),
                    })}
                  </Link>
                }
              >
                <p className="m-0 flex flex-wrap items-center gap-2">
                  <SafetyChip chip={speakUpStateChip(item.state, t)} />
                  <span className="text-body-dense">
                    {t("speakUp.identity", { value: item.identity })}
                  </span>
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {next || cursor ? (
        <nav aria-label={t("speakUp.cases.pages")} className="flex flex-wrap gap-3">
          {cursor ? (
            <ButtonLink href="/speak-up/cases" variant="secondary">
              {t("speakUp.cases.first")}
            </ButtonLink>
          ) : null}
          {next ? (
            <ButtonLink href={next} variant="secondary">
              {t("speakUp.cases.next")}
            </ButtonLink>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
