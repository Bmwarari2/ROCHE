import type { PersonSummary } from "@harbour/contracts";
import { Card, EmptyState, PageHeader, StatusChip } from "@harbour/ui";
import { CircleAlert, Flower2, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Notice } from "@/components/care/Notice";
import { PersonNeeds } from "@/components/safety/PersonNeeds";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { deathStatusChip, deathsShown, reviewChip } from "@/lib/deaths";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { personNames } from "@/lib/people";

export const metadata: Metadata = { title: t("deaths.title") };

/**
 * Death records in the reader's scope, open first (SAFE-014): each titled by when the person
 * died, never by name, with the person's name and communication needs beside it, its status, the
 * mortality review against its due date and how many steps are still outstanding, in words.
 */
export default async function DeathsPage() {
  const { me } = await getShellContext();
  const title = t("deaths.title");
  if (!deathsShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/deaths", {});
  if (!data) {
    if (problemCode(error) === "missing_permission") return <SafetyForbidden title={title} />;
    return failWith(error, response, "/deaths");
  }
  const listed = await api.GET("/v1/people", {});
  const people = new Map((listed.data?.items ?? []).map((p) => [p.id, p as PersonSummary]));
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader eyebrow={me.tenant.name} title={title} description={t("deaths.description")} />
      {data.truncated ? (
        <Notice
          tone="warning"
          icon={<TriangleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
          title={t("deaths.truncated")}
        />
      ) : null}
      {data.items.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<Flower2 size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("deaths.empty")}
          />
        </Card>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {data.items.map((item) => {
            const person = people.get(item.personId);
            return (
              <li key={item.id}>
                <Card
                  as="article"
                  headingLevel={2}
                  className="break-words"
                  title={
                    <Link
                      href={`/deaths/${item.id}`}
                      className="inline-flex min-h-target items-center underline"
                    >
                      {t("deaths.itemTitle", { when: formatDateTime(item.diedAt) ?? "" })}
                    </Link>
                  }
                >
                  <div className="flex flex-col gap-2">
                    {person ? (
                      <>
                        <p className="m-0 font-semibold">{personNames(person).full}</p>
                        <PersonNeeds person={person} />
                      </>
                    ) : (
                      <p className="m-0">{t("deaths.personHidden")}</p>
                    )}
                    <p className="m-0 flex flex-wrap items-center gap-2">
                      <SafetyChip chip={deathStatusChip(item.status, t)} />
                      <SafetyChip
                        chip={reviewChip({ reviewedAt: null, overdue: item.reviewOverdue }, t)}
                      />
                      {item.outstanding > 0 ? (
                        <StatusChip
                          status="due"
                          icon={CircleAlert}
                          label={t("deaths.outstanding", { count: item.outstanding })}
                        />
                      ) : null}
                    </p>
                    <p className="m-0 text-body-dense text-text-secondary">
                      {t("deaths.reviewDue", { when: formatDateTime(item.reviewDueAt) ?? "" })}
                    </p>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
