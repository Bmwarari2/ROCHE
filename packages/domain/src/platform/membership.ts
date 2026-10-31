/**
 * Ending a member's place in an organisation (platform.md, Members; recommended answer to H-566,
 * 31/10/2026). A holder of `platform.user.manage`, with step-up and a coded reason, first suspends
 * the membership (its access ends at once), then ends it. The member row, display name and job
 * title stay, so care records stay attributable to who made them (Regulation 17 of the 2014
 * Regulations); the staff file follows its own retention. Once the membership has ended and the
 * person's sign-in has no active membership anywhere else (and is not a Harbour operator's), the
 * sign-in identity (email, password hash, passkeys, TOTP secret, sessions) is erased and the
 * member row keeps no link to it. Pure rules: the API reads the facts and applies the change.
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

export type MembershipAction = "suspend" | "end" | "erase_sign_in";

export interface MembershipFacts {
  readonly action: MembershipAction;
  readonly state: MembershipState;
  /** The manager acting on their own membership. */
  readonly self: boolean;
  /** The member row still links to a sign-in (`tenant_user.auth_user_id`). */
  readonly signInLinked: boolean;
  /** Active memberships of the same sign-in in other organisations (erasure only). */
  readonly otherActiveMemberships: number;
  /** The same sign-in is a Harbour operator's (erasure only). */
  readonly operator: boolean;
}

export type MembershipProblem =
  | "own_membership"
  | "membership_ended"
  | "suspend_first"
  | "membership_not_ended"
  | "sign_in_in_use";

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
      if (f.otherActiveMemberships > 0 || f.operator) return refuse("sign_in_in_use");
      return ok("apply");
  }
}

export const MEMBERSHIP_MESSAGES: Readonly<Record<MembershipProblem, string>> = {
  own_membership: "You cannot suspend, end or erase your own membership. Ask another manager.",
  membership_ended: "This membership has ended, so it cannot be suspended.",
  suspend_first:
    "Suspend the membership first: that ends their access and their devices' sessions.",
  membership_not_ended: "End the membership before erasing the sign-in.",
  sign_in_in_use:
    "This person still uses their sign-in for another organisation in Harbour, or for Harbour itself, so it has been kept. Their membership here has ended.",
};
