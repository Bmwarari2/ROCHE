import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { InviteMemberForm } from "@/components/team/InviteMemberForm";
import { TeamChip } from "@/components/team/TeamChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { t } from "@/lib/i18n";
import { invitationChip, memberChip, roleLine, teamShown } from "@/lib/team";

export const metadata: Metadata = { title: t("team.title") };

/**
 * The team (PLAT-004): the members `platform.user.manage` reaches at the chosen location, or
 * across the person's locations, each with their state and their latest invitation's, and the
 * form to invite someone. Holders of the permission only; the API narrows the list again.
 */
export default async function TeamPage() {
  const { me, locationId } = await getShellContext();
  const title = t("team.title");
  if (!teamShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const listed = await api.GET("/v1/members", {
    params: { query: locationId ? { locationId } : {} },
  });
  if (!listed.data) failWith(listed.error, listed.response, "/settings/team");
  const { items, assignableRoles } = listed.data;
  // The latest invitation of each member still invited (the others have joined).
  const latest = new Map(
    await Promise.all(
      items
        .filter((m) => m.state === "invited")
        .map(async (m) => {
          const got = await api.GET("/v1/invitations", {
            params: { query: { tenantUserId: m.id } },
          });
          return [m.id, got.data?.items[0] ?? null] as const;
        }),
    ),
  );
  const location = me.locations.find((l) => l.id === locationId);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={location?.name ?? me.tenant.name}
        title={title}
        description={t("team.description")}
      />
      <Card as="section" title={t("team.members.title")} headingLevel={2}>
        {items.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<Users size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("team.members.empty")}
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {items.map((m) => {
              const invitation = latest.get(m.id);
              return (
                <li key={m.id} className="flex flex-col gap-1 border-b border-border pb-3">
                  <h3 className="m-0 text-body font-semibold">
                    <Link
                      href={`/settings/team/${m.id}`}
                      className="inline-flex min-h-target items-center underline"
                    >
                      {m.displayName}
                    </Link>
                  </h3>
                  {m.roles.map((r) => (
                    <p key={`${r.roleId}-${r.locationId}`} className="m-0 text-body-dense">
                      {roleLine(r, me.locations, t)}
                    </p>
                  ))}
                  <p className="m-0 flex flex-wrap items-center gap-2">
                    <TeamChip chip={memberChip(m.state, t)} />
                    {invitation ? (
                      <>
                        <span className="text-body-dense">{t("team.member.invitation")}</span>
                        <TeamChip chip={invitationChip(invitation.state, t)} />
                      </>
                    ) : m.state === "invited" ? (
                      <span className="text-body-dense">{t("team.member.notInvited")}</span>
                    ) : null}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Card as="section" title={t("team.invite.title")} headingLevel={2}>
        {assignableRoles.length === 0 ? (
          <p className="m-0">{t("team.invite.noRoles")}</p>
        ) : (
          <InviteMemberForm
            roles={assignableRoles}
            locations={me.locations.map((l) => ({ id: l.id, name: l.name }))}
          />
        )}
      </Card>
    </div>
  );
}
