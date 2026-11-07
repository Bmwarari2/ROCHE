import { DEFAULT_HR_OWNERS, PAY_UNIT_KIND } from "@harbour/domain";
import { describe, expect, it } from "vitest";
import {
  CHOOSABLE_KINDS,
  deliveryChip,
  enhancementsOf,
  FIXED_KINDS,
  heldNow,
  hrLinkMay,
  hrLinkNavShown,
  hrLinkProblem,
  hrLinkShown,
  leaversFirst,
  linkChip,
  PAY_UNIT_KINDS,
  payCodeField,
  readConnect,
  readLocationMap,
  readPayCodes,
  readPayRoute,
  readRelease,
  readSettings,
  syncChip,
  unitKindWords,
  unmappedKinds,
  validConnect,
  validOwners,
  validPayCodes,
  validPayRoute,
  validReleaseReason,
  validStaleness,
  validVersion,
} from "./hr-link";
import { t } from "./i18n";

/**
 * HZ-133: the words never name the other product (Thapsus-HR) in any spelling. The product's own
 * name (Thapsus Care, ADR-0127) is removed first, so any other "Thapsus" left fails.
 */
const withoutProductName = (text: string) => text.replaceAll(t("app.name"), "");

import { problemMessage } from "./outcome";
import { confirmExportRefusal, fromHrPlatform, paidThroughHrPlatform } from "./pay-time";

const TENANT = "0194d000-0000-7000-8000-000000000001";
const form = (values: Record<string, string>) => ({ get: (name: string) => values[name] ?? null });
const owners = (overrides: Record<string, string> = {}) =>
  Object.fromEntries(
    CHOOSABLE_KINDS.map((k) => [`owner-${k}`, overrides[k] ?? DEFAULT_HR_OWNERS[k]]),
  );

describe("hazard HZ-133 the HR platform link page and who may act on it (slice 90)", () => {
  it.each([
    [["integrations.hr_link.read"], true],
    [["integrations.hr_link.review"], true],
    [["integrations.hr_link.manage"], true],
    [["scheduling.rota.read"], false],
    [[], false],
  ] as const)("shows the page to %j: %s", (permissions, shown) => {
    expect(hrLinkShown(permissions)).toBe(shown);
  });

  it("puts it in the menu only once the organisation has turned the link on", () => {
    const permissions = ["integrations.hr_link.read"];
    expect(hrLinkNavShown({ permissions, flags: { "integrations.thapsus_hr": true } })).toBe(true);
    expect(hrLinkNavShown({ permissions, flags: { "integrations.thapsus_hr": false } })).toBe(
      false,
    );
    expect(hrLinkNavShown({ permissions, flags: {} })).toBe(false);
    expect(hrLinkNavShown({ permissions: [], flags: { "integrations.thapsus_hr": true } })).toBe(
      false,
    );
  });

  it.each([
    [["integrations.hr_link.read"], { manage: false, review: false, payCodes: false }],
    [["integrations.hr_link.review"], { manage: false, review: true, payCodes: false }],
    [["integrations.hr_link.manage"], { manage: true, review: false, payCodes: false }],
    [
      ["integrations.hr_link.manage", "integrations.hr_link.review", "scheduling.pay.approve"],
      { manage: true, review: true, payCodes: true },
    ],
    [["scheduling.pay.approve"], { manage: false, review: false, payCodes: false }],
  ] as const)("lets %j do %o", (permissions, may) => {
    expect(hrLinkMay(permissions)).toEqual(may);
  });
});

describe("connecting (rule 1)", () => {
  it.each([
    [{ workspaceSlug: "sunrise-care" }, { workspaceSlug: "sunrise-care", secretRef: null }],
    [{ workspaceSlug: "  Sunrise-Care " }, { workspaceSlug: "sunrise-care", secretRef: null }],
    [
      {
        workspaceSlug: "sunrise-care",
        secretRef: `projects/harbour-test-79/locations/europe-west2/secrets/harbour_int_${TENANT}_thapsus-hr`,
      },
      {
        workspaceSlug: "sunrise-care",
        secretRef: `projects/harbour-test-79/locations/europe-west2/secrets/harbour_int_${TENANT}_thapsus-hr`,
      },
    ],
  ])("takes %o", (values, body) => {
    expect(readConnect(form(values), t)).toEqual({ ok: true, body });
  });

  it.each([
    [{ workspaceSlug: "" }, "workspaceSlug"],
    [{ workspaceSlug: "sunrise care" }, "workspaceSlug"],
    [{ workspaceSlug: "https://sunrise.example.invalid" }, "workspaceSlug"],
    [{ workspaceSlug: "sunrise-care", secretRef: "my-secret" }, "secretRef"],
    [
      {
        workspaceSlug: "sunrise-care",
        secretRef: "projects/harbour-test-79/locations/europe-west2/secrets/harbour_sso_x_key",
      },
      "secretRef",
    ],
  ])("refuses %o at %s", (values, field) => {
    const read = readConnect(form(values), t);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(Object.keys(read.errors)).toEqual([field]);
  });
});

