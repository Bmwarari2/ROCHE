import { expect, type Locator, type Page, test } from "@playwright/test";
import { addDemoPasskey, expectAccessible, MEWS_PERSON, signIn } from "./support";

/**
 * Hazards HZ-011 and HZ-073 (ADR-0071 review rounds 2 and 3, C2-M2 and C3-M1): a record opened
 * by break-glass is for reading only, so no tab of the record offers a form to record in, and
 * each says so in words. An entry the API would refuse stores nothing: a NEWS2 or MUST run there
 * would leave no score and raise no alert. The demo manager works at Harbour House; Una Example
 * lives at Harbour Mews (apps/api/scripts/seed-users.ts).
 */

const READ_ONLY =
  "You opened this record for reading only. To record something in it, tell the person in charge of this shift or your manager, or record it on paper and enter it when you have access.";

/** Each tab of the record and the controls it offers someone who may write there. */
const TABS: readonly (readonly [string, (page: Page) => Locator[]])[] = [
  ["notes", (page) => [page.getByRole("region", { name: "Write a note" })]],
  ["charts", (page) => [page.getByRole("region", { name: /^Record / })]],
  ["body-map", (page) => [page.getByRole("region", { name: "Record a mark" })]],
  [
    "activities",
    (page) => [
      page.getByRole("region", { name: "Record an activity" }),
      page.getByRole("region", { name: "Record a visit" }),
    ],
  ],
  ["assessments", (page) => [page.getByRole("link", { name: /^Run |^Ask the falls questions$/ })]],
  [
    "care-plan",
    (page) => [
      page.getByRole("button", { name: "Start a care plan" }),
      page.getByRole("button", { name: "Start a new draft from the plan in use" }),
    ],
  ],
  ["risk-assessments", (page) => [page.getByRole("region", { name: "Add a risk assessment" })]],
  [
    "advance-care",
    (page) => [
      page.getByRole("region", {
        name: "Record a ReSPECT plan, DNACPR decision or advance care record",
      }),
    ],
  ],
];

test("hazard HZ-073 a record opened by break-glass offers no form to record in on any tab", async ({
  page,
}) => {
  // A password alone never steps up (ADR-0072 amendment, HZ-112): the manager is asked to confirm
  // with their passkey, does, and comes back to the record.
  await addDemoPasskey(page);
  await signIn(page, "manager@example.invalid");

  const openByBreakGlass = async () => {
    await page.goto(`/people/${MEWS_PERSON}`);
    await expect(
      page.getByRole("heading", { level: 1, name: "We could not find that." }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Open a record outside your access" }).click();
    const sheet = page.getByRole("dialog", { name: "Open a record outside your access" });
    await expect(sheet.getByText("The record opens for reading only")).toBeVisible();
    await sheet.getByLabel("Why you need this record").selectOption("emergency_care");
    await sheet
      .getByLabel("Explain in your own words")
      .fill("Covering an emergency at Harbour Mews tonight while its manager is away");
    await sheet.getByRole("button", { name: "Open record" }).click();
    return sheet;
  };

  const sheet = await openByBreakGlass();
  const stepUp = sheet.getByRole("alert");
  await expect(stepUp.getByText("Confirm it is you")).toBeVisible();
  await expect(stepUp).toContainText("confirm with your passkey or authenticator code");
  await stepUp.getByRole("link", { name: "Sign in again" }).click();
  await page.waitForURL((url) => url.pathname === "/sign-in");
  await expect(page.getByRole("status").getByText("Confirm it is you")).toBeVisible();
  await expectAccessible(page, "sign in again to confirm it is you");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await page.waitForURL((url) => url.pathname === `/people/${MEWS_PERSON}`);

  await openByBreakGlass();
  await expect(page.getByRole("heading", { level: 1, name: /Una/ })).toBeVisible();

  for (const [tab, controls] of TABS) {
    await page.goto(`/people/${MEWS_PERSON}/${tab}`);
    await expect(page.getByText(READ_ONLY)).toBeVisible();
    for (const control of controls(page)) await expect(control).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /^(Save|Record|Start|Publish|Add)/ }),
    ).toHaveCount(0);
    await expectAccessible(page, `break-glass record, read only: ${tab}`);
  }
});
