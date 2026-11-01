/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tablePlatformRates } from "../../test/rate-table";
import { type EffectiveAccess, resolveAccess } from "./access";
import type { FlagKey } from "./feature-flags";
import { builtinRole } from "./roles";
import {
  type AiProvider,
  checkNoticeResponse,
  checkNoticeTiming,
  mayProcessTenantData,
  type NoticeResponse,
  type NoticeState,
  noticeResponseFrom,
  noticeStateFor,
  objectionWindowEndsAt,
  type StoredNoticeResponse,
  SUB_PROCESSORS,
  type SubProcessorConfig,
  type SubProcessorKey,
  type SubProcessorNotice,
  subProcessorAcknowledgementsFrom,
  subProcessorsInUse,
} from "./sub-processors";

const RATES = tablePlatformRates();
const REGISTER = fileURLToPath(
  new URL("../../../../docs/compliance/sub-processors.md", import.meta.url),
);
const PAST = new Date("2026-01-01T00:00:00Z");
const ANNOUNCED = new Date("2026-10-11T09:00:00Z");
const WINDOW_END = objectionWindowEndsAt({ announcedAt: ANNOUNCED }, RATES);
const DAY = 86_400_000;

function accessFor(roleKey: string): EffectiveAccess {
  const role = builtinRole(roleKey);
  if (!role) throw new Error(roleKey);
  return resolveAccess(
    [
      {
        roleKey,
        scopeKind: role.scopeKind,
        permissions: role.permissions,
        locationId: null,
        organisationWide: true,
        validFrom: PAST,
        validTo: null,
      },
    ],
    [],
    ANNOUNCED,
  );
}

const config = (
  features: FlagKey[] = [],
  capabilities: Partial<SubProcessorConfig["capabilities"]> = {},
  aiProvider: AiProvider | null = null,
): SubProcessorConfig => ({
  features,
  capabilities: { mobilePush: false, sms: false, ...capabilities },
  aiProvider,
});

describe("sub-processor register", () => {
  it("names only sub-processors listed in the compliance register", () => {
    const register = readFileSync(REGISTER, "utf8");
    for (const [key, sp] of Object.entries(SUB_PROCESSORS)) {
      expect(register, key).toContain(sp.name);
    }
  });

  it("hosts in Google Cloud London and names no email provider until one is chosen (ADR-0098, H-08)", () => {
    expect(SUB_PROCESSORS.gcp_hosting).toMatchObject({
      name: "Google Cloud EMEA Limited",
      location: "Google Cloud europe-west2 (London)",
      outsideUk: false,
    });
    const services = Object.values(SUB_PROCESSORS).map((sp) => sp.service);
    expect(services.some((s) => /\bSES\b|Simple Email Service/.test(s))).toBe(false);
  });

  it.each<[string, SubProcessorConfig, SubProcessorKey[]]>([
    ["a tenant with no options", config(), ["gcp_hosting", "sentry", "grafana"]],
    [
      "with mobile push",
      config([], { mobilePush: true }),
      ["gcp_hosting", "sentry", "grafana", "expo_push", "apns_fcm"],
    ],
    ["with SMS", config([], { sms: true }), ["gcp_hosting", "sentry", "grafana", "uk_sms_gateway"]],
    [
      "with AI through Bedrock London",
      config(["module.ai"], {}, "bedrock_london"),
      ["gcp_hosting", "sentry", "grafana", "bedrock_london"],
    ],
    [
      "with AI through the Anthropic API",
      config(["module.ai"], {}, "anthropic"),
      ["gcp_hosting", "sentry", "grafana", "anthropic"],
    ],
    [
      "with AI on the tenant's own key",
      config(["module.ai"], {}, "tenant_own"),
      ["gcp_hosting", "sentry", "grafana"],
    ],
    [
      "with a provider chosen but the AI module off",
      config([], {}, "bedrock_eu"),
      ["gcp_hosting", "sentry", "grafana"],
    ],
  ])("in use for %s", (_label, input, expected) => {
    expect(subProcessorsInUse(input)).toEqual(expected);
  });
});