describe("hazard HZ-133 owners and the staleness limit (rules 2 and 9)", () => {
  it("keeps the fixed owners this product's whatever the form says", () => {
    expect(FIXED_KINDS).toEqual([
      "care_shifts",
      "clocking",
      "recruitment_and_vetting",
      "training_and_competence",
    ]);
    const read = readSettings(
      form({
        ...owners({ leavers: "harbour" }),
        stalenessMinutes: "20",
        "owner-care_shifts": "thapsus_hr",
      }),
      t,
    );
    expect(read).toEqual({
      ok: true,
      owners: { ...DEFAULT_HR_OWNERS, leavers: "harbour" },
      stalenessMinutes: 20,
    });
  });

  it.each([
    ["9", false],
    ["10", true],
    ["60", true],
    ["61", false],
    ["15.5", false],
    ["", false],
    ["ten", false],
  ])("takes a limit of %s minutes: %s", (minutes, ok) => {
    const read = readSettings(form({ ...owners(), stalenessMinutes: minutes }), t);
    expect(read.ok).toBe(ok);
    if (!read.ok) {
      expect(read.errors).toEqual({
        stalenessMinutes: "Enter a whole number of minutes from 10 to 60.",
      });
    }
  });

  it("asks for an owner for each kind the organisation chooses", () => {
    const values = owners();
    delete values["owner-leavers"];
    const read = readSettings(form({ ...values, stalenessMinutes: "15" }), t);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(Object.keys(read.errors)).toEqual(["owner-leavers"]);
  });
});

describe("hazard HZ-140 pay through the HR platform (rules 11 and 12)", () => {
  it("lists every unit kind the pay calculation gives, each one the API takes", () => {
    expect(PAY_UNIT_KINDS).toHaveLength(19);
    expect(new Set(PAY_UNIT_KINDS).size).toBe(19);
    expect(PAY_UNIT_KINDS.slice(0, 2)).toEqual(["hours", "hours_bank_holiday"]);
    expect(PAY_UNIT_KINDS).toContain("hours_night_weekend");
    expect(PAY_UNIT_KINDS).toContain("hours_bank_holiday_night_overtime_weekend");
    expect(PAY_UNIT_KINDS.slice(-3)).toEqual(["sleep_in", "on_call", "mileage"]);
    for (const kind of PAY_UNIT_KINDS) expect(PAY_UNIT_KIND.test(kind), kind).toBe(true);
  });

  it.each([
    ["hours", []],
    ["hours_night", ["night"]],
    ["hours_bank_holiday_weekend", ["bank_holiday", "weekend"]],
    ["sleep_in", null],
    ["hours_night_night", null],
    ["hours_holiday", null],
  ] as const)("reads the enhancements in %s", (kind, want) => {
    expect(enhancementsOf(kind)).toEqual(want);
  });

  it.each([
    ["hours", "Hours"],
    ["hours_night", "Hours: night"],
    ["hours_night_weekend", "Hours: night and weekend"],
    ["hours_bank_holiday_night_overtime", "Hours: bank holiday, night and overtime"],
    ["sleep_in", "Sleep-ins"],
    ["on_call", "On-call periods away"],
    ["mileage", "Miles"],
  ])("says %s as %s", (kind, words) => {
    expect(unitKindWords(kind, t)).toBe(words);
  });

  it("takes well-formed pay codes, leaves blank kinds unmapped and refuses others at their field", () => {
    expect(
      readPayCodes(
        form({ [payCodeField("hours")]: " BASIC ", [payCodeField("sleep_in")]: "SLEEP.1" }),
        t,
      ),
    ).toEqual({ ok: true, codes: { hours: "BASIC", sleep_in: "SLEEP.1" } });
    const bad = readPayCodes(form({ [payCodeField("mileage")]: "MILES 45p" }), t);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors)).toEqual(["code-mileage"]);
    expect(unmappedKinds({ hours: "BASIC" })).toHaveLength(18);
  });

  it("takes a route and the first day it applies from, as dd/mm/yyyy boxes", () => {
    expect(
      readPayRoute(
        form({ route: "thapsus_hr", "from-day": "2", "from-month": "11", "from-year": "2026" }),
        t,
      ),
    ).toEqual({ ok: true, route: "thapsus_hr", from: "2026-11-02" });
    const missing = readPayRoute(
      form({ "from-day": "31", "from-month": "2", "from-year": "2027" }),
      t,
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(Object.keys(missing.errors).sort()).toEqual(["from", "route"]);
  });

  it("says a pay run is paid through the HR platform only when its route is", () => {
    expect(paidThroughHrPlatform({ payRoute: "thapsus_hr" })).toBe(true);
    expect(paidThroughHrPlatform({ payRoute: "harbour_export" })).toBe(false);
    expect(paidThroughHrPlatform({ payRoute: null })).toBe(false);
  });
});

