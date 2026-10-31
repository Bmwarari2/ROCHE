import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type Browser, expect, type Page, type TestInfo, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn, signInWithDemoPasskey } from "./support";

/**
 * The inspector evidence pack (QUAL-003; quality.md section 16; hazard HZ-050; ADR-0050) against
 * the demo tenant. The manager writes a note, composes a pack for an invented inspector about one
 * resident, adds the note, redacts its free text by hand (a copy holding a long number is refused)
 * and is told they cannot release it. The owner, stepped up with their passkey, reads what will be
 * shared, confirms, releases it and sees the link once with its expiry in words; the manager then
 * withdraws it. Every state passes axe in the light and dark themes. Each run tags its data, so
 * re-runs never depend on counts.
 */

test.describe.configure({ mode: "serial" });

const TAG = `run ${Date.now()}`;
const RECIPIENT = `Ivy Inspector ${TAG}`;
const EMAIL = "ivy.inspector@example.invalid";
const PERSON = demoPerson(2);
const PERSON_NAME = "Ben Sample";
let packUrl = "";
/** The released link, as the owner copied it (only ever in memory here). */
let inspectorLink = "";
const API_DIR = fileURLToPath(new URL("../../api", import.meta.url));

/**
 * One more code for the newest live link to the invented inspector: the development email
 * adapter keeps codes in the API's memory, so the journey asks the local-only script for one,
 * stored exactly as the API stores it (apps/api/scripts/e2e-evidence-code.ts).
 */
