// @vitest-environment jsdom
import axe from "axe-core";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { t } from "@/lib/i18n";
import { PasswordField } from "./PasswordField";

afterEach(() => {
  document.body.innerHTML = "";
});

function draw(error?: string) {
  document.body.innerHTML = `<main>${renderToStaticMarkup(
    <PasswordField
      id="new-password"
      name="password"
      label={t("invitation.form.password")}
      hint={t("invitation.password.hint")}
      error={error}
    />,
  )}</main>`;
}

describe("PasswordField", () => {
  it("hides the password, and its button says what it does and which field it controls", () => {
    draw();
    const input = document.querySelector("input");
    expect(input?.type).toBe("password");
    expect(input?.autocomplete).toBe("new-password");
    const button = document.querySelector("button");
    expect(button?.textContent).toBe(t("security.password.show"));
    expect(button?.getAttribute("aria-controls")).toBe("new-password");
    expect(button?.type).toBe("button");
    expect(document.querySelector('[role="status"]')).not.toBeNull();
  });

  it("ties the rules and the error to the field", () => {
    draw(t("invitation.password.rule", { rule: "too_short" }));
    const input = document.querySelector("input");
    const described = input?.getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(described).toHaveLength(2);
    expect(input?.getAttribute("aria-invalid")).toBe("true");
  });

  it.each([undefined, t("invitation.form.passwordRequired")])(
    "passes axe (error %s)",
    async (error) => {
      draw(error);
      const results = await axe.run(document.body, {
        rules: { "color-contrast": { enabled: false } },
      });
      expect(results.violations.map((v) => v.id)).toEqual([]);
    },
  );
});
