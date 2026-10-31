import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn, signInWithDemoPasskey } from "./support";

/**
 * The rota and staffing planner (SCHED-001, SCHED-002, CARE-004; hazards HZ-123 and HZ-124)
 * against the demo tenant. The manager makes a shift template, starts a rota far enough ahead
 * that no earlier run's rota overlaps it, adds a shift and puts someone on it through the
 * rostering rule (with a justified override naming the blockers where the rule blocks), checks
 * the rota against the organisation's own scale (never a Harbour score) and publishes it with
 * each period acknowledged. The care worker sees their own shifts and no rota builder. The
 * organisation's dependency scale is made by one manager and approved by someone else, and a
 * person's category is recorded from it. Every screen is checked with axe in light and dark.
 */

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.getByRole("main");
const RUN = Date.now();

async function accessibleInBothThemes(page: Page, name: string) {
  await page.emulateMedia({ colorScheme: "light" });
  await expectAccessible(page, `${name} (light)`);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name} (dark)`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** The arrival: focus on the page's heading, and a status saying what was done. */
async function arrived(page: Page, heading: string, words: string) {
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeFocused();
  await expect(main(page).getByRole("status").filter({ hasText: words })).toBeVisible();
}

/** A date far ahead, different on each run, as day, month and year boxes. */
function farDate(offsetDays: number): { day: string; month: string; year: string } {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 400 + (Math.floor(RUN / 1000) % 3000) * 7 + offsetDays);
  return {
    day: String(d.getUTCDate()),
    month: String(d.getUTCMonth() + 1),
    year: String(d.getUTCFullYear()),
  };
}

async function fillDate(
  page: Page,
  legend: string,
  date: { day: string; month: string; year: string },
) {
  const group = main(page).getByRole("group", { name: legend });
  await group.getByLabel("Day").fill(date.day);
  await group.getByLabel("Month").fill(date.month);
  await group.getByLabel("Year").fill(date.year);
}

let manager: Awaited<ReturnType<BrowserContext["cookies"]>> = [];
let carer: Awaited<ReturnType<BrowserContext["cookies"]>> = [];

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  for (const [email, store] of [
    ["manager@example.invalid", "manager"],
    ["carer@example.invalid", "carer"],
  ] as const) {
    const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
    await signIn(await context.newPage(), email);
    if (store === "manager") manager = await context.cookies();
    else carer = await context.cookies();
    await context.close();
  }
});

/** The manager at the demo home's rota page. */
async function managerAtRota(page: Page, context: BrowserContext) {
  await context.addCookies(manager);
  await page.goto("/rota");
  const choose = main(page).getByRole("link", { name: "Harbour House" });
  if (await choose.count()) await choose.click();
  await expect(page.getByRole("heading", { level: 1, name: "Rota" })).toBeVisible();
}

test("hazard HZ-124 the manager makes a template, starts a rota and fills a shift through the rostering rule", async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  await managerAtRota(page, context);
  await accessibleInBothThemes(page, "rota home");

  // A shift template, in 24-hour UK time.
  await main(page).getByRole("link", { name: "Shift templates and patterns" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Shift templates and patterns" }),
  ).toBeVisible();
  const form = page.getByRole("region", { name: "Make a shift template" });
  await form.getByLabel("Name").fill(`Early ${RUN}`);
  await form.getByLabel("Starts").fill("7.30");
  await form.getByLabel("Ends").fill("15:00");
  await form.getByRole("button", { name: "Make template" }).click();
  await expect(form.getByRole("alert")).toContainText("Enter when it starts as a 24-hour time");
  await form.getByLabel("Starts").fill("07:30");
  await form.getByRole("button", { name: "Make template" }).click();
  await arrived(page, "Shift templates and patterns", "Shift template made.");
  await expect(main(page)).toContainText("07:30 to 15:00");
  await accessibleInBothThemes(page, "shift templates");

  // A rota far ahead (one week), so no earlier run's rota overlaps it.
  await main(page).getByRole("link", { name: "Back to the home's rotas" }).click();
  await fillDate(page, "First day", farDate(0));
  await fillDate(page, "Last day", farDate(6));
  await main(page).getByRole("button", { name: "Start rota" }).click();
  await arrived(page, "Rota", "Rota started.");
  await expect(main(page)).toContainText("Draft");
  await accessibleInBothThemes(page, "rota builder, empty");

  // A shift from the template on the first day.
  const add = page.getByRole("region", { name: "Add shifts" });
  await add.getByLabel("Day", { exact: true }).selectOption({ index: 1 });
  await add.getByLabel("Shift", { exact: true }).selectOption({ label: `Early ${RUN}` });
  await add.getByRole("button", { name: "Add shift" }).click();
  await arrived(page, "Rota", "Shift added.");
  const shift = main(page)
    .getByRole("listitem")
    .filter({
      has: page.getByRole("heading", { name: new RegExp(`^Early ${RUN}, 07:30 to 15:00`) }),
    })
    // The shift's own item, inside its day's.
    .last();
  await expect(shift.getByText("Open", { exact: true })).toBeVisible();

  // The rostering rule: check first, then put on the shift or override with a justification.
  const who = shift.getByLabel(`Who works Early ${RUN}`);
  const carerValue = await who.locator("option", { hasText: "Cat Carer" }).getAttribute("value");
  await who.selectOption(carerValue ?? "");
  await shift.getByRole("button", { name: "Check they can work it" }).click();
  const allowed = shift.getByText("Cat Carer can work this shift.");
  const blocked = shift.getByText("Cat Carer cannot work this shift yet:");
  await expect(allowed.or(blocked)).toBeVisible();
  await accessibleInBothThemes(page, "rostering rule answer");
  if (await allowed.isVisible()) {
    await shift.getByRole("button", { name: "Put on shift" }).click();
    await arrived(page, "Rota", "Put on the shift.");
  } else if (await shift.getByRole("button", { name: "Override and put on shift" }).count()) {
    // The override names what it covers and needs a reason of 10 characters or more.
    await shift.getByRole("button", { name: "Override and put on shift" }).click();
    await expect(shift.getByRole("alert")).toContainText(
      "Say why it is safe in at least 10 characters",
    );
    await shift
      .getByLabel("Why it is safe")
      .fill("Checked with the nurse in charge; shadowing the whole shift.");
    await shift.getByLabel(/^This override covers/).check();
    await shift.getByRole("button", { name: "Override and put on shift" }).click();
    await arrived(page, "Rota", "Put on the shift with your override recorded.");
  } else {
    await expect(shift).toContainText(/never be overridden|Only a manager/);
    return;
  }
  await expect(main(page)).toContainText("On shift: Cat Carer");
  await accessibleInBothThemes(page, "rota builder, filled");

  // hazard HZ-123 the check before publishing: the organisation's own scale, never a score.
  await main(page).getByRole("link", { name: "Check and publish" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Check before publishing" }),
  ).toBeVisible();
  await expect(main(page)).toContainText("your organisation's own dependency scale");
  await expect(main(page)).toContainText("They are not a Harbour score");
  await expect(main(page)).not.toContainText(/\bscore:/i);
  await accessibleInBothThemes(page, "rota check");

  // Publishing is held back until each period is ticked by name and the warnings read.
  const publish = page.getByRole("region", { name: "Publish" });
  const periods = publish.getByRole("checkbox", { name: /^I have seen / });
  if ((await periods.count()) > 0) {
    await publish.getByRole("button", { name: "Publish rota" }).click();
    await expect(publish.getByRole("alert")).toBeFocused();
    await expect(publish.getByRole("alert")).toContainText(
      "Tick each period to say you have seen it.",
    );
    for (const box of await periods.all()) await box.check();
  }
  const read = publish.getByLabel("I have read the warnings on this check");
  if (await read.count()) await read.check();
  await publish.getByRole("button", { name: "Publish rota" }).click();
  await arrived(page, "Rota", "Rota published.");
  await expect(main(page).getByText("Published", { exact: true })).toBeVisible();
  await accessibleInBothThemes(page, "rota published");
});

test("the care worker sees their own shifts and no rota builder", async ({ page, context }) => {
  await context.addCookies(carer);
  await page.goto("/my-shifts");
  await expect(page.getByRole("heading", { level: 1, name: "My shifts" })).toBeVisible();
  await accessibleInBothThemes(page, "my shifts");
  await page.goto("/rota/locations/0194d000-0000-7000-8000-000000000101/templates");
  await expect(main(page)).toContainText("You do not have access to this");
});

test("hazard HZ-123 the organisation's own dependency scale, approved by someone else, and a person's category", async ({
  page,
  context,
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  await context.addCookies(manager);
  await page.goto("/settings/dependency");
  await expect(page.getByRole("heading", { level: 1, name: "Dependency scales" })).toBeVisible();
  await expect(main(page)).toContainText("Every figure in it is yours.");
  await accessibleInBothThemes(page, "dependency scales");

  const scaleLink = main(page).getByRole("region", { name: "Scales" }).getByRole("link").first();
  if ((await scaleLink.count()) === 0) {
    // The first run makes the home's scale, with one category.
    const make = page.getByRole("region", { name: "Make a scale" });
    await make.getByLabel("Name", { exact: true }).fill("Harbour House dependency scale");
    await make.getByLabel("Where it applies").selectOption({ label: "Harbour House" });
    await make.getByRole("button", { name: "Add a category" }).click();
    await make.getByLabel("Category 1 name").fill("Lower needs");
    await make.getByLabel("Lower needs: minutes in Day").fill("60");
    await make.getByLabel("Lower needs: minutes in Night").fill("30");
    await accessibleInBothThemes(page, "make a scale");
    await make.getByRole("button", { name: "Make scale" }).click();
    await expect(
      main(page).getByRole("status").filter({ hasText: "Scale made with its first draft." }),
    ).toBeVisible();
  } else {
    await scaleLink.click();
  }
  await expect(main(page).getByRole("region", { name: "Versions" })).toBeVisible();
  await accessibleInBothThemes(page, "dependency scale");
  const scaleUrl = page.url().split("?")[0] ?? "";

  // The draft's author cannot approve it: the owner does.
  if (
    await main(page)
      .getByText("You wrote or changed this draft, so someone else must approve it.")
      .count()
  ) {
    const owner = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
    const ownerPage = await owner.newPage();
    await signInWithDemoPasskey(ownerPage, "owner");
    await ownerPage.goto(scaleUrl);
    await ownerPage.getByRole("main").getByRole("button", { name: "Approve draft" }).click();
    await expect(
      ownerPage.getByRole("main").getByRole("status").filter({ hasText: "Draft approved." }),
    ).toBeVisible();
    await owner.close();
    await page.reload();
  }
  await expect(main(page).getByRole("region", { name: "In use" })).toContainText("Version");

  // A person's category from the approved version at their home.
  await page.goto(`/people/${demoPerson(1)}/dependency`);
  await expect(main(page).getByRole("heading", { name: "Dependency category" })).toBeVisible();
  const record = main(page).getByRole("region", { name: "Record a category" });
  if (await record.getByLabel("Category").count()) {
    await record.getByLabel("Category").selectOption({ index: 1 });
    const today = new Date();
    const group = record.getByRole("group", { name: "Applies from" });
    await group.getByLabel("Day").fill(String(today.getDate()));
    await group.getByLabel("Month").fill(String(today.getMonth() + 1));
    await group.getByLabel("Year").fill(String(today.getFullYear()));
    await record.getByLabel("Why").fill("Assessed with the person and their key worker.");
    await record.getByRole("button", { name: "Record category" }).click();
    await expect(
      main(page).getByRole("status").filter({ hasText: "Dependency category recorded." }),
    ).toBeVisible();
    await expect(main(page).getByRole("region", { name: "In force now" })).not.toContainText(
      "No dependency category",
    );
  }
  await accessibleInBothThemes(page, "person dependency");
});