describe("hazard HZ-133 managed in the HR platform (rule 2)", () => {
  it("marks only copies from the HR platform", () => {
    expect(fromHrPlatform({ source: "thapsus_hr" })).toBe(true);
    expect(fromHrPlatform({ source: "harbour" })).toBe(false);
  });

  it("says the API's refusal in plain words, never naming the other product", () => {
    const p = hrLinkProblem({ code: "managed_in_thapsus_hr" }, "settings", t);
    expect(p.message).toBe(
      "Managed in the HR platform. Change it there; Thapsus Care follows at the next sync.",
    );
    expect(withoutProductName(p.message)).not.toMatch(/thapsus/i);
  });
});

describe("hazard HZ-133 locations, matches and releases", () => {
  it("maps a home only to a location the HR platform listed, or clears it", () => {
    const offered = new Set(["loc_main"]);
    expect(readLocationMap(form({ hrLocationId: "loc_main" }), offered, t)).toEqual({
      ok: true,
      hrLocationId: "loc_main",
    });
    expect(readLocationMap(form({ hrLocationId: "" }), offered, t)).toEqual({
      ok: true,
      hrLocationId: null,
    });
    expect(readLocationMap(form({ hrLocationId: "loc_other" }), offered, t).ok).toBe(false);
  });

  it("lists leavers first, keeping the API's order otherwise", () => {
    const items = [
      { id: "a", leavingOn: null },
      { id: "b", leavingOn: "2026-11-30" },
      { id: "c", leavingOn: null },
    ];
    expect(leaversFirst(items).map((m) => m.id)).toEqual(["b", "a", "c"]);
  });

  it.each([
    ["drift", "checked_in_hr_platform", true],
    ["drift", "link_ended", false],
    ["disconnected", "link_ended", true],
    ["disconnected", "checked_in_hr_platform", false],
    ["disconnected", "other_recorded_in_review", true],
  ] as const)("in a %s release takes the reason %s: %s", (mode, reason, ok) => {
    expect(readRelease(form({ reason, checked: "yes" }), mode, t).ok).toBe(ok);
  });

  it("releases nothing until the person says they checked the copies", () => {
    const read = readRelease(form({ reason: "checked_in_hr_platform" }), "drift", t);
    expect(read).toEqual({
      ok: false,
      errors: { checked: "Confirm you have checked the absences." },
    });
  });

  it.each([
    ["hr_link_drift_changed", "release", undefined],
    ["hr_link_not_uk", "connect", "workspaceSlug"],
    ["not_hr_pay_period_start", "payRoute", "from"],
    ["hr_link_pay_not_available", "payRoute", "route"],
    ["version_conflict", "location", "hrLocationId"],
    ["hr_link_own_file", "match", "staffProfileId"],
  ] as const)("says %s in the catalogue's words at its field", (code, where, field) => {
    for (const detail of [
      "Thapsus-HR said no.",
      "Thapsus\u2013HR said no.",
      "Thapsus\u00a0HR said no.",
      "Thapsus Human Resources said no.",
      "Thapsus said no.",
    ]) {
      const leaked = hrLinkProblem({ code, detail }, where, t);
      expect(withoutProductName(leaked.message)).not.toMatch(/thapsus/i);
    }
    const p = hrLinkProblem({ code, detail: "Thapsus-HR said no." }, where, t);
    expect(p.code).toBe(code);
    expect(withoutProductName(p.message)).not.toMatch(/thapsus/i);
    expect(p.fields ? Object.keys(p.fields) : []).toEqual(field ? [field] : []);
  });
});

