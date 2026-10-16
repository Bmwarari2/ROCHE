import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn } from "./support";

/**
 * Family updates on a person's record (COMMS-001; comms.md rules 6 to 12; hazards HZ-022 and
 * HZ-061): the Registered Manager writes an update from a note, is told at the field when it
 * names another resident, previews the family's words, publishes it once, and takes it down with
 * a reason; words that need a manager's confirmation, a photo without the person's consent, a
 * record corrected after the preview and a person whose updates are on hold are each said, and
 * nothing is published. Records are made through the API, named with the run. Axe checks every
 * state.
 */

const RUN = Date.now().toString(36);
const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const DEMO_LOCATION = "0194d000-0000-7000-8000-000000000101";
const ADA = demoPerson(1);
/** Dev Fixture: an open incident about him holds his updates, so no other journey publishes for him. */
const DEV = demoPerson(4);
const PATH = `/people/${ADA}/family-updates`;
/** A 1 by 1 pixel PNG. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function post<T>(request: APIRequestContext, path: string, data: object): Promise<T> {
  const response = await request.post(`${API_URL}${path}`, {
    headers: { "x-harbour-tenant": DEMO_TENANT },
    data,
  });
  expect(response.ok(), `${path} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

const recordNote = (request: APIRequestContext, body: string, person = ADA) =>
  post<{ id: string; occurredAt: string }>(request, `/v1/people/${person}/notes`, {
    occurredAt: new Date(Date.now() - 60_000).toISOString(),
    category: "activity",
    body,
  });

const main = (page: Page) => page.getByRole("main");
const alertIn = (page: Page) => main(page).getByRole("alert");
const arrival = (page: Page) => page.locator("[data-arrival-notice]");
const previewButton = (page: Page) => page.getByRole("button", { name: "Preview the update" });

/** Chooses the newest record of a kind: the one just made. */
async function chooseNewest(page: Page, kind: "A note" | "An activity" | "A photo") {
  await page.getByRole("radio", { name: kind }).check();
  const label = kind === "A note" ? "Note" : kind === "An activity" ? "Activity" : "Photo";
  const select = page.getByLabel(label, { exact: true });
  const option = select.locator("option").nth(1);
  await select.selectOption((await option.getAttribute("value")) ?? "");
  return option;
}

