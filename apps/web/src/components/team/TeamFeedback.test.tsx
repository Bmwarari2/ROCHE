// @vitest-environment jsdom
import axe from "axe-core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ManageFeedback } from "@/components/safety/ManageForms";
import { t } from "@/lib/i18n";

/**
 * The team forms' step-up state (section 5.3), which the journey cannot reach (its sign-in is
 * always fresh): inviting, sending again and withdrawing each need a recent sign-in with a used
 * factor (#63), so a lapsed one shows the notice with the way back to the same page, in words
 * that name the passkey and the authenticator code, checked with axe-core.
 */
const refusal = { ok: false as const, code: "step_up_required", message: "" };

async function violations() {
  const results = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  return results.violations.map((v) => v.id);
}

describe("the team forms after the step-up window lapses", () => {
  it.each([
    ["the invite form", "/settings/team", "team.stepUp.form", "before you invite someone"],
    [
      "an invitation action",
      "/settings/team/0194d000-0000-7000-8000-000000000304",
      "team.stepUp.action",
      "before you change an invitation",
    ],
  ] as const)(
    "%s says how to confirm it is you and links back, accessibly",
    async (_, path, key, words) => {
      document.body.innerHTML = `<main><h1>Team</h1>${renderToStaticMarkup(
        <ManageFeedback result={refusal} path={path} stepUp={t(key)} />,
      )}</main>`;
      const alert = document.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("passkey or a code from your authenticator app");
      expect(alert?.textContent).toContain(words);
      const link = alert?.querySelector("a");
      expect(link?.textContent).toBe("Sign in again");
      const href = new URL(link?.getAttribute("href") ?? "", "https://harbour.example.invalid");
      expect(href.pathname).toBe("/sign-in");
      expect(href.searchParams.get("reason")).toBe("step-up");
      expect(href.searchParams.get("next")).toBe(path);
      expect(await violations()).toEqual([]);
    },
  );

  it("says a team refusal in words at the summary, accessibly", async () => {
    const result = {
      ok: false as const,
      code: "member_mfa_not_required",
      message: t("team.refusal", { code: "member_mfa_not_required" }),
    };
    document.body.innerHTML = `<main><h1>Team</h1>${renderToStaticMarkup(
      <ManageFeedback result={result} path="/settings/team" />,
    )}</main>`;
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "has not been asked to use a passkey or authenticator code",
    );
    expect(await violations()).toEqual([]);
  });
});
