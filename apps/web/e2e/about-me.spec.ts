import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn, signInWithDemoPasskey } from "./support";

/**
 * About me (PEOP-003; PRSB About Me; people.md rules 9 and 13; HZ-022). The nurse writes it with
 * the person, and the form asks who supported them before it saves. The Registered Manager makes
 * a share link under a decision for a share link: a password sign-in alone is not enough (step-up),
 * so they confirm with their passkey; the link's code shows once, the link is listed as active and
 * then revoked with a reason. Everything is named with the run; the run's decision is withdrawn at
 * the end, so re-runs and other journeys are unaffected. Axe checks light and dark themes.
 */

const RUN = Date.now().toString(36);
const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const FRANK = demoPerson(6);
const PATH = `/people/${FRANK}/about-me`;

const main = (page: Page) => page.getByRole("main");
const aboutMe = (page: Page) => main(page).getByRole("region", { name: "About me" });
const links = (page: Page) => main(page).getByRole("region", { name: "Share links" });

async function call<T>(request: APIRequestContext, path: string, data?: object): Promise<T> {
  const options = { headers: { "x-harbour-tenant": DEMO_TENANT }, ...(data ? { data } : {}) };
  const response = data
    ? await request.post(`${API_URL}${path}`, options)
    : await request.get(`${API_URL}${path}`, options);
  expect(response.ok(), `${path} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

async function themes(page: Page, name: string) {
  await expectAccessible(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name}, dark theme`);
  await page.emulateMedia({ colorScheme: "light" });
}

// Each journey checks several states in both themes: more than the default minute.
test.describe.configure({ mode: "serial", timeout: 180_000 });

test("the nurse writes About me with the person, naming who supported them", async ({ page }) => {
  await signIn(page, "nurse@example.invalid");
  await page.goto(PATH);
  await expect(page.getByRole("heading", { level: 2, name: "About me" })).toBeVisible();
  await expect(page).toHaveTitle("About me | Residents | Harbour");
  expect(await page.title()).not.toContain("Frank");
  // Share links are for those who manage sharing only.
  await expect(links(page)).toHaveCount(0);
  await themes(page, "About me");

  await aboutMe(page)
    .getByRole("button", { name: /^(Write|Change) About me$/ })
    .click();
  const form = aboutMe(page).locator("form");
  await form.getByRole("radio", { name: "Frank, with support" }).check();
  await form.getByLabel("Supported to write this by").fill("");
  await form.getByLabel("What is most important to me").fill(`My garden and the radio (${RUN})`);
  await form
    .getByLabel("How I communicate and how to communicate with me")
    .fill(`Speak slowly and face me (${RUN})`);
  await form.getByRole("button", { name: "Save About me" }).click();
  const alert = aboutMe(page).getByRole("alert");
  await expect(alert).toBeFocused();
  await alert.getByRole("link", { name: "Enter who supported them to write this" }).click();
  await expect(form.getByLabel("Supported to write this by")).toBeFocused();
  await themes(page, "About me form with an error");

  await form.getByLabel("Supported to write this by").fill(`Sam Example ${RUN}, key worker`);
  await form.getByRole("button", { name: "Save About me" }).click();
  const arrival = main(page).locator("[data-arrival-notice]");
  await expect(arrival).toHaveText("About me saved");
  await expect(arrival).toBeFocused();
  // The form closes once saved; what was written shows in its place.
  await expect(aboutMe(page).locator("form")).toHaveCount(0);
  const shown = aboutMe(page);
  await expect(shown.getByText(`My garden and the radio (${RUN})`)).toBeVisible();
  await expect(shown.getByText(`Speak slowly and face me (${RUN})`)).toBeVisible();
  await expect(
    shown.getByText(`Supported to write this by Sam Example ${RUN}, key worker.`),
  ).toBeVisible();
  await expect(shown.getByText(/^Last updated \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/)).toBeVisible();
  await expect(
    shown.getByRole("heading", { level: 4, name: "Please do and please do not" }),
  ).toBeVisible();
});

