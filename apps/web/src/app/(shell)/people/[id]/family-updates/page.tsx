import type { StaffFeedItem } from "@harbour/contracts";
import { Card, StatusChip } from "@harbour/ui";
import { Undo2 } from "lucide-react";
import type { Metadata } from "next";
import { NoAccess } from "@/components/care/NoAccess";
import { RecordFrame } from "@/components/care/RecordFrame";
import { FeedPublisher } from "@/components/comms/FeedPublisher";
import { FeedWithdraw } from "@/components/comms/FeedWithdraw";
import { TemplateArrival } from "@/components/comms/TemplateArrival";
import { getShellContext, problemCode, tenantApi } from "@/lib/api";
import { can, tabHref } from "@/lib/care-record";
import { FEED_PUBLISH, FEED_WITHDRAW, RECENT_DAYS, sourceOptions } from "@/lib/family-feed";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { getPerson } from "@/lib/person-record";
import { firstParam, recordMetadata } from "@/lib/record-metadata";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** The page title names the tab, never the person. */
export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("family-updates");
}

const MFA_CODES = new Set(["mfa_enrolment_required", "mfa_verification_required"]);

/**
 * The family updates tab (comms.md rules 6 to 12; COMMS-001; HZ-022, HZ-060, HZ-061): write an
 * update from one of the person's recent notes, activities or photos chosen for the feed, check
 * the preview, publish it, and take one down with a reason. Who in the family sees an update is
 * decided by the person's sharing decisions, not here. `comms.feed.publish` with MFA.
 */
async function FamilyUpdatesTab({
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
  const path = tabHref(id, "family-updates");
  if (!can(me.permissions, FEED_PUBLISH)) return <NoAccess />;
  const query = await searchParams;
  const done = firstParam(query.done);
  const at = firstParam(query.at) ?? "first";
  const now = new Date();
  const from = new Date(now.getTime() - RECENT_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const api = await tenantApi();
  const [published, notes, activities, photos] = await Promise.all([
    api.GET("/v1/people/{id}/feed", { params: { path: { id } } }),
    api.GET("/v1/people/{id}/notes", { params: { path: { id }, query: { from } } }),
    api.GET("/v1/people/{id}/activities", { params: { path: { id }, query: { from } } }),
    api.GET("/v1/documents", { params: { query: { personId: id, category: "feed_photo" } } }),
  ]);
  // The updates and the records hold care details: the API asks for MFA first.
  const refusal = published.data ? null : problemCode(published.error);
  const sources = sourceOptions(
    {
      notes: notes.data?.items ?? [],
      activities: activities.data?.items ?? [],
      photos: photos.data?.items ?? [],
    },
    now,
    (category) => t("care.notes.category", { category }),
  );
  const items: StaffFeedItem[] = [...(published.data?.items ?? [])].sort(
    (a, b) => Date.parse(b.composedAt) - Date.parse(a.composedAt),
  );
  const mayWithdraw = can(me.permissions, FEED_WITHDRAW);

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-eyebrow">{t("comms.feed.staff.title")}</h2>
        <p className="m-0 max-w-prose text-text-secondary">{t("comms.feed.staff.intro")}</p>
      </div>
      {done === "published" ? (
        <TemplateArrival key={at} message={t("comms.feed.staff.published")} />
      ) : done === "withdrawn" ? (
        <TemplateArrival key={at} message={t("comms.feed.staff.withdrawn")} />
      ) : null}
      <Card as="section" title={t("comms.feed.staff.writeTitle")} headingLevel={3}>
        {refusal && MFA_CODES.has(refusal) ? (
          <p className="m-0">{t("errors.mfaVerifyRequired")}</p>
        ) : (
          <FeedPublisher personId={id} path={path} sources={sources} />
        )}
      </Card>
      <Card as="section" title={t("comms.feed.staff.listTitle")} headingLevel={3}>
        {refusal ? (
          // Never "none published" when the list could not be read: that could lead to a repeat.
          <p className="m-0">
            {MFA_CODES.has(refusal)
              ? t("errors.mfaVerifyRequired")
              : t("comms.feed.staff.listUnavailable")}
          </p>
        ) : items.length === 0 ? (
          <p className="m-0">{t("comms.feed.staff.none")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-6 p-0">
            {items.map((item) => (
              <li key={item.id} className="flex flex-col gap-2 border-b border-border pb-4">
                <p className="m-0 text-body-dense text-text-secondary">
                  {t("comms.feed.staff.itemLine", {
                    kind: item.kind,
                    happened: formatDateTime(item.occurredAt) ?? "",
                    published: formatDateTime(item.composedAt) ?? "",
                    by: item.composedBy === me.tenantUserId ? "you" : "colleague",
                  })}
                </p>
                <p
                  className={`m-0 max-w-prose whitespace-pre-wrap break-words ${item.withdrawn ? "line-through" : ""}`}
                >
                  {item.text}
                </p>
                {item.withdrawn ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusChip
                      status="neutral"
                      icon={Undo2}
                      label={t("comms.feed.staff.withdrawnChip")}
                    />
                    <span className="text-body-dense">
                      {t("comms.feed.staff.withdrawnLine", {
                        reason: item.withdrawn.reason,
                        when: formatDateTime(item.withdrawn.at) ?? "",
                      })}
                    </span>
                  </div>
                ) : mayWithdraw ? (
                  <FeedWithdraw
                    personId={id}
                    itemId={item.id}
                    path={path}
                    label={item.text.slice(0, 60)}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

/** The tab inside the record's frame: the point-of-care header, read again on every tab. */
export default async function FamilyUpdatesPage(props: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="family-updates">
      <FamilyUpdatesTab {...props} />
    </RecordFrame>
  );
}
