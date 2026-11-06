import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { CircleAlert, MailX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrivalNotice } from "@/components/care/ArrivalNotice";
import { Notice } from "@/components/care/Notice";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { EmailFailedNotice } from "@/components/team/EmailFailedNotice";
import { ResendInvitation, RevokeInvitation } from "@/components/team/InvitationActions";
import { MembershipAction } from "@/components/team/MembershipActions";
import { TeamChip } from "@/components/team/TeamChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { firstParam } from "@/lib/record-metadata";
import {
  invitationChip,
  mayResend,
  mayRevoke,
  membershipChange,
  membershipChip,
  roleLine,
  teamShown,
} from "@/lib/team";

type Params = Promise<{ memberId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: t("team.member.pageTitle") };

const DONE = new Set(["sent", "revoked", "suspended", "ended"]);

/**
 * One member's membership (H-566): its state as an icon and a word, when it changed, their
 * sign-in and any account deletion request, the care entries their phone holds, and suspending an
 * active membership or ending a suspended one, each after a coded reason. Then their invitations
 * (PLAT-004), newest first, each with its state as an icon and a word
 * and its times; sending again only while the member is still invited, and withdrawing only an
 * open invitation, each after a confirmation. Holders of `platform.user.manage` only, for a member
 * it reaches (anyone else is not found).
 */
