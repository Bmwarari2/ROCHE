import type { PersonSummary } from "@harbour/contracts";
import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { Search, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Notice } from "@/components/care/Notice";
import { PersonNeeds } from "@/components/safety/PersonNeeds";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { missingShown, missingStatusChip, policeCallChip, policeCallState } from "@/lib/missing";
import { personNames } from "@/lib/people";

export const metadata: Metadata = { title: t("missing.title") };

/**
 * Missing person episodes in scope, still missing first (SAFE-015; HZ-127): each with who it is,
 * their communication needs, where it stands, and the police call target first, in words.
 * Episodes are opened from their missing person incident.
 */
export default async function MissingPage() {
  const { me } = await getShellContext();
  const title = t("missing.title");
  if (!missingShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/missing-episodes", {});
  if (!data) {
    if (problemCode(error) === "missing_permission") return <SafetyForbidden title={title} />;
    return failWith(error, response, "/missing");
  }
  const listed = await api.GET("/v1/people", {});
  const people = new Map((listed.data?.items ?? []).map((p) => [p.id, p as PersonSummary]));
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader title={title} description={t("missing.description")} />
      {data.truncated ? (
        <Notice
          tone="warning"
          icon={<TriangleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
          title={t("missing.truncated")}
        />
      ) : null}
      {data.items.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<Search size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("missing.empty")}
            description={t("missing.emptyHint")}
          />
        </Card>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {data.items.map((item) => {
            const person = people.get(item.personId);
            const state = policeCallState(item);
            return (
              <li key={item.id}>
                <Card
                  as="article"
                  headingLevel={2}
                  className="break-words"
                  title={
                    <Link
                      href={`/missing/${item.id}`}
                      className="inline-flex min-h-target items-center underline"
                    >
                      {person
                        ? t("missing.itemTitle", { name: personNames(person).full })
                        : t("missing.itemTitleHidden")}
                    </Link>
                  }
                >
                  <div className="flex flex-col gap-2">
                    <p className="m-0 flex flex-wrap items-center gap-2">
                      <SafetyChip
                        chip={policeCallChip(state, formatDateTime(item.policeCallDueAt) ?? "", t)}
                      />
                      <SafetyChip chip={missingStatusChip(item.status, t)} />
                    </p>
                    {item.noticedMissingAt ? (
                      <p className="m-0 text-body-dense">
                        {t("missing.noticedAt", {
                          when: formatDateTime(item.noticedMissingAt) ?? "",
                        })}
                      </p>
                    ) : null}
                    {person ? <PersonNeeds person={person} /> : null}
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
