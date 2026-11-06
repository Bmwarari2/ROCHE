import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { expectAccessible, signIn } from "./support";
import { buildZip } from "./zip";

/**
 * E-learning (slice 43; WORK-006; ADR-0093) against the demo tenant. The owner (a training lead
 * here) adds a SCORM 1.2 course from a package whose own script uses the SCORM API, and an unsafe
 * package is refused. The care worker opens it: it runs on the content origin (the same server
 * under 127.0.0.1, another site from localhost) inside Harbour's runtime page, the package's
 * button finishes it, and the pass reaches the app through the postMessage protocol and becomes a
 * training record. The content origin serves no app page, and the app origin serves no content.
 * Each state is checked with axe in light and dark.
 */

const RUN = randomUUID().slice(0, 8);
const TITLE = `Fire safety ${RUN}`;
const CONTENT = process.env.ELEARNING_ORIGIN ?? "http://127.0.0.1:3000";

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.getByRole("main");

async function bothThemes(page: Page, name: string) {
  await expectAccessible(page, `${name} (light)`);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, `${name} (dark)`);
  await page.emulateMedia({ colorScheme: "light" });
}

const MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="fire-${RUN}" version="1.0" xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="o"><organization identifier="o"><title>${TITLE}</title>
    <item identifier="i" identifierref="r"><title>Lesson</title></item></organization></organizations>
  <resources><resource identifier="r" type="webcontent" adlcp:scormtype="sco" href="index.html"/></resources>
</manifest>`;

const PAGE = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>Lesson</title></head>
<body><main><h1>Fire safety lesson</h1><p id="hello">Loading</p>
<button id="finish" type="button" style="min-height:44px">Finish the lesson</button></main>
<script src="app.js"></script></body></html>`;

const SCRIPT = `var api = window.parent.API;
api.LMSInitialize("");
document.getElementById("hello").textContent = "Hello, " + api.LMSGetValue("cmi.core.student_name");
document.getElementById("finish").onclick = function () {
  api.LMSSetValue("cmi.core.lesson_status", "passed");
  api.LMSSetValue("cmi.core.score.raw", "90");
  api.LMSSetValue("cmi.core.session_time", "00:01:00");
  api.LMSFinish("");
  document.getElementById("hello").textContent = "Lesson finished";
};`;

async function addCourse(page: Page, title: string, zip: Buffer) {
  const card = main(page).getByRole("region", { name: "Add a course" });
  await card.getByLabel("Course title").fill(title);
  await card.getByLabel("Training topic").selectOption({ label: "Fire safety" });
  await card
    .getByLabel("Package")
    .setInputFiles({ name: "course.zip", mimeType: "application/zip", buffer: zip });
  await card.getByRole("button", { name: "Add the course" }).click();
  return card;
}

test("a training lead adds a course, and an unsafe package is refused", async ({ page }) => {
  await signIn(page, "owner@example.invalid");
  await page.goto("/training/elearning");
  const unsafe = buildZip([
    { name: "imsmanifest.xml", data: MANIFEST },
    { name: "index.html", data: PAGE },
    { name: "../../escape.html", data: "x" },
  ]);
  const card = await addCourse(page, `Unsafe ${RUN}`, unsafe);
  await expect(card.getByRole("alert")).toContainText("points outside the package");
  await addCourse(
    page,
    TITLE,
    buildZip([
      { name: "imsmanifest.xml", data: MANIFEST },
      { name: "index.html", data: PAGE },
      { name: "app.js", data: SCRIPT },
    ]),
  );
  await expect(card.getByText("Course added")).toBeVisible();
  await expect(main(page).getByRole("link", { name: TITLE })).toBeVisible();
  await bothThemes(page, "courses for a training lead");
});

test("a care worker takes the course on the content origin and passes it", async ({ page }) => {
  await signIn(page, "carer@example.invalid");
  await page
    .getByRole("navigation", { name: "Modules" })
    .getByRole("link", { name: "E-learning" })
    .click();
  await expect(main(page).getByRole("region", { name: "Add a course" })).toHaveCount(0);
  await main(page).getByRole("link", { name: TITLE }).click();
  await expect(main(page).getByText("Not started", { exact: true })).toBeVisible();
  await main(page).getByRole("button", { name: "Start the course" }).click();
  const runtime = page.frameLocator(`iframe[title="Course: ${TITLE}"]`);
  const lesson = runtime.frameLocator("#content");
  // The package is told the first name only (security review M8).
  await expect(lesson.getByText("Hello, Cat", { exact: true })).toBeVisible();
  // The package runs on another site: its frame's address is the content origin.
  const frames = page.frames().map((f) => f.url());
  expect(frames.some((u) => u.startsWith(`${CONTENT}/learn/`))).toBe(true);
  await bothThemes(page, "course player");
  await lesson.getByRole("button", { name: "Finish the lesson" }).click();
  await expect(main(page).getByRole("status").filter({ hasText: "Course passed" })).toBeVisible();
  await page.goto("/training/elearning");
  const item = main(page).getByRole("listitem").filter({ hasText: TITLE });
  await expect(item.getByText("Passed", { exact: true })).toBeVisible();
  await expect(item.getByText("Score 90%")).toBeVisible();
  await bothThemes(page, "course passed");
});

test("the content origin serves no app page, and the app origin serves no content", async ({
  request,
}) => {
  const home = await request.get(`${CONTENT}/`, { maxRedirects: 0 });
  expect(home.status()).toBe(404);
  const signInPage = await request.get(`${CONTENT}/sign-in`, { maxRedirects: 0 });
  expect(signInPage.status()).toBe(404);
  // Route handlers and prefetches are refused on the content host too (security review M4).
  const health = await request.get(`${CONTENT}/api/health`, { maxRedirects: 0 });
  expect(health.status()).toBe(404);
  const prefetch = await request.get(`${CONTENT}/`, {
    maxRedirects: 0,
    headers: { "next-router-prefetch": "1" },
  });
  expect(prefetch.status()).toBe(404);
  const token = `${"a".repeat(40)}.${"b".repeat(43)}`;
  const onApp = await request.get(`/learn/${token}`, { maxRedirects: 0 });
  expect(onApp.status()).toBe(404);
  const runtime = await request.get(`${CONTENT}/learn/${token}/_harbour/runtime.js`);
  expect(runtime.status()).toBe(200);
  expect(runtime.headers()["content-security-policy"]).toContain("default-src 'none'");
});