function plantedCode(): string {
  const out = execFileSync("pnpm", ["-s", "e2e:evidence-code", EMAIL], {
    cwd: API_DIR,
    env: { ...process.env, NODE_ENV: "development" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  return out.toString().trim().split("\n").pop() ?? "";
}

/** The inspector's own browser: no Harbour sign-in, no cookies, every request URL recorded. */
async function inspector(browser: Browser, info: TestInfo) {
  const context = await browser.newContext({
    baseURL: info.project.use.baseURL,
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));
  return { context, page, urls };
}

const main = (page: Page) => page.getByRole("main");

async function bothThemes(page: Page, name: string) {
  await page.emulateMedia({ colorScheme: "light" });
  await expectAccessible(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name}, dark theme`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** The arrival: focus on the page's heading, and a status saying what was done. */
async function arrived(page: Page, words: string | RegExp) {
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  await expect(main(page).getByRole("status").filter({ hasText: words })).toBeVisible();
}

/** Today in the three date boxes of a field. */
async function today(page: Page, legend: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "numeric",
    month: "numeric",
    year: "numeric",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const group = main(page).getByRole("group", { name: legend });
  await group.getByRole("textbox", { name: "Day" }).fill(get("day"));
  await group.getByRole("textbox", { name: "Month" }).fill(get("month"));
  await group.getByRole("textbox", { name: "Year" }).fill(get("year"));
}

test("hazard HZ-050 the manager composes a pack, adds a note and redacts it, but cannot release it", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page, "manager@example.invalid");

  // A note to put in the pack.
  await page.goto(`/people/${PERSON}/notes`);
  const write = page.getByRole("region", { name: "Write a note" });
  await write.getByLabel("What is it about?").selectOption("activity");
  await write
    .getByLabel("Note", { exact: true })
    .fill(`Ben joined the music group and sang along (${TAG}).`);
  await write.getByRole("button", { name: "Save note" }).click();
  await expect(write.getByRole("status")).toHaveText("Note saved");

  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Modules" })
    .getByRole("link", { name: "Evidence packs" })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Evidence packs" })).toBeVisible();
  await bothThemes(page, "evidence packs");
  await main(page).getByRole("link", { name: "Compose a pack" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Compose an evidence pack" }),
  ).toBeVisible();

  // Nothing filled in: every problem is said at once, and there is no "everyone".
  await main(page).getByRole("button", { name: "Compose the pack" }).click();
  const summary = main(page).getByRole("alert");
  await expect(summary).toContainText("Enter the full name of the person the pack is for");
  await expect(summary).toContainText("Tick at least one person the pack is about");
  await bothThemes(page, "compose refused");

  await main(page).getByLabel("Their full name").fill(RECIPIENT);
  await main(page).getByLabel("Their organisation").fill("CQC");
  await main(page).getByLabel("Their work email address").fill(EMAIL);
  await main(page).getByLabel("What the pack is for").fill(`Assessment of Harbour House (${TAG})`);
  await today(page, "Records from");
  await today(page, "Records to");
  const locations = main(page).getByRole("group", { name: "Locations" });
  const house = locations.getByRole("checkbox", { name: "Harbour House" });
  if (!(await house.isChecked())) await house.check();
  await main(page)
    .getByRole("group", { name: "People the pack is about" })
    .getByRole("checkbox", { name: PERSON_NAME })
    .check();
  await main(page).getByRole("button", { name: "Compose the pack" }).click();
  await arrived(page, "Pack composed.");
  packUrl = new URL(page.url()).pathname;

  // What will be shared comes first, in full.
  const shared = page.getByRole("region", { name: "What will be shared" });
  await expect(shared).toContainText(EMAIL);
  await expect(shared).toContainText(PERSON_NAME);
  await expect(shared).toContainText("Staff shown by role only");
  // Each person in scope with a second identifier and their communication needs (AIS).
  await expect(shared).toContainText(`${PERSON_NAME}, born`);
  await expect(shared).toContainText("Communication needs");
  await expect(shared).toContainText(`Prepared for ${RECIPIENT}, CQC`);
  await bothThemes(page, "pack composed");

  // Add the note, as evidence for Safe.
  await main(page)
    .getByRole("link", { name: `Records for ${PERSON_NAME}` })
    .click();
  const add = main(page).getByRole("form", { name: "Their records in the pack's dates" });
  await add.getByRole("checkbox", { name: "Care note: activity" }).first().check();
  await add
    .getByRole("group", { name: "The areas these records are evidence for" })
    .getByRole("checkbox", { name: "Safe" })
    .check();
  await bothThemes(page, "adding records");
  await add.getByRole("button", { name: "Add to the pack" }).click();
  await arrived(page, /^Records added\./);

  // The note's text is free text: withheld until someone redacts it by hand.
  const records = page.getByRole("region", { name: /record in the pack|records in the pack/ });
  await expect(records.getByText("Withheld").first()).toBeVisible();
  await expect(main(page)).toContainText("withheld until someone redacts");
  await records
    .getByRole("link", { name: /^Redact by hand: Note,/ })
    .first()
    .click();
  // Focus starts on the form's heading, so its instructions are read before the box.
  await expect(main(page).getByRole("heading", { name: /^Redact by hand: Note/ })).toBeFocused();
  const redact = main(page).getByLabel("Redacted copy");
  // A note is not read again to prefill (DPIA R13): the composer types the redacted copy.
  await expect(redact).toHaveValue("");
  // A copy that still holds a long number is refused, in words.
  await redact.fill("Joined the music group. Call 999 000 0018 for more.");
  await main(page).getByRole("button", { name: "Save the redacted copy" }).click();
  await expect(main(page).getByRole("alert")).toBeVisible();
  await bothThemes(page, "redaction refused");
  await redact.fill("Joined the music group and sang along.");
  await main(page).getByRole("button", { name: "Save the redacted copy" }).click();
  await arrived(page, /^Redacted copy saved\./);
  await expect(records.getByText("Redacted by hand").first()).toBeVisible();

  // The composer is never offered release.
  await expect(main(page).getByRole("button", { name: "Release and make the link" })).toHaveCount(
    0,
  );
  await expect(main(page)).toContainText("Someone else must release this pack");
  await bothThemes(page, "pack ready for a second person");
});

test("hazard HZ-050 the owner, stepped up, reads what will be shared, releases it and sees the link once", async ({
  page,
}) => {
  test.setTimeout(180_000);
  expect(packUrl).not.toBe("");
  await signInWithDemoPasskey(page, "owner");
  await page.goto(packUrl);
  await expect(
    page.getByRole("heading", { level: 1, name: `For ${RECIPIENT}, CQC` }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "What will be shared" })).toContainText(EMAIL);

  const release = main(page).getByRole("form", { name: "Release the pack" });
  // The expiry is said in words before anything is sent.
  await expect(release).toContainText(
    /The link will stop working at \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/,
  );
  await release.getByLabel("How long the link works").selectOption("3");
  await expect(release).toContainText("in 3 days");
  // Releasing without confirming the read-through is refused.
  await release.getByRole("button", { name: "Release and make the link" }).click();
  await expect(main(page).getByRole("alert")).toContainText("Confirm you have read every record");
  await bothThemes(page, "release form");
  await release
    .getByRole("checkbox", { name: "I have read every record and redaction in this pack" })
    .check();
  await release.getByRole("button", { name: "Release and make the link" }).click();

  const issued = main(page).getByRole("region", { name: "Pack released: copy the link now" });
  await expect(issued).toBeVisible();
  await expect(
    issued.getByRole("heading", { name: "Pack released: copy the link now" }),
  ).toBeFocused();
  await expect(issued).toContainText(
    `This is the only time the link is shown. Send it to ${EMAIL}.`,
  );
  const linkField = issued.getByLabel("Link for the recipient");
  // The token rides in the fragment, never the path or query.
  await expect(linkField).toHaveValue(/\/evidence#[A-Za-z0-9_-]{43}$/);
  inspectorLink = await linkField.inputValue();
  await bothThemes(page, "link issued");

  await issued.getByRole("button", { name: "I have sent the link" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  await expect(
    main(page)
      .getByRole("status")
      .filter({ hasText: /^Pack released\./ }),
  ).toBeVisible();
  await expect(main(page).getByText("Pack released: copy the link now")).toHaveCount(0);
  const links = page.getByRole("region", { name: "Links" });
  await expect(links).toContainText("Working");
  await expect(links).toContainText(/Works until \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}, in 3 days/);
  await expect(main(page)).toContainText("Released");
  await bothThemes(page, "pack released");
});

test("hazard HZ-050 the inspector opens the link in their own browser with an emailed code and downloads the pack", async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  expect(inspectorLink).not.toBe("");
  const token = inspectorLink.split("#")[1] ?? "";
  const { context, page, urls } = await inspector(browser, testInfo);
  await page.goto(inspectorLink);
  // The token leaves the address bar at once and no request ever carries it in its URL.
  await expect(page.getByRole("heading", { name: "Open the evidence pack" })).toBeFocused();
  expect(page.url()).not.toContain("#");
  // A router refresh never writes the token back into the address (#113 security review L2).
  await page.evaluate(() =>
    (window as unknown as { next?: { router?: { refresh(): void } } }).next?.router?.refresh(),
  );
  await page.waitForLoadState("networkidle");
  expect(page.url()).not.toContain("#");
  await expect(page).toHaveTitle(/^Evidence pack/);
  await bothThemes(page, "inspector link");

  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.getByRole("heading", { name: "Enter the code from your email" })).toBeFocused();
  await expect(page.getByText("Code sent. Check your email.")).toBeVisible();
  // A code that does not match is said at the field, and the summary links to it.
  await page.getByLabel("Six-digit code").fill("000000");
  await page.getByRole("button", { name: "Open the pack" }).click();
  const summary = page.getByRole("main").getByRole("alert");
  await expect(summary).toContainText("That code did not match");
  await expect(page.getByLabel("Six-digit code")).toHaveAttribute("aria-invalid", "true");
  await summary.getByRole("link").first().click();
  await expect(page.getByLabel("Six-digit code")).toBeFocused();
  await bothThemes(page, "inspector code refused");

  await page.getByLabel("Six-digit code").fill(plantedCode());
  await page.getByRole("button", { name: "Open the pack" }).click();
  await expect(page.getByRole("heading", { name: "Your evidence pack is ready" })).toBeFocused();
  await bothThemes(page, "inspector pack ready");
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download the pack" }).click(),
  ]);
  expect(file.suggestedFilename()).toBe("evidence-pack.pdf");
  const chunks: Buffer[] = [];
  for await (const chunk of await file.createReadStream()) chunks.push(chunk as Buffer);
  expect(Buffer.concat(chunks).subarray(0, 5).toString()).toBe("%PDF-");
  await expect(page.getByText("Pack downloaded. Look in your downloads.")).toBeVisible();
  expect(urls.filter((url) => url.includes(token))).toEqual([]);

  // Finishing removes this browser's access: the session cookie goes, and the page says so.
  await page.getByRole("button", { name: "Finish and remove access from this browser" }).click();
  await expect(
    page.getByRole("heading", { name: "Access removed from this browser" }),
  ).toBeFocused();
  expect(
    (await context.cookies()).filter((c) => c.name === "__Host-harbour_evidence_session"),
  ).toEqual([]);
  await bothThemes(page, "inspector access removed");
  await page.goto("/evidence");
  await page.getByRole("button", { name: "Download the pack" }).click();
  await expect(page.getByRole("heading", { name: "This link is not complete" })).toBeFocused();
  await context.close();
});

test("hazard HZ-050 the manager withdraws the pack and its link stops", async ({ page }) => {
  expect(packUrl).not.toBe("");
  await signIn(page, "manager@example.invalid");
  await page.goto(packUrl);
  const end = main(page).getByRole("form", { name: "Withdraw this pack" });
  await end.getByLabel("Reason").fill(`The inspection is over (${TAG})`);
  await expect(end).toContainText("This cannot be undone");
  await end.getByRole("checkbox", { name: "I understand this cannot be undone" }).check();
  await bothThemes(page, "withdraw form");
  await end.getByRole("button", { name: "Withdraw the pack" }).click();
  await arrived(page, /^Pack withdrawn\./);
  await expect(page.getByRole("region", { name: "Links" })).toContainText("Withdrawn");
  await expect(main(page)).toContainText("The content of this pack has been deleted");
  await bothThemes(page, "pack withdrawn");
});

test("hazard HZ-050 a withdrawn link says so in the inspector's browser and offers no code", async ({
  browser,
}, testInfo) => {
  expect(inspectorLink).not.toBe("");
  const { context, page } = await inspector(browser, testInfo);
  await page.goto(inspectorLink);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.getByRole("heading", { name: "This pack has been withdrawn" })).toBeFocused();
  await expect(page.getByRole("button", { name: /code/ })).toHaveCount(0);
  await bothThemes(page, "inspector link withdrawn");
  // Opened again without its token: says the link is not complete.
  await page.goto("/evidence");
  await expect(page.getByRole("heading", { name: "This link is not complete" })).toBeFocused();
  await bothThemes(page, "inspector link without its token");
  await context.close();
});
