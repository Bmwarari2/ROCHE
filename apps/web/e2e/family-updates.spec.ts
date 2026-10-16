import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * Family updates on a person's record (COMMS-001; comms.md rules 6 to 12; hazards HZ-022 and
 * HZ-061): the Registered Manager writes an update from a note, is told at the field when it
 * names another resident, previews the family's words, publishes it once, and takes it down with
 * a reason. The note is recorded through the API, named with the run. Axe checks every state.
 */

const RUN = Date.now().toString(36);
const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const ADA = demoPerson(1);
const PATH = `/people/${ADA}/family-updates`;

async function recordNote(request: APIRequestContext, body: string) {
  const response = await request.post(`${API_URL}/v1/people/${ADA}/notes`, {
    headers: { "x-harbour-tenant": DEMO_TENANT },
    data: {
      occurredAt: new Date(Date.now() - 60_000).toISOString(),
      category: "activity",
      body,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

const main = (page: Page) => page.getByRole("main");
const arrival = (page: Page) => page.locator("[data-arrival-notice]");

test("hazard HZ-022 an update is written for the family, checked in a preview, published once and taken down", async ({
  page,
}) => {
  await signIn(page, "manager@example.invalid");
  await recordNote(
    page.request,
    `Baking session ${RUN}: scones with jam, stayed for the whole hour.`,
  );

  await page.goto(PATH);
  await expect(page.getByRole("heading", { name: "Write an update" })).toBeVisible();
  await expectAccessible(page, "family updates tab");

  // Nothing chosen: each problem at its field, in a summary that takes focus.
  await page.getByRole("button", { name: "Preview the update" }).click();
  await expect(main(page).getByRole("alert")).toBeFocused();
  await expect(main(page).getByRole("alert")).toContainText("Choose the note the update is about.");
  await expectAccessible(page, "nothing chosen");

  const note = page.getByLabel("Note", { exact: true });
  // Newest first: the note just recorded.
  const option = note.locator("option").nth(1);
  await expect(option).toContainText("Activity");
  await note.selectOption((await option.getAttribute("value")) ?? "");
  const words = page.getByLabel("Words for the family");
  // Another resident named: the API's problem is shown at the words.
  await words.fill(`Addie baked scones with Ben this afternoon (${RUN}).`);
  await page.getByRole("button", { name: "Preview the update" }).click();
  await expect(main(page).getByRole("alert")).toContainText("Do not name other residents");
  await expect(words).toHaveAttribute("aria-invalid", "true");
  await expectAccessible(page, "another resident named");

  const text = `Addie baked scones with friends this afternoon and enjoyed them with tea (${RUN}).`;
  await words.fill(text);
  await page.getByRole("button", { name: "Preview the update" }).click();
  const preview = page.getByRole("region", { name: "Check before publishing" });
  await expect(page.getByRole("heading", { name: "Check before publishing" })).toBeFocused();
  await expect(preview).toContainText(text);
  await expectAccessible(page, "preview");

  // Typing after the preview asks for a new one before anything is published.
  await words.fill(`${text} `);
  await expect(preview).toHaveCount(0);
  await page.getByRole("button", { name: "Preview the update" }).click();
  await page.getByRole("button", { name: "Publish the update" }).click();
  await expect(arrival(page)).toHaveText(
    "Update published. The family will see it if a sharing decision covers it.",
  );
  const list = page.getByRole("region", { name: "Updates published" });
  const item = list.getByRole("listitem").filter({ hasText: text });
  await expect(item).toHaveCount(1);
  await expectAccessible(page, "published");

  // Taking it down needs a reason.
  const takeDown = item.getByRole("form", { name: /^Take down:/ });
  await takeDown.getByRole("button", { name: "Take the update down" }).click();
  await expect(takeDown.getByRole("alert")).toContainText(
    "Choose why the update is being taken down.",
  );
  await expectAccessible(page, "no reason");
  await takeDown.getByLabel("Why is it being taken down?").selectOption({
    label: "Published in error",
  });
  await takeDown.getByRole("button", { name: "Take the update down" }).click();
  await expect(arrival(page)).toHaveText(
    "Update taken down. A family member who saw it is told only that an update was taken down.",
  );
  const withdrawn = list.getByRole("listitem").filter({ hasText: text });
  await expect(withdrawn.getByText("Taken down", { exact: true })).toBeVisible();
  await expect(withdrawn).toContainText("Published in error");
  await expectAccessible(page, "taken down");
});

test("the tab is not offered to a care worker, who does not publish updates", async ({ page }) => {
  await signIn(page, "carer@example.invalid");
  await page.goto(`/people/${ADA}`);
  await expect(page.getByRole("link", { name: "Notes", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Family updates" })).toHaveCount(0);
});
