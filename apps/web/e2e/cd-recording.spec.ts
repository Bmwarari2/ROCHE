import { expect, type Page, test } from "@playwright/test";
import { addDemoPasskey, demoPerson, expectAccessible, openModules, signIn } from "./support";

/**
 * Controlled drug recording at a home (H-1517, H-1518; HZ-115, HZ-008), against the demo tenant,
 * whose demo home has recording turned on by the seed. The Registered Manager signs in with a
 * password, finds the page in the navigation, turns recording off with a reason (refused first
 * without one, then sent to sign in again for the second step) and the register shows the paper
 * register as the record; then turns it on again with the three confirmations (refused first
 * without them). The test ends with recording on, as the seed left it. A nurse and a care worker
 * are offered no page and no form. Each state is checked with axe in light and dark.
 */

const HOME = "0194d000-0000-7000-8000-000000000101";
const FRANK = demoPerson(6);
const PAGE = `/medicines-settings/${HOME}`;
const TITLE = "Controlled drug recording";

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.getByRole("main");
const card = (page: Page) =>
  main(page).getByRole("region", { name: "Which register is the record" });

async function bothThemes(page: Page, name: string) {
  await expectAccessible(page, `${name} (light)`);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name} (dark)`);
  await page.emulateMedia({ colorScheme: "light" });
}

test("hazard HZ-115 hazard HZ-008 the Registered Manager turns controlled drug recording off with a reason and step-up, then on with each confirmation", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await addDemoPasskey(page, "manager");
  await signIn(page, "manager@example.invalid");

  // Found in the navigation, not only by its address.
  const nav = await openModules(page);
  await nav.getByRole("link", { name: TITLE }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/medicines-settings"));
  if (!page.url().includes(HOME)) {
    await main(page).getByRole("link", { name: /.+/ }).first().click();
  }
  await page.waitForURL((url) => url.pathname === PAGE);
  await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
  await expect(card(page).getByText("Thapsus Care's register is the record")).toBeVisible();
  await bothThemes(page, "controlled drug recording, turned on");

  // Turning off: the reason and the restart are asked for first, in words at their fields.
  const off = card(page).getByRole("button", {
    name: "Turn off and go back to the paper register",
  });
  await off.click();
  const errors = main(page).getByRole("alert");
  await expect(errors).toContainText("Say why recording is being turned off.");
  await expect(errors).toContainText("Confirm the paper register is restarted with each balance.");
  await bothThemes(page, "controlled drug recording, turning off refused");

  const fillOff = async () => {
    await card(page)
      .getByLabel("Why recording is being turned off")
      .fill("The phones at the home are being replaced this week");
    await card(page)
      .getByLabel(
        "The register pages are printed and the paper register is restarted with each balance",
      )
      .check();
    await off.click();
  };
  // A password session has no fresh second step: the API refuses and nothing changes.
  await fillOff();
  const stepUp = main(page).getByRole("alert").filter({ hasText: "Confirm it is you" });
  await expect(stepUp).toContainText("Nothing has changed yet.");
  await expect(stepUp).toBeFocused();
  await bothThemes(page, "controlled drug recording, second step needed");
  await stepUp.getByRole("link", { name: "Sign in again" }).click();
  await page.waitForURL((url) => url.pathname === "/sign-in");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await page.waitForURL((url) => url.pathname === PAGE);
  await expect(card(page).getByText("Thapsus Care's register is the record")).toBeVisible();

  await fillOff();
  await expect(
    main(page).getByRole("status").filter({
      hasText: "Controlled drug recording is turned off. The paper register is the record again.",
    }),
  ).toBeVisible();
  await page.reload();
  await expect(card(page).getByText("The paper register is the record")).toBeVisible();
  await bothThemes(page, "controlled drug recording, turned off");

  // The register says so too, and offers no form.
  await page.goto(`/people/${FRANK}/controlled-drugs`);
  await expect(
    main(page).getByText("Controlled drug recording is not turned on for this home"),
  ).toBeVisible();

  // Turning on: each of the three steps is confirmed by the person; nothing is ticked for them.
  await page.goto(PAGE);
  const on = card(page).getByRole("button", { name: "Turn on controlled drug recording" });
  for (const box of await card(page).getByRole("checkbox").all()) {
    await expect(box).not.toBeChecked();
  }
  await on.click();
  const missing = main(page).getByRole("alert");
  await expect(missing).toContainText(
    "Confirm the paper register is counted, witnessed and closed.",
  );
  await expect(missing).toContainText(
    "Confirm each balance will be carried across, witnessed, before the next dose.",
  );
  await bothThemes(page, "controlled drug recording, turning on refused");
  await card(page)
    .getByLabel("The paper register's pages for this home are counted, witnessed and closed now")
    .check();
  await card(page)
    .getByLabel(
      "Each balance will be entered in Thapsus Care's register as received, witnessed, before the next dose",
    )
    .check();
  await card(page)
    .getByLabel(
      "Everyone who gives controlled drugs here uses a phone with the updated app, the Medicines tab and their own medicines PIN",
    )
    .check();
  await on.click();
  await expect(
    main(page).getByRole("status").filter({
      hasText: "Controlled drug recording is turned on. Carry each balance across now, witnessed.",
    }),
  ).toBeVisible();
  await page.reload();
  await expect(card(page).getByText("Thapsus Care's register is the record")).toBeVisible();
  await bothThemes(page, "controlled drug recording, turned on again");
});

for (const who of ["nurse", "carer"] as const) {
  test(`hazard HZ-115 a ${who === "nurse" ? "nurse" : "care worker"} is offered no controlled drug recording page or form`, async ({
    page,
  }) => {
    await signIn(page, `${who}@example.invalid`);
    const nav = await openModules(page);
    await expect(nav.getByRole("link", { name: TITLE })).toHaveCount(0);
    await page.goto(PAGE);
    await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
    await expect(main(page).getByRole("button", { name: /^Turn (on|off)/ })).toHaveCount(0);
    await expect(main(page).getByRole("checkbox")).toHaveCount(0);
    await bothThemes(page, `controlled drug recording, ${who} refused`);
  });
}
