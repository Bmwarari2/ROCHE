import { describe, expect, it } from "vitest";
import {
  checkDraft,
  dpiaChip,
  dpiaShown,
  maySign,
  prefillOf,
  readDraft,
  readSettings,
} from "./dpia";
import { t } from "./i18n";
import { problemMessage } from "./outcome";

const form = (values: Record<string, string>) => ({ get: (name: string) => values[name] ?? null });

describe("the DPIA page", () => {
  it.each([
    [["platform.dpia.read"], true],
    [["platform.dpia.sign"], true],
    [["platform.export.create"], false],
  ] as const)("shows the page to %j: %s", (permissions, shown) => {
    expect(dpiaShown(permissions)).toBe(shown);
  });

  it.each([
    ["signed", "done", "Signed"],
    ["review_due", "overdue", "Review due"],
    ["prepared", "due", "Ready to sign"],
    ["something_new", "overdue", "Unknown: check with Harbour support"],
  ])(
    "says %s as an icon and a word, warning for a state it does not know",
    (state, status, label) => {
      expect(dpiaChip(state, t)).toMatchObject({ status, label });
    },
  );

  it("reads the answers and ratings the prefill asks for, and nothing else", () => {
    const prefill = prefillOf({
      sections: [
        { key: "context", title: "Context", tenantFields: ["prior_concerns"] },
        { key: "scope", title: "Scope", tenantFields: [] },
      ],
      risks: [
        { id: "R1", risk: "Unauthorised access" },
        { id: "R2", risk: "Device loss" },
      ],
    });
    const draft = readDraft(
      form({
        "answer.context.prior_concerns": "  None raised  ",
        "answer.scope.extra": "ignored",
        "risk.R1": "low",
        "risk.R2": "severe",
        icoReference: "",
      }),
      prefill,
    );
    expect(draft).toEqual({
      answers: { context: { prior_concerns: "None raised" } },
      residualRisk: { R1: "low", R2: null },
      icoReference: null,
    });
  });

  it("checks the governance settings with the API's own schema", () => {
    const read = readSettings(
      form({
        leadId: "0194d000-0000-7000-8000-000000000301",
        dpoEmail: "not an address",
        privacyNoticeUrl: "http://example.invalid/privacy",
        usesDataBeyondDirectCare: "no",
      }),
      { expectedVersion: 3, dpaSignedOn: null },
      t,
    );
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(Object.keys(read.fields).sort()).toEqual(["dpoEmail", "privacyNoticeUrl"]);
    }
    const good = readSettings(
      form({ sector: "public", usesDataBeyondDirectCare: "yes", marketingEnabled: "on" }),
      { expectedVersion: 3, dpaSignedOn: "2026-09-01" },
      t,
    );
    expect(good).toMatchObject({
      ok: true,
      value: {
        leadId: null,
        sector: "public",
        usesDataBeyondDirectCare: true,
        marketingEnabled: true,
        aiFreeTextEnabled: false,
        dpaSignedOn: "2026-09-01",
        expectedVersion: 3,
      },
    });
  });

  it("says a refused signature in the API's own words, every problem at once", () => {
    const detail =
      "Only the data protection lead can sign the DPIA. Some sections still need your answers.";
    expect(problemMessage({ code: "dpia_not_signable", detail }, t)).toEqual({
      code: "dpia_not_signable",
      message: detail,
    });
  });

  const LEAD = "0194d000-0000-7000-8000-000000000301";
  const OTHER = "0194d000-0000-7000-8000-000000000302";
  it.each([
    [
      "the named lead, who prepared none of it",
      "prepared",
      LEAD,
      [OTHER],
      ["platform.dpia.sign"],
      true,
    ],
    ["someone other than the lead", "prepared", OTHER, [LEAD], ["platform.dpia.sign"], false],
    ["the lead, who helped prepare it", "prepared", LEAD, [LEAD], ["platform.dpia.sign"], false],
    ["the lead, without the sign permission", "prepared", LEAD, [OTHER], [], false],
    ["the lead, before it is ready", "draft", LEAD, [OTHER], ["platform.dpia.sign"], false],
  ] as const)(
    "offers the signature to %s: %s",
    (_, status, me, preparers, permissions, offered) => {
      expect(
        maySign({ status, preparedBy: preparers.map((id) => ({ id })) }, LEAD, me, permissions),
      ).toBe(offered);
    },
  );

  it("asks for the ICO reference when a risk stays high", () => {
    const draft = (level: "low" | "high", ico: string | null) => ({
      answers: {},
      residualRisk: { R1: level },
      icoReference: ico,
    });
    expect(checkDraft(draft("high", null), t)).toEqual({
      icoReference: t("dpia.draft.icoRequired"),
    });
    expect(checkDraft(draft("high", "ICO-0001"), t)).toEqual({});
    expect(checkDraft(draft("low", null), t)).toEqual({});
  });
});
