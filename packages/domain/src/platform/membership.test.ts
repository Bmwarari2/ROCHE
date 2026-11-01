import { describe, expect, it } from "vitest";
import {
  checkMembershipChange,
  MEMBERSHIP_MESSAGES,
  MEMBERSHIP_STATES,
  type MembershipAction,
  type MembershipCheck,
  type MembershipFacts,
  type MembershipState,
} from "./membership";

/**
 * Suspending and ending a membership and erasing the sign-in (platform.md, Members; recommended
 * answer to H-566). Suspend first, then end; erase only an ended membership's sign-in, and only
 * once nobody else in Harbour relies on it.
 */

const facts = (o: Partial<MembershipFacts> = {}): MembershipFacts => ({
  action: "suspend",
  state: "active",
  self: false,
  signInLinked: true,
  otherMemberships: 0,
  operator: false,
  ...o,
});

describe("H-566 membership changes, every action from every state", () => {
  const table: Record<MembershipAction, Record<MembershipState, MembershipCheck>> = {
    suspend: {
      invited: { ok: true, outcome: "apply" },
      active: { ok: true, outcome: "apply" },
      suspended: { ok: true, outcome: "replay" },
      left: { ok: false, problem: "membership_ended" },
    },
    end: {
      invited: { ok: false, problem: "suspend_first" },
      active: { ok: false, problem: "suspend_first" },
      suspended: { ok: true, outcome: "apply" },
      left: { ok: true, outcome: "replay" },
    },
    erase_sign_in: {
      invited: { ok: false, problem: "membership_not_ended" },
      active: { ok: false, problem: "membership_not_ended" },
      suspended: { ok: false, problem: "membership_not_ended" },
      left: { ok: true, outcome: "apply" },
    },
  };
  const cases = (Object.keys(table) as MembershipAction[]).flatMap((action) =>
    MEMBERSHIP_STATES.map((state) => [action, state, table[action][state]] as const),
  );

  it.each(cases)("%s from %s", (action, state, expected) => {
    expect(checkMembershipChange(facts({ action, state }))).toEqual(expected);
  });

  it.each(["suspend", "end", "erase_sign_in"] as const)(
    "never lets a manager %s their own membership",
    (action) => {
      expect(checkMembershipChange(facts({ action, state: "left", self: true }))).toEqual({
        ok: false,
        problem: "own_membership",
      });
    },
  );
});

describe("H-566 the sign-in is erased only when nobody else relies on it", () => {
  it.each<[string, Partial<MembershipFacts>, MembershipCheck]>([
    ["no other membership and not an operator", {}, { ok: true, outcome: "apply" }],
    [
      "a membership in another organisation that has not ended (suspended included)",
      { otherMemberships: 1 },
      { ok: false, problem: "sign_in_in_use" },
    ],
    ["a Harbour operator's sign-in", { operator: true }, { ok: false, problem: "sign_in_in_use" }],
    ["a sign-in already erased", { signInLinked: false }, { ok: true, outcome: "replay" }],
    [
      "a sign-in already erased, even if the old one were in use elsewhere",
      { signInLinked: false, otherMemberships: 2 },
      { ok: true, outcome: "replay" },
    ],
  ])("%s", (_label, over, expected) => {
    expect(
      checkMembershipChange(facts({ action: "erase_sign_in", state: "left", ...over })),
    ).toEqual(expected);
  });

  it("has a message in words for every refusal, the database's included", () => {
    expect(MEMBERSHIP_MESSAGES.last_user_manager).toContain("last active member");
    for (const message of Object.values(MEMBERSHIP_MESSAGES)) {
      expect(message).toMatch(/^[A-Z].*\.$/);
    }
  });
});