describe("sub-processor change notices", () => {
  const notice = (extra: Partial<SubProcessorNotice> = {}): SubProcessorNotice => ({
    id: "notice-1",
    subProcessorKey: "uk_sms_gateway",
    kind: "new",
    use: { kind: "capability", capability: "sms" },
    announcedAt: ANNOUNCED,
    effectiveFrom: WINDOW_END,
    ...extra,
  });
  const smsTenant = config([], { sms: true });
  const none: NoticeResponse = { acknowledgedAt: null, objection: null };
  const objected = (resolution: NoticeResponse["objection"] = null): NoticeResponse => ({
    acknowledgedAt: null,
    objection: resolution ?? {
      at: ANNOUNCED,
      grounds: "The provider stores data outside the UK.",
      resolvedAt: null,
      resolution: null,
    },
  });

  it("gives the rate-table notice in UK calendar days, keeping the wall-clock time across the clock change", () => {
    expect(RATES.subProcessorNoticeDays).toBeGreaterThan(0);
    // 10:00 BST on 11 October becomes 10:00 GMT, an hour later in UTC than a plain day count.
    expect(WINDOW_END.getTime() - ANNOUNCED.getTime()).toBe(
      RATES.subProcessorNoticeDays * DAY + 3_600_000,
    );
  });

  it.each<[string, Date, number[], boolean]>([
    ["taking effect when the window ends", WINDOW_END, [RATES.subProcessorNoticeDays], true],
    [
      "taking effect a day early",
      new Date(WINDOW_END.getTime() - DAY),
      [RATES.subProcessorNoticeDays],
      false,
    ],
    [
      "with one tenant on a longer contractual notice",
      WINDOW_END,
      [RATES.subProcessorNoticeDays, RATES.subProcessorNoticeDays * 2],
      false,
    ],
    ["affecting no tenant", ANNOUNCED, [], true],
  ])("timing check: %s", (_label, effectiveFrom, days, ok) => {
    const result = checkNoticeTiming({ announcedAt: ANNOUNCED, effectiveFrom }, days);
    expect(result.ok).toBe(ok);
    if (!result.ok) {
      expect(result.earliestEffectiveFrom.getTime()).toBe(
        objectionWindowEndsAt(
          { announcedAt: ANNOUNCED },
          { subProcessorNoticeDays: Math.max(...days) },
        ).getTime(),
      );
    }
  });

  it.each<[string, SubProcessorConfig, NoticeResponse, Date, NoticeState]>([
    ["a tenant that does not use SMS", config(), none, ANNOUNCED, "not_applicable"],
    [
      "no answer while the window is open",
      smsTenant,
      none,
      new Date(ANNOUNCED.getTime() + DAY),
      "awaiting_response",
    ],
    ["no answer after the window", smsTenant, none, WINDOW_END, "deemed_accepted"],
    [
      "acknowledged",
      smsTenant,
      { acknowledgedAt: ANNOUNCED, objection: null },
      ANNOUNCED,
      "acknowledged",
    ],
    ["an open objection", smsTenant, objected(), WINDOW_END, "objected"],
    [
      "a resolved objection",
      smsTenant,
      objected({
        at: ANNOUNCED,
        grounds: "x",
        resolvedAt: WINDOW_END,
        resolution: "not_used_for_tenant",
      }),
      WINDOW_END,
      "objection_resolved",
    ],
  ])("state with %s", (_label, input, response, now, state) => {
    expect(noticeStateFor(notice(), response, input, now, RATES)).toBe(state);
  });

  it.each<[string, Partial<SubProcessorNotice>, NoticeResponse, Date, boolean]>([
    ["before it takes effect", {}, none, new Date(WINDOW_END.getTime() - DAY), false],
    [
      "announced to take effect before this tenant's window ends",
      { effectiveFrom: ANNOUNCED },
      none,
      new Date(WINDOW_END.getTime() - DAY),
      false,
    ],
    ["after the window with no objection", {}, none, WINDOW_END, true],
    ["while an objection is open", {}, objected(), WINDOW_END, false],
    [
      "after the tenant withdrew its objection",
      {},
      objected({
        at: ANNOUNCED,
        grounds: "x",
        resolvedAt: WINDOW_END,
        resolution: "objection_withdrawn",
      }),
      WINDOW_END,
      true,
    ],
    [
      "after Thapsus agreed not to use it for the tenant",
      {},
      objected({
        at: ANNOUNCED,
        grounds: "x",
        resolvedAt: WINDOW_END,
        resolution: "not_used_for_tenant",
      }),
      WINDOW_END,
      false,
    ],
    [
      "after the tenant ended the affected services",
      {},
      objected({
        at: ANNOUNCED,
        grounds: "x",
        resolvedAt: WINDOW_END,
        resolution: "services_ended",
      }),
      WINDOW_END,
      false,
    ],
  ])("may process the tenant's data %s: %s", (_label, extra, response, now, allowed) => {
    expect(mayProcessTenantData(notice(extra), response, now, RATES)).toBe(allowed);
  });

  const grounds = "Messages would leave the UK, which our contract with the council forbids.";
  it.each<
    [
      string,
      "acknowledge" | "object",
      string,
      SubProcessorConfig,
      NoticeResponse,
      Date,
      string | undefined,
      string | null,
    ]
  >([
    [
      "the quality lead acknowledges",
      "acknowledge",
      "quality_lead",
      smsTenant,
      none,
      ANNOUNCED,
      undefined,
      null,
    ],
    [
      "the owner acknowledges after the window",
      "acknowledge",
      "owner",
      smsTenant,
      none,
      WINDOW_END,
      undefined,
      null,
    ],
    [
      "the quality lead objects in time with grounds",
      "object",
      "quality_lead",
      smsTenant,
      none,
      ANNOUNCED,
      grounds,
      null,
    ],
    [
      "a Registered Manager cannot answer",
      "acknowledge",
      "registered_manager",
      smsTenant,
      none,
      ANNOUNCED,
      undefined,
      "missing_permission",
    ],
    [
      "a notice that does not apply",
      "object",
      "owner",
      config(),
      none,
      ANNOUNCED,
      grounds,
      "not_applicable",
    ],
    [
      "an objection after the window",
      "object",
      "owner",
      smsTenant,
      none,
      WINDOW_END,
      grounds,
      "window_closed",
    ],
    [
      "an objection without grounds",
      "object",
      "owner",
      smsTenant,
      none,
      ANNOUNCED,
      "  no ",
      "grounds_required",
    ],
    [
      "an objection with no grounds field",
      "object",
      "owner",
      smsTenant,
      none,
      ANNOUNCED,
      undefined,
      "grounds_required",
    ],
    [
      "a second objection",
      "object",
      "owner",
      smsTenant,
      objected(),
      ANNOUNCED,
      grounds,
      "already_objected",
    ],
  ])("%s", (_label, kind, role, input, response, now, text, problem) => {
    const result = checkNoticeResponse({
      kind,
      notice: notice(),
      response,
      config: input,
      access: accessFor(role),
      actorTenantUserId: "u-1",
      designatedLeadIds: ["u-1"],
      stepUpAt: new Date(now.getTime() - 60_000),
      stepUpWindowSeconds: 600,
      ...(text === undefined ? {} : { grounds: text }),
      now,
      rates: RATES,
    });
    if (problem === null) expect(result).toEqual({ ok: true });
    else expect(result).toMatchObject({ ok: false, problem });
  });

  it.each<[string, string, Date | null, string]>([
    [
      "the quality lead when someone else is the named lead",
      "u-2",
      ANNOUNCED,
      "not_designated_lead",
    ],
    [
      "the named lead with an old MFA sign-in",
      "u-1",
      new Date(ANNOUNCED.getTime() - DAY),
      "step_up_required",
    ],
    ["the named lead with no MFA sign-in", "u-1", null, "step_up_required"],
  ])("refuses an answer from %s", (_label, actorTenantUserId, stepUpAt, problem) => {
    const result = checkNoticeResponse({
      kind: "acknowledge",
      notice: notice(),
      response: none,
      config: smsTenant,
      access: accessFor("quality_lead"),
      actorTenantUserId,
      designatedLeadIds: ["u-1"],
      stepUpAt,
      stepUpWindowSeconds: 600,
      now: ANNOUNCED,
      rates: RATES,
    });
    expect(result).toMatchObject({ ok: false, problem });
  });
});

