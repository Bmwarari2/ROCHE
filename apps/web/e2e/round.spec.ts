import { expect, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * Slice 5 web part 2: the round view (care.md rule 8; CARE-013; hazards HZ-001, HZ-003) against
 * the demo tenant. The nurse sets two tasks for Ben (resident 2) through the API, each titled
 * with this attempt's run mark, then on the round starts one and marks it not done with a reason,
 * and marks the other done. Every state is checked with axe.
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const DEMO_LOCATION = "0194d000-0000-7000-8000-000000000101";
const RUN = Date.now().toString(36);
const BEN = demoPerson(2);

const main = (page: Page) => page.getByRole("main");
const alertIn = (page: Page) => main(page).getByRole("alert");
const arrival = (page: Page) => page.locator("[data-arrival-notice]");

async function setTask(page: Page, title: string) {
  const response = await page.request.post(`${API_URL}/v1/tasks`, {
    headers: { "x-harbour-tenant": DEMO_TENANT },
    data: {
      title,
      personId: BEN,
      locationId: DEMO_LOCATION,
      dueAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    },
  });
  expect(response.status(), await response.text()).toBe(201);
}

test("hazard HZ-003 the nurse works through Ben's tasks on the round, every state in words", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page, "nurse@example.invalid");
  const check = `Check the call bell is in reach ${RUN}`;
  const walk = `Walk to the lounge ${RUN}`;
  await setTask(page, check);
  await setTask(page, walk);

  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Modules" })
    .getByRole("link", { name: "Round" })
    .click();
  await page.waitForURL((url) => url.pathname.startsWith("/round"));
  await page.goto(`/round/${DEMO_LOCATION}`);
  await expect(page.getByRole("heading", { level: 1, name: "Round" })).toBeVisible();
  await expectAccessible(page, "round");

  // Only Ben's stop, his name with his communication needs beside it (HZ-001).
  await page
    .getByRole("link", { name: /^Show only .+'s tasks$/ })
    .filter({ hasText: "Ben" })
    .first()
    .click();
  await page.waitForURL((url) => url.searchParams.get("person") === BEN);
  await expect(
    main(page).getByRole("term").filter({ hasText: "Communication needs" }).first(),
  ).toBeVisible();
  const first = page.getByRole("listitem").filter({ hasText: check }).last();
  await expect(first.getByText(/^(Still to come|Due now)$/)).toBeVisible();
  await expectAccessible(page, "round for one person");

  await first.getByRole("button", { name: `Start ${check}` }).click();
  await expect(arrival(page)).toHaveText("Task started.");
  await expect(arrival(page)).toBeFocused();
  const started = page.getByRole("listitem").filter({ hasText: check }).last();
  await expect(started.getByText("Started", { exact: true })).toBeVisible();

  // Not done: the reason is required, the summary takes focus.
  await started.getByRole("button", { name: `Not done: ${check}` }).click();
  await expect(started.getByLabel(`Why was it not done? (${check})`)).toBeFocused();
  await started.getByRole("button", { name: "Mark not done" }).click();
  await expect(alertIn(page)).toBeFocused();
  await expect(alertIn(page)).toContainText("Say why it was not done");
  await expectAccessible(page, "not done refused");
  await started.getByLabel(`Why was it not done? (${check})`).fill("Asleep, will try at 03:00");
  await started.getByRole("button", { name: "Mark not done" }).click();
  await expect(arrival(page)).toHaveText("Task marked not done.");
  await expect(page.getByRole("listitem").filter({ hasText: check })).toHaveCount(0);

  const second = page.getByRole("listitem").filter({ hasText: walk }).last();
  await second.getByRole("button", { name: `Done: ${walk}` }).click();
  await expect(arrival(page)).toHaveText("Task done.");
  await expect(page.getByRole("listitem").filter({ hasText: walk })).toHaveCount(0);
  await expectAccessible(page, "round after tasks done");
});