test("hazard HZ-022 a share link needs a decision and a fresh sign-in, shows its code once and is revoked", async ({
  page,
}) => {
  await signIn(page, "manager@example.invalid");
  const decision = await call<{ id: string; version: number }>(
    page.request,
    `/v1/people/${FRANK}/sharing-decisions`,
    {
      recipient: { kind: "link" },
      sections: ["about_me"],
      basis: "consent",
      consentGivenBy: "person",
      validTo: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    },
  );
  try {
    await page.goto(PATH);
    await expect(links(page)).toBeVisible();
    const form = links(page).locator("form");
    const option = form.getByLabel("The sharing decision it rests on");
    await option.selectOption(decision.id);
    const group = form.getByRole("group", { name: "The link stops working at the end of" });
    const day = Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/London",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      })
        .formatToParts(new Date(Date.now() + 7 * 86_400_000))
        .map((p) => [p.type, p.value]),
    ) as Record<string, string>;
    const fill = async () => {
      await group.getByLabel("Day", { exact: true }).fill(day.day ?? "");
      await group.getByLabel("Month", { exact: true }).fill(day.month ?? "");
      await group.getByLabel("Year", { exact: true }).fill(day.year ?? "");
    };
    await fill();
    await form.getByRole("button", { name: "Make link" }).click();
    // A password sign-in alone never counts as step-up: the form asks for the passkey or code.
    const stepUp = links(page).getByRole("alert");
    await expect(stepUp).toBeFocused();
    await expect(stepUp.getByText("Confirm it is you")).toBeVisible();
    await expect(stepUp.getByRole("link", { name: "Sign in again" })).toBeVisible();
    await themes(page, "share link step-up");

    await signInWithDemoPasskey(page, "manager");
    await page.goto(PATH);
    await links(page)
      .locator("form")
      .getByLabel("The sharing decision it rests on")
      .selectOption(decision.id);
    await fill();
    await links(page).locator("form").getByRole("button", { name: "Make link" }).click();
    const made = links(page).locator("[data-link-made]");
    await expect(made).toBeFocused();
    await expect(made.getByText("Link made")).toBeVisible();
    const code = made.getByLabel("Link code");
    await expect(code).toHaveValue(/^[A-Za-z0-9_-]{43}$/);
    const token = await code.inputValue();
    await themes(page, "share link made");

    // The newest link is this run's; the list never holds its code.
    const listed = await call<{ items: { id: string; createdAt: string }[] }>(
      page.request,
      `/v1/people/${FRANK}/about-me/links`,
    );
    const [newest] = [...listed.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    expect(JSON.stringify(listed)).not.toContain(token);
    await made.getByRole("button", { name: "Close" }).click();
    await page.reload();
    const item = links(page).locator(`[data-link="${newest?.id}"]`);
    await expect(item.getByText("Active", { exact: true })).toBeVisible();
    await expect(item.getByText("Not opened yet")).toBeVisible();
    await expect(page.getByText(token)).toHaveCount(0);

    await item.getByRole("button", { name: /^Revoke the link made / }).click();
    await item.getByLabel("Why are you revoking it?").fill(`End-to-end run ${RUN}`);
    await item.getByRole("button", { name: "Revoke link" }).click();
    await expect(main(page).getByText("Link revoked")).toBeVisible();
    const revoked = links(page).locator(`[data-link="${newest?.id}"]`);
    await expect(revoked.getByText("Revoked", { exact: true })).toBeVisible();
    await expect(revoked.getByText(`End-to-end run ${RUN}`)).toBeVisible();
  } finally {
    const current = await call<{
      items: { id: string; version: number; withdrawnAt: string | null }[];
    }>(page.request, `/v1/people/${FRANK}/sharing-decisions`);
    const mine = current.items.find((d) => d.id === decision.id);
    if (mine && !mine.withdrawnAt) {
      await call(page.request, `/v1/people/${FRANK}/sharing-decisions/${decision.id}/withdraw`, {
        reason: `End-to-end run ${RUN}`,
        version: mine.version,
      });
    }
  }
});