test("hazard HZ-022 hazard HZ-061 an update is written for the family, checked in a preview, published once and taken down", async ({
  page,
}) => {
  await signIn(page, "manager@example.invalid");
  await recordNote(page.request, `Baking session ${RUN}: scones with jam, stayed for the hour.`);

  await page.goto(PATH);
  await expect(page.getByRole("heading", { name: "Write an update" })).toBeVisible();
  await expectAccessible(page, "family updates tab");

  // Nothing chosen: each problem at its field, in a summary that takes focus.
  await previewButton(page).click();
  await expect(alertIn(page)).toBeFocused();
  await expect(alertIn(page)).toContainText("Choose the note the update is about.");
  await expectAccessible(page, "nothing chosen");

  await expect(await chooseNewest(page, "A note")).toContainText("Activity");
  const words = page.getByLabel("Words for the family");
  // Another resident named: the API's problem is shown at the words.
  await words.fill(`Addie baked scones with Ben this afternoon (${RUN}).`);
  await previewButton(page).click();
  await expect(alertIn(page)).toContainText("Do not name other residents");
  await expect(alertIn(page)).toBeFocused();
  await expect(words).toHaveAttribute("aria-invalid", "true");
  await expectAccessible(page, "another resident named");

  const text = `Addie baked scones with friends this afternoon and enjoyed them with tea (${RUN}).`;
  await words.fill(text);
  await previewButton(page).click();
  const preview = page.getByRole("region", { name: "Check before publishing" });
  await expect(page.getByRole("heading", { name: "Check before publishing" })).toBeFocused();
  await expect(preview).toContainText(text);
  await expectAccessible(page, "preview");

  // Typing after the preview asks for a new one before anything is published.
  await words.fill(`${text} `);
  await expect(preview).toHaveCount(0);
  await previewButton(page).click();
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

test("hazard HZ-061 words to confirm, a photo without consent, a record corrected after the preview and a hold are said, and nothing is published", async ({
  page,
}) => {
  await signIn(page, "manager@example.invalid");

  // Words that say how the person is: a manager confirms them with a reason.
  await recordNote(page.request, `Quiet afternoon ${RUN}.`);
  await page.goto(PATH);
  await chooseNewest(page, "A note");
  await page.getByLabel("Words for the family").fill(`Addie was happy in the garden (${RUN}).`);
  await previewButton(page).click();
  await expect(alertIn(page)).toBeFocused();
  await expect(alertIn(page)).toContainText("A manager can confirm it may be published");
  const reason = page.getByLabel("Reason it may be published");
  await expect(reason).toHaveAttribute("aria-invalid", "true");
  await expectAccessible(page, "confirmation reason");
  await reason.fill("Her daughter asked to hear how she is settling in.");
  await previewButton(page).click();
  await expect(page.getByRole("heading", { name: "Check before publishing" })).toBeFocused();

  // A photo added for the feed, without the person's consent to photos: said at the photo.
  const upload = await page.request.post(
    `${API_URL}/v1/documents?${new URLSearchParams({
      category: "feed_photo",
      title: `Garden ${RUN}`,
      personId: ADA,
      fileName: "garden.png",
    })}`,
    { headers: { "x-harbour-tenant": DEMO_TENANT, "content-type": "image/png" }, data: PIXEL },
  );
  expect(upload.ok(), await upload.text()).toBe(true);
  await page.goto(PATH);
  await expect(await chooseNewest(page, "A photo")).toContainText(`Garden ${RUN}`);
  await page.getByLabel("I have checked that nobody else can be recognised in this photo").check();
  await previewButton(page).click();
  await expect(alertIn(page)).toBeFocused();
  await expect(page.getByLabel("Photo", { exact: true })).toHaveAttribute("aria-invalid", "true");
  await expectAccessible(page, "photo refused");

  // A note corrected between the preview and publishing is refused when published.
  const note = await recordNote(page.request, `Painting class ${RUN}.`);
  await page.goto(PATH);
  await chooseNewest(page, "A note");
  await page.getByLabel("Words for the family").fill(`Addie painted a picture (${RUN}).`);
  await previewButton(page).click();
  await expect(page.getByRole("heading", { name: "Check before publishing" })).toBeFocused();
  await post(page.request, `/v1/people/${ADA}/notes`, {
    occurredAt: note.occurredAt,
    category: "activity",
    body: `Pottery class ${RUN}.`,
    supersedesId: note.id,
    correctionReason: "Wrong class",
  });
  await page.getByRole("button", { name: "Publish the update" }).click();
  await expect(alertIn(page)).toContainText("This record has been corrected.");
  await expect(arrival(page)).toHaveCount(0);
  await expectAccessible(page, "publish refused");

  // An open incident about the person whose family is not yet told holds their updates.
  await post(page.request, "/v1/incidents", {
    locationId: DEMO_LOCATION,
    occurredAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    type: "fall",
    description: `Found on the floor of his room (${RUN}).`,
    emergencyServicesCalled: false,
    gpContacted: false,
    people: [{ kind: "service_user", role: "affected", personId: DEV }],
  });
  await recordNote(page.request, `Card games ${RUN}.`, DEV);
  await page.goto(`/people/${DEV}/family-updates`);
  await chooseNewest(page, "A note");
  await page.getByLabel("Words for the family").fill(`Dev played cards with friends (${RUN}).`);
  await previewButton(page).click();
  await expect(alertIn(page)).toBeFocused();
  await expect(alertIn(page)).toContainText("Updates for this person are on hold");
  await expect(page.getByRole("region", { name: "Check before publishing" })).toHaveCount(0);
  await expectAccessible(page, "on hold");
});

test("the tab is not offered to a care worker, who does not publish updates", async ({ page }) => {
  await signIn(page, "carer@example.invalid");
  await page.goto(`/people/${ADA}`);
  await expect(page.getByRole("link", { name: "Notes", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Family updates" })).toHaveCount(0);
});
