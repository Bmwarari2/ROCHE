import { ButtonLink, Card, EmptyState, PageHeader } from "@harbour/ui";
import { MessageSquare } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { complaintStateChip, complaintsShown, complaintTargets } from "@/lib/complaints";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: t("complaints.title") };

/**
 * Complaints at the homes where the reader manages them, newest first (Phase 2 slice 62;
 * SAFE-011; Regulation 16): each with its state in an icon and a word and the targets still
 * ahead. Titled by when it arrived, never by the complainant's name.
 */
export default async function ComplaintsPage() {
  const { me, locationId } = await getShellContext();
  const title = t("complaints.title");
  if (!complaintsShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/complaints", {
    params: { query: locationId ? { locationId } : {} },
  });
  if (!data) {
    if (problemCode(error) === "missing_permission") return <SafetyForbidden title={title} />;
    return failWith(error, response, "/complaints");
  }
  const location = me.locations.find((l) => l.id === locationId);
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={location ? location.name : me.tenant.name}
        title={title}
        description={t("complaints.description")}
        primaryAction={<ButtonLink href="/complaints/new">{t("complaints.new")}</ButtonLink>}
        secondaryActions={
          <ButtonLink href="/complaints/compliments" variant="secondary">
            {t("complaints.compliment.title")}
          </ButtonLink>
        }
      />
      {data.items.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<MessageSquare size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("complaints.empty")}
          />
        </Card>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {data.items.map((item) => (
            <li key={item.id}>
              <Card
                as="article"
                headingLevel={2}
                className="break-words"
                title={
                  <Link
                    href={`/complaints/${item.id}`}
                    className="inline-flex min-h-target items-center underline"
                  >
                    {t("complaints.itemTitle", { when: formatDateTime(item.receivedAt) ?? "" })}
                  </Link>
                }
              >
                <div className="flex flex-col gap-2">
                  <p className="m-0 flex flex-wrap items-center gap-2">
                    <SafetyChip chip={complaintStateChip(item.state, t)} />
                  </p>
                  {complaintTargets(item, t).map((line) => (
                    <p key={line} className="m-0 text-body-dense text-text-secondary">
                      {line}
                    </p>
                  ))}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