describe("rules 24 and 25 responses as stored, append-only", () => {
  const at = (day: number) => new Date(Date.UTC(2026, 9, day, 9));
  const row = (
    kind: StoredNoticeResponse["kind"],
    day: number,
    extra: Partial<StoredNoticeResponse> = {},
  ): StoredNoticeResponse => ({
    subProcessorKey: "sentry",
    noticeId: "n1",
    kind,
    grounds: kind === "objected" ? "Outside the UK without our agreement" : null,
    resolution: null,
    respondedAt: at(day),
    ...extra,
  });

  it.each<[string, StoredNoticeResponse[], ReturnType<typeof noticeResponseFrom>]>([
    ["no response", [], { acknowledgedAt: null, objection: null }],
    [
      "the latest acknowledgement",
      [row("acknowledged", 2), row("acknowledged", 5), row("acknowledged", 3, { noticeId: "n2" })],
      { acknowledgedAt: at(5), objection: null },
    ],
    [
      "an open objection",
      [row("objected", 4)],
      {
        acknowledgedAt: null,
        objection: {
          at: at(4),
          grounds: "Outside the UK without our agreement",
          resolvedAt: null,
          resolution: null,
        },
      },
    ],
    [
      "an objection resolved after it was made",
      [
        row("objection_resolved", 1, { resolution: "services_ended" }),
        row("objected", 4),
        row("objection_resolved", 6, { resolution: "objection_withdrawn" }),
      ],
      {
        acknowledgedAt: null,
        objection: {
          at: at(4),
          grounds: "Outside the UK without our agreement",
          resolvedAt: at(6),
          resolution: "objection_withdrawn",
        },
      },
    ],
  ])("reads %s", (_, rows, expected) => {
    expect(noticeResponseFrom("n1", rows)).toEqual(expected);
  });

  it("gives the checklist the latest acknowledgement of each sub-processor, from any notice or the register", () => {
    expect(
      subProcessorAcknowledgementsFrom([
        row("acknowledged", 2, { noticeId: null }),
        row("acknowledged", 7),
        row("objected", 9),
        row("acknowledged", 3, { subProcessorKey: "gcp_hosting", noticeId: null }),
      ]),
    ).toEqual([
      { key: "sentry", acknowledgedAt: at(7) },
      { key: "gcp_hosting", acknowledgedAt: at(3) },
    ]);
  });
});
