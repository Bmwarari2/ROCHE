/**
 * Ending a member's place in an organisation (platform.md, Members; recommended answer to H-566,
 * 31/10/2026). A holder of `platform.user.manage`, with step-up and a coded reason, first suspends
 * the membership (its access ends at once), then ends it. The member row, display name and job
 * title stay, so care records stay attributable to who made them (Regulation 17 of the 2014
 * Regulations); the staff file follows its own retention. Once the membership has ended and the
 * person's sign-in has no membership anywhere else that has not ended (suspended included) and is
 * not a Harbour operator's, the sign-in identity (its email address, password hash, passkeys, TOTP
 * secret, sessions) is erased and the member row keeps no link to it. Pure rules: the API reads
 * the facts; the database applies the change (`app.change_membership`, migration 0129), which
 * also keeps the organisation's last member who manages users through a role.
 */

/** A member's state in one organisation (`tenant_user.status`). */
export const MEMBERSHIP_STATES = ["invited", "active", "suspended", "left"] as const;
export type MembershipState = (typeof MEMBERSHIP_STATES)[number];

/** Why a manager suspended or ended a membership: a code, never words. */
export const MEMBERSHIP_CHANGE_REASONS = [
  "staff_left",
  "account_deletion_request",
  "investigation",
  "safeguarding_concern",
  "long_absence",
  "other",
] as const;
export type MembershipChangeReason = (typeof MEMBERSHIP_CHANGE_REASONS)[number];

export type MembershipAction = "suspend" | "reinstate" | "end" | "erase_sign_in";

export interface MembershipFacts {
  readonly action: MembershipAction;
  readonly state: MembershipState;
  /** The manager acting on their own membership. */
  readonly self: boolean;
  /** The member row still links to a sign-in (`tenant_user.auth_user_id`). */
  readonly signInLinked: boolean;
  /**
   * Memberships of the same sign-in in other organisations that have not ended (invited, active
   * or suspended; erasure only).
   */
  readonly otherMemberships: number;
  /** The same sign-in is a Harbour operator's (erasure only). */
  readonly operator: boolean;
  /**
   * Reinstating an ended membership only: the manager holds platform.user.manage across the
   * organisation (H-1469), and the member's sign-in has not been erased.
   */
  readonly organisationWide?: boolean;
  readonly signInErased?: boolean;
  /** The member asked for their account to be deleted (their request stands). */
  readonly deletionRequested?: boolean;
}

export type MembershipProblem =
  | "own_membership"
  | "membership_ended"
  | "suspend_first"
  | "membership_not_ended"
  | "sign_in_in_use"
  /** Reinstating gives back permissions the manager does not hold where they apply. */
  | "beyond_inviter"
  /** Ending while the member used a device for Care mode and no device check is given. */
  | "devices_unchecked"
  /** Ending while the member's entries are still held on a device. */
  | "entries_to_hand_over"
  /** Refused by the database only (`app.change_membership`): it counts the role holders. */
  | "last_user_manager"
  /** Refused by the database only: a leaving still recorded is withdrawn before reinstating. */
  | "leaving_still_recorded";

/**
 * `apply` changes the membership; `replay` means it is already in the state asked for (a retry
 * changes nothing, and is not audited again as a change).
 */
export type MembershipCheck =
  | { readonly ok: true; readonly outcome: "apply" | "replay" }
  | { readonly ok: false; readonly problem: MembershipProblem };

const refuse = (problem: MembershipProblem): MembershipCheck => ({ ok: false, problem });
const ok = (outcome: "apply" | "replay"): MembershipCheck => ({ ok: true, outcome });

/** Whether a membership change may be made, and whether it changes anything. */
export function checkMembershipChange(f: MembershipFacts): MembershipCheck {
  // Nobody suspends, ends or erases themselves: an organisation is never left without the
  // manager who acted, and a mistake cannot lock its author out.
  if (f.self) return refuse("own_membership");
  switch (f.action) {
    case "suspend":
      if (f.state === "suspended") return ok("replay");
      if (f.state === "left") return refuse("membership_ended");
      return ok("apply");
    case "reinstate":
      // Undoes a suspension made by mistake, before the membership ends (H-1463).
      if (f.state === "active" || f.state === "invited") return ok("replay");
      // An ended membership comes back only from someone who manages users across the
      // organisation (a wrong leaving date withdrawn, HZ-133), and never once its sign-in is gone.
      if (f.state === "left") {
        return f.organisationWide === true &&
          f.signInErased !== true &&
          f.deletionRequested !== true
          ? ok("apply")
          : refuse("membership_ended");
      }
      return ok("apply");
    case "end":
      if (f.state === "left") return ok("replay");
      // Suspension first: it ends access and hands over what devices hold before the end.
      if (f.state !== "suspended") return refuse("suspend_first");
      return ok("apply");
    case "erase_sign_in":
      if (f.state !== "left") return refuse("membership_not_ended");
      if (!f.signInLinked) return ok("replay");
      // The sign-in belongs to the person, not to one organisation: while they work elsewhere in
      // Harbour, or run Harbour as an operator, it stays (#40 review M1; H-354).
      if (f.otherMemberships > 0 || f.operator) return refuse("sign_in_in_use");
      return ok("apply");
  }
}

export const MEMBERSHIP_MESSAGES: Readonly<Record<MembershipProblem, string>> = {
  own_membership:
    "You cannot suspend, reinstate, end or erase your own membership. Ask another manager.",
  membership_ended:
    "This membership has ended, so it cannot be suspended. Only someone who manages users across the organisation can reinstate it, and not once its sign-in has been erased.",
  suspend_first:
    "Suspend the membership first: that ends their access and their devices' sessions.",
  membership_not_ended: "End the membership before erasing the sign-in.",
  sign_in_in_use:
    "This person still has a membership with another organisation in Thapsus Care, or uses their sign-in for Thapsus Care itself, so it has been kept. Their membership here has ended.",
  beyond_inviter:
    "Their roles include permissions you do not hold where they apply, so you cannot give them back. Ask someone who holds them.",
  devices_unchecked:
    "They used a device for Care mode. Their phone cannot report once suspended, so say how its contents were checked before you end the membership.",
  entries_to_hand_over:
    "Care entries of theirs are still held on a device. Hand them over, or record their deletion on the device, then end the membership.",
  leaving_still_recorded:
    "Their leaving is still recorded. Withdraw it first, in their staff file or through the HR link, then reinstate them.",
  last_user_manager:
    "This is the organisation's last active member who manages users through a role, so they stay. Give the role to someone else first.",
};
