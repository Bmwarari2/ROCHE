import {
  type AssignableRole,
  CreateMember,
  type InvitationSummary,
  MEMBER_CHANGE_REASONS,
  MEMBER_DEVICE_CHECKS,
  MEMBER_REINSTATE_REASONS,
  type MemberLifecycle,
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

type MembershipState = MemberLifecycle["state"];

const MEMBERSHIP_CHIP: Record<MembershipState, Omit<TeamChip, "label">> = {
  ...MEMBER_CHIP,
  left: { status: "neutral", icon: "ban" },
};

/** A membership's state, ended included (H-566), as an icon and a word. */
export function membershipChip(state: MembershipState, t: Translator): TeamChip {
  return { ...MEMBERSHIP_CHIP[state], label: t("team.lifecycle.state", { state }) };
}

/** A change a manager can make to a membership from its page (H-566). */
export type MembershipKind = "suspend" | "reinstate" | "end" | "erase";

/**
 * Which changes to offer (H-566): suspend an active or invited membership; reinstate or end a suspended one
 * (ending only once the member's held entries are handed over); for an ended one, reinstate it
 * when the API allows this manager (H-1469) and erase a sign-in nobody else relies on. Never the manager's own; the API refuses that too.
 */
export function membershipChanges(
  member: Pick<MemberLifecycle, "id" | "state" | "signIn" | "entriesToHandOver" | "mayReinstate">,
  myId: string,
): readonly MembershipKind[] {
  if (member.id === myId) return [];
  // An invited member can be suspended too (their invitations end), as the API allows.
  if (member.state === "active" || member.state === "invited") return ["suspend"];
  if (member.state === "suspended") {
    return member.entriesToHandOver === 0 ? ["reinstate", "end"] : ["reinstate"];
  }
  if (member.state === "left") {
    // Reinstating an ended membership: only when the API says this manager may (H-1469).
    return [
      ...(member.mayReinstate ? (["reinstate"] as const) : []),
      ...(member.signIn === "kept" ? (["erase"] as const) : []),
    ];
  }
  return [];
}

/** The coded reasons for a change, with their words (none for erasing the sign-in). */
export function membershipReasons(
  kind: MembershipKind,
  t: Translator,
): { readonly value: string; readonly label: string }[] {
  if (kind === "erase") return [];
  if (kind === "reinstate") {
    return MEMBER_REINSTATE_REASONS.map((reason) => ({
      value: reason,
      label: t("team.reinstate.reasonOption", { reason }),
    }));
  }
  return MEMBER_CHANGE_REASONS.map((reason) => ({
    value: reason,
    label: t("team.lifecycle.reasonOption", { reason }),
  }));
}

/** How a manager checked the devices a member used, with their words (H-566, clinical review B1). */
export function deviceChecks(t: Translator): { readonly value: string; readonly label: string }[] {
  return MEMBER_DEVICE_CHECKS.map((check) => ({
    value: check,
    label: t("team.end.deviceCheckOption", { check }),
  }));
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

/** API refusals from the team and membership routes that have their own words. */
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
  "own_membership",
  "last_user_manager",
  "membership_ended",
  "suspend_first",
  "membership_not_ended",
  "sign_in_in_use",
  "entries_waiting",
  "entries_to_hand_over",
  "devices_unchecked",
  "leaving_still_recorded",
]);

/** The words for a team refusal, or null for one the shared problem words cover. */
export function teamRefusal(code: unknown, t: Translator): string | null {
  return typeof code === "string" && REFUSALS.has(code) ? t("team.refusal", { code }) : null;
}