export default async function MemberInvitationsPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { memberId } = await params;
  if (!isUuid(memberId)) notFound();
  const { me } = await getShellContext();
  if (!teamShown(me.permissions)) return <SafetyForbidden title={t("team.title")} />;
  const api = await tenantApi();
  const status = await api.GET("/v1/members/{tenantUserId}/lifecycle", {
    params: { path: { tenantUserId: memberId } },
  });
  if (status.response.status === 404) notFound();
  if (!status.data) failWith(status.error, status.response, `/settings/team/${memberId}`);
  const lifecycle = status.data;
  const members = await api.GET("/v1/members", { params: { query: {} } });
  if (!members.data) failWith(members.error, members.response, `/settings/team/${memberId}`);
  const member = members.data.items.find((m) => m.id === memberId) ?? {
    id: memberId,
    displayName: lifecycle.displayName,
    state: lifecycle.state === "left" ? ("suspended" as const) : lifecycle.state,
    roles: [],
  };
  const change = membershipChange(lifecycle, me.tenantUserId);
  const listed = await api.GET("/v1/invitations", {
    params: { query: { tenantUserId: memberId } },
  });
  if (!listed.data) failWith(listed.error, listed.response, `/settings/team/${memberId}`);
  const invitations = listed.data.items;
  const query = await searchParams;
  const done = firstParam(query.done);
  // A new `at` with each action, so the same outcome twice is said twice.
  const at = firstParam(query.at) ?? "";
  const when = (iso: string | null) => formatDateTime(iso) ?? "";

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <Link
        href="/settings/team"
        className="inline-flex min-h-target items-center self-start underline"
      >
        {t("team.back")}
      </Link>
      <PageHeader eyebrow={t("team.title")} title={lifecycle.displayName} />
      {done && DONE.has(done) ? (
        <ArrivalNotice key={`${done}-${at}`}>{t("team.done", { done })}</ArrivalNotice>
      ) : null}
      {done === "emailFailed" ? (
        <EmailFailedNotice key={at}>{t("team.done", { done })}</EmailFailedNotice>
      ) : null}
      <Card as="section" title={t("team.member.about")} headingLevel={2}>
        <div className="flex flex-col gap-2">
          <p className="m-0">
            <TeamChip chip={membershipChip(lifecycle.state, t)} />
          </p>
          {lifecycle.jobTitle ? <p className="m-0">{lifecycle.jobTitle}</p> : null}
          {member.roles.map((r) => (
            <p key={`${r.roleId}-${r.locationId}`} className="m-0">
              {roleLine(r, me.locations, t)}
            </p>
          ))}
        </div>
      </Card>
      <Card as="section" title={t("team.lifecycle.title")} headingLevel={2}>
        <div className="flex flex-col gap-3">
          {lifecycle.statusChangedAt ? (
            <p className="m-0">
              {t("team.lifecycle.changedAt", {
                state: lifecycle.state,
                dateTime: when(lifecycle.statusChangedAt),
              })}
            </p>
          ) : null}
          <p className="m-0">{t("team.lifecycle.signIn", { state: lifecycle.signIn })}</p>
          {lifecycle.signInErasedAt ? (
            <p className="m-0">
              {t("team.lifecycle.erasedAt", { dateTime: when(lifecycle.signInErasedAt) })}
            </p>
          ) : null}
          {lifecycle.deletionRequestedAt ? (
            <p className="m-0">
              {t("team.lifecycle.deletion", {
                open: lifecycle.deletionRequestOpen ? "yes" : "no",
                date: when(lifecycle.deletionRequestedAt),
              })}
            </p>
          ) : null}
          {lifecycle.state !== "left" ? (
            <p className="m-0">{t("team.lifecycle.devices", { count: lifecycle.devicesUsed })}</p>
          ) : null}
          {lifecycle.state !== "left" && lifecycle.lastReportedAt ? (
            <p className="m-0">
              {t("team.lifecycle.lastReported", { dateTime: when(lifecycle.lastReportedAt) })}
            </p>
          ) : null}
          {lifecycle.state === "active" && lifecycle.entriesWaiting > 0 ? (
            <p className="m-0">
              {t("team.lifecycle.waiting", { count: lifecycle.entriesWaiting })}
            </p>
          ) : null}
          {lifecycle.state === "suspended" && lifecycle.entriesToHandOver > 0 ? (
            <Notice
              tone="warning"
              icon={<CircleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
              title={t("team.lifecycle.endNext")}
            >
              {t("team.lifecycle.toHandOver", { count: lifecycle.entriesToHandOver })}
            </Notice>
          ) : null}
          {change === "suspend" || (change === "end" && lifecycle.entriesToHandOver === 0) ? (
            <div>
              <MembershipAction
                kind={change}
                memberId={memberId}
                name={lifecycle.displayName}
                entriesWaiting={lifecycle.entriesWaiting}
                devicesUsed={lifecycle.devicesUsed}
              />
            </div>
          ) : null}
        </div>
      </Card>
      <Card as="section" title={t("team.invitations.title")} headingLevel={2}>
        <div className="flex flex-col gap-4">
          {invitations.length === 0 ? (
            <EmptyState
              headingLevel={3}
              icon={<MailX size={32} strokeWidth={1.5} aria-hidden="true" />}
              title={t("team.invitations.empty")}
            />
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {invitations.map((inv) => (
                <li key={inv.id} className="flex flex-col gap-1 border-b border-border pb-3">
                  <p className="m-0 flex flex-wrap items-center gap-2">
                    <TeamChip chip={invitationChip(inv.state, t)} />
                    <span className="text-body-dense">
                      {t("team.invitation.sentAt", { dateTime: when(inv.createdAt) })}
                    </span>
                  </p>
                  <p className="m-0 text-body-dense">
                    {inv.state === "accepted"
                      ? t("team.invitation.acceptedAt", { dateTime: when(inv.acceptedAt) })
                      : inv.state === "revoked"
                        ? t("team.invitation.revokedAt", { dateTime: when(inv.revokedAt) })
                        : t("team.invitation.expiresAt", {
                            state: inv.state,
                            dateTime: when(inv.expiresAt),
                          })}
                  </p>
                  {mayRevoke(inv) ? (
                    <div>
                      <RevokeInvitation memberId={member.id} invitationId={inv.id} />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {mayResend(member) ? (
            <div>
              <ResendInvitation
                memberId={member.id}
                name={member.displayName}
                again={invitations.length > 0}
              />
            </div>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
