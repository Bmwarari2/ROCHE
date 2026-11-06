import { describe, expect, it } from "vitest";
import { t } from "./i18n";
import {
  invitationChip,
  mayResend,
  mayRevoke,
  memberChip,
  membershipChanges,
  membershipChip,
  membershipReasons,
  ORGANISATION,
  readInvite,
  roleLine,
  teamRefusal,
  teamShown,
} from "./team";

const ID = "0199f000-0000-7000-8000-000000000001";
const ROLE = "0199f000-0000-7000-8000-000000000501";
const NORTH = "0199f000-0000-7000-8000-000000000101";
const SOUTH = "0199f000-0000-7000-8000-000000000102";
const roles = [{ id: ROLE, name: "Care or support worker", locationIds: [NORTH] }];
const form = (values: Record<string, string>) => ({ get: (name: string) => values[name] ?? null });
const valid = {
  displayName: " Ada Example ",
  email: "Ada.Example@Example.invalid",
  roleId: ROLE,
  place: NORTH,
};

describe("the team screens", () => {
  it("are shown only to holders of platform.user.manage", () => {
    expect(teamShown(["platform.user.manage"])).toBe(true);
    expect(teamShown(["people.person.read"])).toBe(false);
  });

  it.each([
    ["pending", "info", "clock", "Pending"],
    ["accepted", "done", "circle-check", "Accepted"],
    ["expired", "neutral", "timer-off", "Expired"],
    ["revoked", "neutral", "ban", "Withdrawn"],
  ] as const)("shows an invitation %s as an icon and a word", (state, status, icon, label) => {
    expect(invitationChip(state, t)).toEqual({ status, icon, label });
  });

  it.each([
    ["invited", "Invited", true],
    ["active", "Active", false],
    ["suspended", "Suspended", false],
  ] as const)("a member %s reads %s; sending again: %s", (state, label, resend) => {
    expect(memberChip(state, t).label).toBe(label);
    expect(mayResend({ state })).toBe(resend);
  });

  it.each([
    ["pending", true],
    ["accepted", false],
    ["expired", false],
    ["revoked", false],
  ] as const)("withdraws a %s invitation: %s", (state, expected) => {
    expect(mayRevoke({ state })).toBe(expected);
  });

  it("names a role and where it applies", () => {
    const locations = [{ id: NORTH, name: "Harbour House" }];
    expect(roleLine({ roleName: "Nurse", locationId: NORTH }, locations, t)).toBe(
      "Nurse at Harbour House",
    );
    expect(roleLine({ roleName: "Owner", locationId: null }, locations, t)).toBe(
      "Owner across the organisation",
    );
    expect(roleLine({ roleName: "Nurse", locationId: SOUTH }, locations, t)).toBe(
      "Nurse at another location",
    );
  });
});

describe("reading the invite form with the API's schema", () => {
  it("trims the name and lowers the address", () => {
    expect(readInvite(form(valid), ID, roles, t)).toEqual({
      ok: true,
      value: {
        id: ID,
        displayName: "Ada Example",
        email: "ada.example@example.invalid",
        roleId: ROLE,
        locationId: NORTH,
      },
    });
  });

  it("says what each empty or malformed field needs", () => {
    const read = readInvite(form({ email: "not an address" }), ID, roles, t);
    expect(read).toEqual({
      ok: false,
      fields: {
        displayName: "Enter their full name",
        email: "Enter an email address in the correct format, like name@example.com",
        roleId: "Choose a role",
        locationId: "Choose where the role applies",
      },
    });
  });

  it.each([
    ["a role it may not give", { roleId: "0199f000-0000-7000-8000-000000000599" }, "roleId"],
    ["a place the role may not be given", { place: SOUTH }, "locationId"],
    ["across the organisation, not offered", { place: ORGANISATION }, "locationId"],
  ])("refuses %s", (_, change, field) => {
    const read = readInvite(form({ ...valid, ...change }), ID, roles, t);
    expect(read.ok).toBe(false);
    expect(read.ok ? {} : Object.keys(read.fields)).toEqual([field]);
  });

  it("gives an organisation-wide role across the organisation", () => {
    const wide = [{ id: ROLE, name: "Owner", locationIds: [null] }];
    const read = readInvite(form({ ...valid, place: ORGANISATION }), ID, wide, t);
    expect(read.ok && read.value.locationId).toBeNull();
  });
});

describe("refusals in words", () => {
  it.each([
    ["email_in_use", "already uses this email address"],
    ["beyond_inviter", "cannot give this role"],
    ["member_has_sign_in", "already has a sign-in"],
    ["invitation_closed", "already been accepted or withdrawn"],
  ])("says %s plainly", (code, words) => {
    expect(teamRefusal(code, t)).toContain(words);
  });

  it("leaves other codes to the shared words", () => {
    expect(teamRefusal("step_up_required", t)).toBeNull();
    expect(teamRefusal(undefined, t)).toBeNull();
  });
});

describe("the membership lifecycle (H-566)", () => {
  const me = "0199a000-0000-7000-8000-000000000001";
  const other = "0199a000-0000-7000-8000-000000000002";
  const member = (o: Partial<Parameters<typeof membershipChanges>[0]> = {}) => ({
    id: other,
    state: "active" as const,
    signIn: "kept" as const,
    entriesToHandOver: 0,
    ...o,
  });
  it.each([
    [member(), ["suspend"]],
    [member({ state: "suspended" }), ["reinstate", "end"]],
    [member({ state: "suspended", entriesToHandOver: 2 }), ["reinstate"]],
    [member({ state: "left" }), ["erase"]],
    [member({ state: "left", signIn: "kept_other_organisation" }), []],
    [member({ state: "left", signIn: "erased" }), []],
    [member({ state: "invited", signIn: "none" }), []],
    [member({ id: me }), []],
    [member({ id: me, state: "suspended" }), []],
  ] as const)("offers %o the changes %o", (m, expected) => {
    expect(membershipChanges(m, me)).toEqual(expected);
  });

  it("says each state as an icon and a word, ended included", () => {
    expect(membershipChip("left", t)).toEqual({ status: "neutral", icon: "ban", label: "Ended" });
    expect(membershipChip("suspended", t).label).toBe("Suspended");
  });

  it("offers every coded reason the API takes, in words", () => {
    for (const kind of ["suspend", "reinstate", "end"] as const) {
      const reasons = membershipReasons(kind, t);
      expect(reasons.length).toBeGreaterThan(0);
      for (const r of reasons) {
        if (r.value !== "other") expect(r.label, r.value).not.toBe("Another reason");
      }
    }
    expect(membershipReasons("suspend", t).map((r) => r.value)).toContain(
      "account_deletion_request",
    );
    expect(membershipReasons("erase", t)).toEqual([]);
  });

  it("has words for the lifecycle refusals", () => {
    for (const code of [
      "own_membership",
      "last_user_manager",
      "membership_ended",
      "suspend_first",
      "membership_not_ended",
      "sign_in_in_use",
      "entries_waiting",
      "entries_to_hand_over",
      "devices_unchecked",
    ]) {
      expect(teamRefusal(code, t), code).not.toContain("Something went wrong");
    }
  });
});
