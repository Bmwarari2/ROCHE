import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { Info, UsersRound } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { createTeam } from "@/app/actions/reporting-lines";
import { Notice } from "@/components/care/Notice";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { WorkforceForm } from "@/components/workforce/WorkforceForm";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { t } from "@/lib/i18n";
import {
  maintainsReportingLines,
  sortTeams,
  teamChip,
  teamHref,
  teamsHref,
  teamsShown,
} from "@/lib/reporting-lines";

export const metadata: Metadata = { title: t("workforce.teams.title") };

/**
 * Staff teams (ADR-0137): each team in use, then those archived, with its home. HR adds teams; a
 * team's lead may read their team's development records, never sign off or record for them
 * (HZ-119). Anyone else who may read development records sees the list read only.
 */
export default async function TeamsPage() {
  const { me } = await getShellContext();
  const title = t("workforce.teams.title");
  if (!teamsShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const listed = await api.GET("/v1/workforce/teams");
  if (!listed.data) failWith(listed.error, listed.response, teamsHref);
  const teams = sortTeams(listed.data.teams);
  const maintains = maintainsReportingLines(me);
  const homes = new Map(me.locations.map((l) => [l.id, l.name]));

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("workforce.teams.description")}
      />
      {maintains ? null : (
        <Notice
          icon={<Info size={20} strokeWidth={1.5} aria-hidden="true" />}
          title={t("workforce.teams.readOnly")}
        />
      )}
      {teams.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<UsersRound size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("workforce.teams.empty")}
          />
        </Card>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {teams.map((team) => (
            <li key={team.id}>
              <Card>
                <div className="flex flex-col gap-2">
                  <h2 className="m-0 text-body font-semibold">
                    <Link
                      href={teamHref(team.id)}
                      className="inline-flex min-h-target items-center underline"
                    >
                      {team.name}
                    </Link>
                  </h2>
                  <p className="m-0 flex flex-wrap items-center gap-2">
                    <SafetyChip chip={teamChip(team.archived, t)} />
                    <span className="text-body-dense">
                      {team.locationId
                        ? homes.has(team.locationId)
                          ? t("workforce.teams.home", { home: homes.get(team.locationId) ?? "" })
                          : t("workforce.teams.anotherHome")
                        : t("workforce.teams.everyHome")}
                    </span>
                  </p>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {maintains ? (
        <Card>
          <WorkforceForm
            headingLevel={2}
            title={t("workforce.teams.add")}
            intro={t("workforce.teams.addIntro")}
            path={teamsHref}
            submit={t("workforce.teams.addSubmit")}
            done="workforce.teams.added"
            action={createTeam}
            fields={[
              {
                kind: "text",
                name: "name",
                label: t("workforce.teams.nameLabel"),
                required: true,
                maxLength: 120,
              },
              {
                kind: "select",
                name: "locationId",
                label: t("workforce.teams.homeLabel"),
                hint: t("workforce.teams.homeHint"),
                emptyOption: t("workforce.teams.everyHome"),
                options: me.locations.map((l) => ({ value: l.id, label: l.name })),
              },
            ]}
          />
        </Card>
      ) : null}
    </div>
  );
}
