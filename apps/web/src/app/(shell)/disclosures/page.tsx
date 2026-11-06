import type { PersonSummary } from "@harbour/contracts";
import { ButtonLink, Card, EmptyState, PageHeader } from "@harbour/ui";
import { FileLock2, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Notice } from "@/components/care/Notice";
import { PersonNeeds } from "@/components/safety/PersonNeeds";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import {
  canManageDisclosures,
  disclosureDueChip,
  disclosureStateChip,
  disclosuresShown,
} from "@/lib/disclosures";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { personNames } from "@/lib/people";

export const metadata: Metadata = { title: t("disclosures.title") };

/**
 * The disclosure log (SAFE-016): each request with what kind it is, who asked, when it arrived,
 * when the answer is due and its state, in icons and words, and who it is about with their
 * communication needs. Titled by kind and organisation, never by the person.
 */
export default async function DisclosuresPage() {
  const { me } = await getShellContext();
  const title = t("disclosures.title");
  if (!disclosuresShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/disclosures", {});
  if (!data) {
    if (problemCode(error) === "missing_permission") return <SafetyForbidden title={title} />;
    return failWith(error, response, "/disclosures");
  }
  const listed = await api.GET("/v1/people", {});
  const people = new Map((listed.data?.items ?? []).map((p) => [p.id, p as PersonSummary]));
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        title={title}
        description={t("disclosures.description")}
        primaryAction={
          canManageDisclosures(me.permissions) ? (
            <ButtonLink href="/disclosures/new">{t("disclosures.new")}</ButtonLink>
          ) : null
        }
      />
      {data.truncated ? (
        <Notice
          tone="warning"
          icon={<TriangleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
          title={t("disclosures.truncated")}
        />
      ) : null}
      {data.items.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<FileLock2 size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("disclosures.empty")}
          />
        </Card>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {data.items.map((item) => {
            const person = people.get(item.personId);
            const due = disclosureDueChip(item, t);
            return (
              <li key={item.id}>
                <Card
                  as="article"
                  headingLevel={2}
                  className="break-words"
                  title={
                    <Link
                      href={`/disclosures/${item.id}`}
                      className="inline-flex min-h-target items-center underline"
                    >
                      {t("disclosures.itemTitle", {
                        type: t("disclosures.type", { value: item.type }),
                        organisation: item.requester.organisation,
                        when: formatDateTime(item.receivedAt) ?? "",
                      })}
                    </Link>
                  }
                >
                  <div className="flex flex-col gap-2">
                    <p className="m-0 flex flex-wrap items-center gap-2">
                      <SafetyChip chip={disclosureStateChip(item.state, t)} />
                      {due ? <SafetyChip chip={due} /> : null}
                    </p>
                    {person ? (
                      <>
                        <p className="m-0 font-semibold">{personNames(person).full}</p>
                        <PersonNeeds person={person} />
                      </>
                    ) : (
                      <p className="m-0">{t("disclosures.personHidden")}</p>
                    )}
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
