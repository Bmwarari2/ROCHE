import {
  type AssignableRole,
  CreateMember,
  type InvitationSummary,
  type MemberSummary,
} from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import type { FieldErrors } from "./outcome";

/**
 * The managers' team and invitation screens (PLAT-004; platform.md, Members and Invitations).
 * Everything here is gated on the permission the API uses for both, `platform.user.manage`; the
 * API checks it again and reaches only the members it reaches. Pure helpers, unit tested.
 */

export const TEAM_PERMISSION = "platform.user.manage";

/** The value of the "where" choice that means across the organisation. */
export const ORGANISATION = "organisation";

export function teamShown(permissions: readonly string[]): boolean {
  return permissions.includes(TEAM_PERMISSION);
}

export type ChipIcon = "clock" | "circle-check" | "timer-off" | "ban" | "mail" | "pause";

export interface TeamChip {
  readonly status: "done" | "info" | "neutral";
  readonly icon: ChipIcon;
  readonly label: string;
}

const INVITATION_CHIP: Record<InvitationSummary["state"], Omit<TeamChip, "label">> = {
  pending: { status: "info", icon: "clock" },
  accepted: { status: "done", icon: "circle-check" },
  expired: { status: "neutral", icon: "timer-off" },
  revoked: { status: "neutral", icon: "ban" },
};

/** An invitation's state as an icon and a word, never colour alone. */
export function invitationChip(state: InvitationSummary["state"], t: Translator): TeamChip {
  return { ...INVITATION_CHIP[state], label: t("team.invitation.state", { state }) };
}

const MEMBER_CHIP: Record<MemberSummary["state"], Omit<TeamChip, "label">> = {
  invited: { status: "info", icon: "mail" },
  active: { status: "done", icon: "circle-check" },
  suspended: { status: "neutral", icon: "pause" },
};

export function memberChip(state: MemberSummary["state"], t: Translator): TeamChip {
  return { ...MEMBER_CHIP[state], label: t("team.member.state", { state }) };
}

/**
 * Whether to offer sending (again): the API invites only members still invited, so an active or
 * suspended member is never offered it. A refusal it still gives (a sign-in already made) is said
 * in words.
 */
export function mayResend(member: Pick<MemberSummary, "state">): boolean {
  return member.state === "invited";
}

/** Only an open invitation can be withdrawn. */
export function mayRevoke(invitation: Pick<InvitationSummary, "state">): boolean {
  return invitation.state === "pending";
}

/** "Registered Manager at Harbour House", or "… across the organisation". */
export function roleLine(
  role: { readonly roleName: string; readonly locationId: string | null },
  locations: readonly { readonly id: string; readonly name: string }[],
  t: Translator,
): string {
  if (role.locationId === null) return t("team.role.organisation", { role: role.roleName });
  const place = locations.find((l) => l.id === role.locationId)?.name;
  return place
    ? t("team.role.at", { role: role.roleName, place })
    : t("team.role.elsewhere", { role: role.roleName });
}

export type InviteInput = {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
  readonly roleId: string;
  readonly locationId: string | null;
};

const FIELD_MESSAGE = {
  displayName: "team.invite.nameRequired",
  email: "team.invite.emailInvalid",
  roleId: "team.invite.roleRequired",
  locationId: "team.invite.placeRequired",
} as const;

/**
 * Reads the invite form with the API's own schema (`CreateMember`), so the form refuses exactly
 * what the API would, each field in words. The role must be one the manager may give where they
 * chose (`assignableRoles`), or the API would refuse it.
 */
export function readInvite(
  form: { get(name: string): unknown },
  id: string,
  roles: readonly AssignableRole[],
  t: Translator,
):
  | { readonly ok: true; readonly value: InviteInput }
  | { readonly ok: false; fields: FieldErrors } {
  const text = (name: string) => String(form.get(name) ?? "").trim();
  const place = text("place");
  const parsed = CreateMember.safeParse({
    id,
    displayName: text("displayName"),
    email: text("email"),
    roleId: text("roleId"),
    locationId: place === ORGANISATION ? null : place,
  });
  const fields: Record<string, string> = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "");
      if (key in FIELD_MESSAGE) {
        fields[key] ??= t(FIELD_MESSAGE[key as keyof typeof FIELD_MESSAGE]);
      }
    }
  } else {
    const role = roles.find((r) => r.id === parsed.data.roleId);
    if (!role) fields.roleId = t("team.invite.roleRequired");
    else if (!role.locationIds.includes(parsed.data.locationId)) {
      fields.locationId = t("team.invite.placeNotAllowed");
    }
  }
  if (Object.keys(fields).length > 0 || !parsed.success) return { ok: false, fields };
  return { ok: true, value: { ...parsed.data, email: parsed.data.email.toLowerCase() } };
}

/** API refusals from the team routes that have their own words. */
const REFUSALS = new Set([
  "email_in_use",
  "member_id_conflict",
  "beyond_inviter",
  "member_active",
  "member_suspended",
  "member_left",
  "member_has_sign_in",
  "member_mfa_not_required",
  "email_invalid",
  "invitation_closed",
]);

/** The words for a team refusal, or null for one the shared problem words cover. */
export function teamRefusal(code: unknown, t: Translator): string | null {
  return typeof code === "string" && REFUSALS.has(code) ? t("team.refusal", { code }) : null;
}
