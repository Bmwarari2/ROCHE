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
const NAME = "Ben Sample";

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

  // Only Ben's stop, under the compact point-of-care header (HZ-001).
  await page
    .getByRole("link", { name: `Show only ${NAME}'s tasks` })
    .first()
    .click();
  await page.waitForURL((url) => url.searchParams.get("person") === BEN);
  const header = page.locator("[data-person-header]").filter({
    has: page.getByRole("heading", { level: 3, name: new RegExp(`^${NAME}`) }),
  });
  for (const term of ["Allergies", "Resuscitation", "Communication needs"]) {
    await expect(header.getByRole("term").filter({ hasText: term })).toBeVisible();
  }
  const taskItem = (title: string) =>
    page.locator("[data-round-task]").filter({ has: page.getByText(title, { exact: true }) });
  await expect(taskItem(check).getByText(/^(Still to come|Due now)$/)).toBeVisible();
  await expectAccessible(page, "round for one person");

  await taskItem(check)
    .getByRole("button", { name: `Start ${check} for ${NAME}` })
    .click();
  await expect(arrival(page)).toHaveText("Task started.");
  await expect(arrival(page)).toBeFocused();
  await expect(taskItem(check).getByText("Started", { exact: true })).toBeVisible();
  await expectAccessible(page, "task started");

  // Not done: the reason is required, the summary takes focus.
  const reason = `Why was ${check} for ${NAME} not done?`;
  await taskItem(check)
    .getByRole("button", { name: `Not done: ${check} for ${NAME}` })
    .click();
  await expect(taskItem(check).getByLabel(reason)).toBeFocused();
  await taskItem(check).getByRole("button", { name: "Mark not done" }).click();
  await expect(alertIn(page)).toBeFocused();
  await expect(alertIn(page)).toContainText("Say why it was not done");
  await expectAccessible(page, "not done refused");
  await taskItem(check).getByLabel(reason).fill("Asleep, will try at 03:00");
  await taskItem(check).getByRole("button", { name: "Mark not done" }).click();
  await expect(arrival(page)).toHaveText("Task marked not done.");
  await expect(taskItem(check)).toHaveCount(0);

  await taskItem(walk)
    // Exact: "Not done: …" also contains "Done: …".
    .getByRole("button", { name: `Done: ${walk} for ${NAME}`, exact: true })
    .click();
  await expect(arrival(page)).toHaveText("Task done.");
  await expect(taskItem(walk)).toHaveCount(0);
  await expectAccessible(page, "round after tasks done");
});