describe("states in words with an icon, never colour alone", () => {
  it.each([
    [{ connected: true, status: "connected" }, "Connected", "circle-check"],
    [{ connected: false, status: "disconnected" }, "Disconnected", "circle-minus"],
    [{ connected: false, status: null }, "Not linked", "circle-minus"],
  ])("link %o", (status, label, icon) => {
    expect(linkChip(status, t)).toMatchObject({ label, icon });
  });

  it.each([
    [null, "Not synced yet", "clock"],
    [{ stale: false, lastGoodSyncAt: null }, "Not synced yet", "clock"],
    [{ stale: true, lastGoodSyncAt: "2026-11-07T09:00:00Z" }, "May be out of date", "clock"],
    [{ stale: false, lastGoodSyncAt: "2026-11-07T09:00:00Z" }, "Up to date", "circle-check"],
  ])("sync %o", (staleness, label, icon) => {
    expect(syncChip(staleness, t)).toMatchObject({ label, icon });
  });

  it.each([
    ["sent", "Sent", "done"],
    ["pending", "Waiting to send", "info"],
    ["failed", "Failed", "overdue"],
    ["refused", "Refused", "overdue"],
    ["mystery", "Not known", "neutral"],
  ])("delivery %s", (state, label, status) => {
    expect(deliveryChip(state, t)).toMatchObject({ label, status });
  });
});

describe("refusals carry what the API knows", () => {
  it("says how many copies are waiting now when the list changed", () => {
    const p = hrLinkProblem(
      {
        code: "hr_link_drift_changed",
        detail: "The absences to release have changed (7 now). Check them again.",
      },
      "release",
      t,
    );
    expect(p.message).toBe(
      "The absence copies to release have changed since you checked them, so nothing was released. 7 copies are waiting now. Check the list again.",
    );
    expect(heldNow({ detail: "no count" })).toBeNull();
  });

  it("says the limit's range from the same figures the form checks", () => {
    expect(hrLinkProblem({ code: "invalid" }, "settings", t).message).toContain(
      "from 10 to 60 minutes",
    );
  });

  it("says the HR platform asked for fewer requests in plain words", () => {
    expect(hrLinkProblem({ code: "rate_limited" }, "release", t).message).toBe(
      "The HR platform has been asked too often just now. Wait a minute, then try again.",
    );
  });
});

describe("the server actions check what reaches them", () => {
  it.each([
    [{ workspaceSlug: "sunrise-care", secretRef: null }, true],
    [{ workspaceSlug: "Sunrise", secretRef: null }, false],
    [{ workspaceSlug: "sunrise-care", secretRef: "x" }, false],
    [{ workspaceSlug: "sunrise-care", secretRef: null, apiBaseUrl: "https://x" }, false],
    [null, false],
  ])("connect %o: %s", (body, ok) => {
    expect(validConnect(body)).toBe(ok);
  });

  it("takes owners only with every kind and the fixed ones this product's", () => {
    expect(validOwners(DEFAULT_HR_OWNERS)).toBe(true);
    expect(validOwners({ ...DEFAULT_HR_OWNERS, care_shifts: "thapsus_hr" })).toBe(false);
    expect(validOwners({ ...DEFAULT_HR_OWNERS, leavers: "elsewhere" })).toBe(false);
    expect(validOwners({ ...DEFAULT_HR_OWNERS, extra: "harbour" })).toBe(false);
  });

  it.each([
    [validStaleness(10), true],
    [validStaleness(61), false],
    [validStaleness(12.5), false],
    [validPayRoute("thapsus_hr", "2026-11-30"), true],
    [validPayRoute("elsewhere", "2026-11-30"), false],
    [validPayRoute("thapsus_hr", "30/11/2026"), false],
    [validPayCodes({ hours: "BASIC" }), true],
    [validPayCodes({ wages: "BASIC" }), false],
    [validPayCodes({ hours: "BASIC PAY" }), false],
    [validReleaseReason("link_ended"), true],
    [validReleaseReason("because"), false],
    [validVersion(0), true],
    [validVersion(-1), false],
  ])("check %#: %s", (got, want) => {
    expect(got).toBe(want);
  });
});

describe("hazard HZ-140 a period for the HR platform while the link is down", () => {
  it("says what to do instead of a generic error", () => {
    expect(problemMessage({ code: "hr_link_down_for_pay", detail: "Thapsus" }, t)).toEqual({
      code: "hr_link_down_for_pay",
      message:
        "This period is set to be paid through the HR platform, but the link is off or disconnected. Wait for the link, or confirm this period goes to the payroll export instead.",
    });
  });

  it("tells a pay manager who does not approve pay who can send it to the export", () => {
    const refused = { ok: false as const, code: "missing_permission", message: "x" };
    expect(confirmExportRefusal(refused, t).message).toBe(
      "Only someone who approves pay can send this period to the payroll export instead. Ask a pay approver, or wait for the link.",
    );
    const stepUp = { ok: false as const, code: "step_up_required", message: "y" };
    expect(confirmExportRefusal(stepUp, t)).toBe(stepUp);
    const done = { ok: true as const, data: { id: "x" } };
    expect(confirmExportRefusal(done, t)).toBe(done);
  });
});
