import { Card, PageHeader } from "@harbour/ui";
import { Info, Star } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  addTeamMember,
  archiveTeam,
  changeTeam,
  endTeamMember,
  setTeamLead,
} from "@/app/actions/reporting-lines";
import { Notice } from "@/components/care/Notice";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { WorkforceForm } from "@/components/workforce/WorkforceForm";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import {
  maintainsReportingLines,
  periodChip,
  sortMembers,
  staffOptions,
  teamChip,
  teamHref,
  teamsHref,
  teamsShown,
} from "@/lib/reporting-lines";
import { ukToday } from "@/lib/uk-time";
import { ukDate } from "@/lib/workforce";

export const metadata: Metadata = { title: t("workforce.teams.teamTitle") };

/**
 * One staff team (ADR-0137): its members, the lead first, then those who have left the team. HR
 * renames or archives the team, adds members, marks the lead and ends a membership, each against
 * the version loaded. Members are listed only where the reader's scope covers them.
 */
export default async function TeamPage({ params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  if (!isUuid(teamId)) notFound();
  const { me } = await getShellContext();
  if (!teamsShown(me.permissions))
    return <SafetyForbidden title={t("workforce.teams.teamTitle")} />;
  const api = await tenantApi();
  const path = teamHref(teamId);
  const maintains = maintainsReportingLines(me);
  const [teams, members, staff] = await Promise.all([
    api.GET("/v1/workforce/teams"),
    api.GET("/v1/workforce/teams/{teamId}/members", { params: { path: { teamId } } }),
    maintains ? api.GET("/v1/workforce/staff-members") : null,
  ]);
  if (!teams.data) failWith(teams.error, teams.response, path);
  const team = teams.data.teams.find((x) => x.id === teamId);
  if (!team) notFound();
  if (!members.data) failWith(members.error, members.response, path);
  const listed = sortMembers(members.data.members);
  const inTeam = listed.filter((m) => m.validTo === null).map((m) => m.memberId);
  const options = staffOptions(staff?.data?.items ?? [], inTeam);
  const homes = me.locations.map((l) => ({ value: l.id, label: l.name }));
  const homeName = team.locationId
    ? (me.locations.find((l) => l.id === team.locationId)?.name ?? null)
    : null;
  const edits = maintains && !team.archived;
  const today = ukToday();

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={t("workforce.teams.title")}
        title={team.name}
        description={
          homeName
            ? t("workforce.teams.home", { home: homeName })
            : team.locationId
              ? t("workforce.teams.anotherHome")
              : t("workforce.teams.everyHome")
        }
      />
      <p className="m-0">
        <SafetyChip chip={teamChip(team.archived, t)} />
      </p>
      {maintains ? null : (
        <Notice
          icon={<Info size={20} strokeWidth={1.5} aria-hidden="true" />}
          title={t("workforce.teams.readOnly")}
        />
      )}
      <Card as="section" title={t("workforce.teams.members")} headingLevel={2}>
        {listed.length === 0 ? (
          <p className="m-0">{t("workforce.teams.noMembers")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {listed.map((member) => (
              <li
                key={member.id}
                className="flex flex-col gap-2 border-b border-border pb-4 last:border-0"
              >
                <h3 className="m-0 text-body font-semibold">{member.name}</h3>
                <p className="m-0 flex flex-wrap items-center gap-2">
                  <SafetyChip chip={periodChip(member.validTo, t)} />
                  {member.isLead && member.validTo === null ? (
                    <span className="inline-flex items-center gap-1 font-semibold">
                      <Star size={18} strokeWidth={1.5} aria-hidden="true" />
                      {t("workforce.teams.lead")}
                    </span>
                  ) : null}
                </p>
                <p className="m-0 text-body-dense">
                  {member.validTo
                    ? t("workforce.teams.period", {
                        from: ukDate(member.validFrom),
                        to: ukDate(member.validTo),
                      })
                    : t("workforce.teams.periodOpen", { from: ukDate(member.validFrom) })}
                </p>
                {edits && member.validTo === null ? (
                  <div className="flex flex-col gap-4">
                    <WorkforceForm
                      headingLevel={4}
                      title={t("workforce.teams.leadToggle", {
                        lead: member.isLead ? "yes" : "no",
                        name: member.name,
                      })}
                      path={path}
                      submit={t("workforce.teams.leadToggle", {
                        lead: member.isLead ? "yes" : "no",
                        name: member.name,
                      })}
                      done="workforce.teams.leadSaved"
                      action={setTeamLead.bind(
                        null,
                        teamId,
                        member.id,
                        member.version,
                        !member.isLead,
                      )}
                      fields={[]}
                    />
                    <WorkforceForm
                      headingLevel={4}
                      title={t("workforce.teams.endMember", { name: member.name })}
                      path={path}
                      submit={t("workforce.teams.endMemberSubmit", { name: member.name })}
                      done="workforce.teams.memberEnded"
                      destructive
                      action={endTeamMember.bind(
                        null,
                        teamId,
                        member.id,
                        member.version,
                        member.isLead,
                      )}
                      fields={[
                        {
                          kind: "date",
                          name: "endsOn",
                          label: t("workforce.teams.endsOnLabel"),
                          hint: t("workforce.teams.endsOnHint"),
                          required: true,
                          defaultValue: today,
                        },
                      ]}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {edits ? (
        <>
          <Card>
            <WorkforceForm
              headingLevel={2}
              title={t("workforce.teams.addMember")}
              intro={t("workforce.teams.addMemberIntro")}
              path={path}
              submit={t("workforce.teams.addMemberSubmit")}
              done="workforce.teams.memberAdded"
              action={addTeamMember.bind(null, teamId)}
              fields={[
                {
                  kind: "select",
                  name: "memberId",
                  label: t("workforce.teams.memberLabel"),
                  required: true,
                  emptyOption: t("workforce.form.choose"),
                  options,
                },
                { kind: "checkbox", name: "isLead", label: t("workforce.teams.isLeadLabel") },
                {
                  kind: "date",
                  name: "from",
                  label: t("workforce.teams.fromLabel"),
                  required: true,
                  defaultValue: today,
                },
              ]}
            />
          </Card>
          <Card>
            <WorkforceForm
              headingLevel={2}
              title={t("workforce.teams.rename")}
              path={path}
              submit={t("workforce.teams.renameSubmit")}
              done="workforce.teams.renamed"
              action={changeTeam.bind(null, teamId, team.version)}
              fields={[
                {
                  kind: "text",
                  name: "name",
                  label: t("workforce.teams.nameLabel"),
                  required: true,
                  maxLength: 120,
                  defaultValue: team.name,
                },
                {
                  kind: "select",
                  name: "locationId",
                  label: t("workforce.teams.homeLabel"),
                  hint: t("workforce.teams.homeHint"),
                  emptyOption: t("workforce.teams.everyHome"),
                  options: homes,
                  ...(team.locationId ? { defaultValue: team.locationId } : {}),
                },
              ]}
            />
          </Card>
          <Card>
            <WorkforceForm
              headingLevel={2}
              title={t("workforce.teams.archive")}
              intro={t("workforce.teams.archiveIntro")}
              path={path}
              submit={t("workforce.teams.archiveSubmit")}
              done="workforce.teams.archivedDone"
              destructive
              action={archiveTeam.bind(null, teamId, {
                name: team.name,
                locationId: team.locationId,
                version: team.version,
              })}
              fields={[
                {
                  kind: "checkbox",
                  name: "confirm",
                  label: t("workforce.teams.archiveConfirm"),
                  required: true,
                },
              ]}
            />
          </Card>
        </>
      ) : null}
      <p className="m-0">
        <Link href={teamsHref} className="inline-flex min-h-target items-center underline">
          {t("workforce.teams.back")}
        </Link>
      </p>
    </div>
  );
}
