import { expect, test } from "@playwright/test";
import { expectAccessible, MEWS_PERSON, signIn } from "./support";

/**
 * Hazard HZ-011, HZ-073 (ADR-0071 review round 2, C2-M2): a record opened by break-glass is for
 * reading only, so the screens offer no form to record in and say so in words. The demo manager
 * works at Harbour House; Una Example lives at Harbour Mews (apps/api/scripts/seed-users.ts).
 */

const READ_ONLY =
  "You opened this record for reading only. To record something, tell the nurse in charge at this home, or record it on paper and enter it when you have access.";

test("a record opened by break-glass offers no form to record in", async ({ page }) => {
  await signIn(page, "manager@example.invalid");

  await page.goto(`/people/${MEWS_PERSON}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "We could not find that." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open a record outside your access" }).click();
  const sheet = page.getByRole("dialog", { name: "Open a record outside your access" });
  await expect(sheet.getByText("The record opens for reading only")).toBeVisible();
  await sheet
    .getByLabel("Reason")
    .fill("Covering an emergency at Harbour Mews tonight while its manager is away");
  await sheet.getByRole("button", { name: "Open record" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /Una/ })).toBeVisible();

  for (const [tab, form] of [
    ["notes", "Write a note"],
    ["charts", /^Record /],
    ["body-map", "Record a mark"],
  ] as const) {
    await page.goto(`/people/${MEWS_PERSON}/${tab}`);
    await expect(page.getByText(READ_ONLY)).toBeVisible();
    await expect(page.getByRole("region", { name: form })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Save/ })).toHaveCount(0);
  }
  await expectAccessible(page, "break-glass record, read only");
});
