import { describe, expect, it } from "vitest";
import { t } from "./i18n";

/**
 * Clinical words the slice 83 guides review changed, pinned so a later edit cannot soften them
 * (HZ-013, HZ-127). The screens show these keys as they are.
 */
describe("clinical copy (slice 83 guides review)", () => {
  it("hazard HZ-013 the missing person prompt says a CQC notification is needed and how to settle it", () => {
    const words = t("missing.notifications.cqcPrompt");
    expect(words).toContain("is needed without delay");
    expect(words).not.toMatch(/\bmay be needed\b/);
    expect(words).toContain(
      "Complete it, or record why it is not needed, in the notification centre",
    );
  });

  it("hazard HZ-013 the death hint names 999 and the police for a sudden death and never says the home cannot contact the coroner", () => {
    const words = t("people.exit.death.expectedHint");
    expect(words).toContain("999 and the police");
    expect(words).toContain("anyone worried about how a person died can contact the coroner");
    expect(words).not.toMatch(/does not refer/);
  });
});
