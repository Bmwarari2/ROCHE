import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { demoPerson, expectAccessible, signIn, signInWithDemoPasskey } from "./support";

/**
 * Phase 1: after a death on an incident (register row SAFE-008; safety.md rules 6 and 8; hazard
 * HZ-013) against the demo tenant. The Registered Manager sees the medical examiner pack's
 * notification with its clock and every section of the pack with where it is kept, and the LeDeR
 * prompt: asked to check when learning disability and autism are not recorded, told to report on
 * LeDeR's own form when the LeDeR notification is drafted. Each run adds its own incidents, marked
 * with the run, and changes nothing already there. Axe in both themes.
 */

const RUN = `run ${Date.now().toString(36)}`;
const API_URL = process.env.API_URL ?? "http://localhost:4000";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";
const DEMO_LOCATION = "0194d000-0000-7000-8000-000000000101";
const LEDER = "https://leder.nhs.uk/report";

interface Incident {
  readonly id: string;
  readonly classifier: { readonly notifications: readonly { id: string; kind: string }[] } | null;
}

/** A fall in which a person we support died, recorded through the API. */
async function death(
  request: APIRequestContext,
  description: string,
  person: Record<string, unknown> = {},
): Promise<Incident> {
  const response = await request.post(`${API_URL}/v1/incidents`, {
    headers: { "x-harbour-tenant": DEMO_TENANT },
    data: {
      locationId: DEMO_LOCATION,
      type: "fall",
      occurredAt: new Date(Date.now() - 40 * 60_000).toISOString(),
      description: `${description} (${RUN}).`,
      emergencyServicesCalled: true,
      gpContacted: true,
      people: [
        { kind: "service_user", role: "affected", personId: demoPerson(3), died: true, ...person },
      ],
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as Incident;
}

const region = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

test("hazard HZ-013 after a death the manager sees the medical examiner pack and is asked to check LeDeR", async ({
  page,
}) => {
  // Two pages, each checked with axe in both themes.
  test.setTimeout(120_000);
  await signIn(page, "manager@example.invalid");
  const incident = await death(page.request, "Found on the floor of the lounge, not breathing");
  await page.goto(`/incidents/${incident.id}`);

  const after = region(page, "After a death");
  // Whether they had a learning disability or were autistic is not on the incident: check.
  await expect(after.getByText("Check whether LeDeR applies")).toBeVisible();
  await expect(
    after.getByRole("link", { name: "Report a death on the LeDeR website" }),
  ).toHaveAttribute("href", LEDER);
  // The pack's notification, with its clock, and every section with where it is kept.
  await expect(
    after.getByRole("link", { name: "Open the notification: medical examiner information pack" }),
  ).toBeVisible();
  for (const section of [
    "Demographics",
    "Diagnoses and conditions",
    "Recent care notes",
    "Recent observations",
    "Medicines",
    "Advance care records",
    "Circumstances of the death",
  ]) {
    await expect(after.getByText(section, { exact: true })).toBeVisible();
  }
  await expect(
    after.getByRole("link", { name: "Where to find it: their record, Notes" }),
  ).toBeVisible();
  await expect(after.getByText("Where to find it: this incident, above")).toBeVisible();
  await expectAccessible(page, "after a death");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, "after a death, dark theme");
  await page.emulateMedia({ colorScheme: "light" });

  // The notification's own page lists the pack too, the circumstances linked to the incident.
  await after
    .getByRole("link", { name: "Open the notification: medical examiner information pack" })
    .click();
  await page.waitForURL(/\/notifications\/statutory\/[0-9a-f-]{36}$/);
  const pack = region(page, "Medical examiner information pack");
  await expect(pack.getByText("Circumstances of the death", { exact: true })).toBeVisible();
  await expect(pack.getByRole("link", { name: "Where to find it: the incident" })).toHaveAttribute(
    "href",
    `/incidents/${incident.id}`,
  );
  await expectAccessible(page, "medical examiner notification");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, "medical examiner notification, dark theme");
  await page.emulateMedia({ colorScheme: "light" });
});

test("hazard HZ-013 a drafted LeDeR notification says to report on LeDeR's own form, then follows its status", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // A passkey sign-in: deciding the notification is not required needs step-up.
  await signInWithDemoPasskey(page);
  const incident = await death(page.request, "Found in bed, not breathing", {
    learningDisability: true,
  });
  const leder = incident.classifier?.notifications.find((n) => n.kind === "leder");
  expect(leder, "a LeDeR notification draft").toBeDefined();
  await page.goto(`/incidents/${incident.id}`);
  const after = region(page, "After a death");
  await expect(after.getByText("Report the death to LeDeR")).toBeVisible();
  await expect(
    after.getByRole("link", { name: "Open the notification: LeDeR notification" }),
  ).toHaveAttribute("href", `/notifications/statutory/${leder?.id}`);
  await expectAccessible(page, "after a death, LeDeR drafted");

  await page.goto(`/notifications/statutory/${leder?.id}`);
  await expect(
    page.getByText(
      "Report the death on LeDeR's online form, which anyone can use, then record it as submitted below.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Report a death on the LeDeR website" }),
  ).toHaveAttribute("href", LEDER);
  await expectAccessible(page, "LeDeR notification");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page, "LeDeR notification, dark theme");
  await page.emulateMedia({ colorScheme: "light" });

  // Recorded as not required: the incident says so, and no longer says the person had a
  // learning disability or was autistic (review M1).
  const path = `${API_URL}/v1/notifications/statutory/${leder?.id}`;
  const headers = { "x-harbour-tenant": DEMO_TENANT };
  const current = (await (await page.request.get(path, { headers })).json()) as {
    version: number;
  };
  const decided = await page.request.post(`${path}/not-required`, {
    headers,
    data: { reason: `Recorded twice for the same death (${RUN}).`, version: current.version },
  });
  expect(decided.status(), await decided.text()).toBe(200);
  await page.goto(`/incidents/${incident.id}`);
  const now = region(page, "After a death");
  await expect(now.getByText("LeDeR notification recorded as not required")).toBeVisible();
  await expect(now.getByText(/had a learning disability/)).toHaveCount(0);
  await expectAccessible(page, "after a death, LeDeR not required");
});
