// @vitest-environment jsdom
import type { ClassifierView, StatutoryNotificationSummary } from "@harbour/contracts";
import axe from "axe-core";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { IncidentNotifications } from "./IncidentNotifications";

/**
 * Every state of the notifications section on an incident (#49 review, HZ-013), drawn and checked
 * with axe-core for WCAG 2.2 AA. The journey (e2e/incidents.spec.ts) covers the states the demo
 * data can reach; these cover the rest: due, submitted, not required, ready, a Harbour target,
 * not checked yet, outside England, waiting for answers, none found and an unknown clock.
 * Contrast is left to the journey's real browser: jsdom does not paint.
 */

const NOW = new Date("2026-10-12T16:05:00Z");
const PERSON = "0194d000-0000-7000-8600-000000000003";
const HIDDEN = "0194d000-0000-7000-8600-000000000005";
const names = new Map([[PERSON, "Cara Placeholder"]]);
const manager = { canSubmit: false, canManage: true };

const notification = (over: Partial<StatutoryNotificationSummary>): StatutoryNotificationSummary =>
  ({
    id: `n-${over.kind ?? "cqc_reg18_police"}-${over.status ?? "draft"}`,
    kind: "cqc_reg18_police",
    label: "",
    recipient: "",
    statutory: true,
    status: "draft",
    provisional: false,
    noLongerIndicated: false,
    noLongerIndicatedReason: null,
    dueAt: "2026-10-12T13:05:00Z",
    clock: "overdue",
    locationId: "0194d000-0000-7000-8000-000000000101",
    incidentId: "0194d000-0000-7000-8700-000000000001",
    personId: null,
    dolsAuthorisationId: null,
    version: 1,
    ...over,
  }) as StatutoryNotificationSummary;

const classifier = (over: Partial<ClassifierView>): ClassifierView => ({
  classifierVersion: "test",
  classifiedAt: "2026-10-12T13:10:00Z",
  nationSupported: true,
  outputs: [],
  exclusions: [],
  pending: [],
  openQuestions: [],
  tasks: [],
  reasoning: [],
  notifications: [],
  ...over,
});

function draw(view: ClassifierView | null, access = manager) {
  document.body.innerHTML = `<main><h1>Incident</h1><section aria-labelledby="h"><h2 id="h">Statutory notifications</h2>${renderToStaticMarkup(
    <IncidentNotifications classifier={view} access={access} names={names} now={NOW} />,
  )}</section></main>`;
  return document.body;
}

async function expectAccessible(body: HTMLElement) {
  const results = await axe.run(body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

const text = (body: HTMLElement) => body.textContent ?? "";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the statutory notifications on an incident, every state (HZ-013)", () => {
  it.each<[string, ClassifierView | null, readonly string[]]>([
    [
      "not checked yet",
      null,
      ["Notifications not checked yet", "Ask a nurse or the Registered Manager to check it."],
    ],
    [
      "outside England",
      classifier({ nationSupported: false }),
      [
        "Notifications are not checked outside England",
        "Check what your nation's regulator needs.",
      ],
    ],
    [
      "may be needed once answered",
      classifier({
        openQuestions: [{ key: "police.involved" } as ClassifierView["openQuestions"][number]],
        pending: [{ kind: "cqc_reg18_police", waitingFor: ["police.involved"] }],
      }),
      [
        "1 question to answer before Harbour can say which notifications are needed",
        "The questions are not on this page yet.",
        "May be needed once they are answered: Incident reported to or investigated by the police",
      ],
    ],
    [
      "none found",
      classifier({}),
      ["Harbour found no statutory notification to make on what is recorded so far"],
    ],
  ])("hazard HZ-013 says %s in words, with no axe violations", async (_, view, words) => {
    const body = draw(view);
    for (const word of words) expect(text(body)).toContain(word);
    await expectAccessible(body);
  });

  it("hazard HZ-013 shows each notification's clock, status, deadlines and warnings, with no axe violations", async () => {
    const body = draw(
      classifier({
        outputs: [
          {
            kind: "riddor_specified_injury",
            dueAt: "2026-10-12T13:05:00Z",
            deadlines: [
              {
                key: "notify_without_delay",
                dueAt: "2026-10-12T13:05:00Z",
                wording: "",
                statutory: true,
              },
              {
                key: "report_received",
                dueAt: "2026-10-22T13:05:00Z",
                wording: "",
                statutory: true,
              },
            ],
            reasons: [],
            provisional: false,
            requiredContent: [],
          },
        ],
        notifications: [
          notification({ kind: "riddor_specified_injury", clock: "due", status: "ready" }),
          notification({ kind: "safeguarding_s42", statutory: false, provisional: true }),
          notification({ kind: "cqc_reg16_death", personId: PERSON, clock: "due" }),
          notification({ kind: "leder", personId: HIDDEN, statutory: false, clock: "due" }),
          notification({ kind: "candour", clock: "done", status: "submitted" }),
          notification({ kind: "cqc_reg18_police", clock: "done", status: "not_required" }),
          notification({ kind: "cqc_reg18_abuse", clock: "paused" as never }),
        ],
      }),
    );
    const item = (kind: string) =>
      body.querySelector<HTMLElement>(`[data-notification="${kind}"]`) ?? body;
    const riddor = item("riddor_specified_injury");
    expect(text(riddor)).toContain("Due");
    expect(text(riddor)).toContain("Ready to submit");
    expect(text(riddor)).toContain("The report must be received by 22/10/2026 14:05");
    expect(riddor.querySelectorAll("time")[1]?.getAttribute("datetime")).toBe(
      "2026-10-22T13:05:00Z",
    );
    const s42 = item("safeguarding_s42");
    expect(text(s42)).toContain("Overdue for 3 hours");
    expect(text(s42)).toContain("Draft");
    expect(text(s42)).toContain("If in doubt, notify.");
    expect(text(s42)).toContain("make it as soon as possible all the same");
    expect(text(item("cqc_reg16_death"))).toContain("About Cara Placeholder");
    expect(text(item("leder"))).toContain("About a person we support (not shown to you), person 1");
    expect(text(item("candour"))).toContain("Submitted");
    expect(item("candour").querySelector("time")).toBeNull();
    const notRequired = item("cqc_reg18_police");
    expect(text(notRequired)).toContain("Not required");
    expect(notRequired.querySelector('[data-status="notApplicable"]')).not.toBeNull();
    expect(text(item("cqc_reg18_abuse"))).toContain("Clock not known");
    // A clock the web does not know first, then overdue, then the soonest due, then done.
    const order = [...body.querySelectorAll("[data-notification]")].map((li) =>
      li.getAttribute("data-notification"),
    );
    expect(order.slice(0, 2)).toEqual(["cqc_reg18_abuse", "safeguarding_s42"]);
    expect(order.slice(-2).sort()).toEqual(["candour", "cqc_reg18_police"]);
    await expectAccessible(body);
  });
});
