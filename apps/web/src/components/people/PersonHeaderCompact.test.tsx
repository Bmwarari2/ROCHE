// @vitest-environment jsdom
import type { PersonSummary } from "@harbour/contracts";
import axe from "axe-core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PersonHeaderCompact } from "./PersonHeader";

const ada: PersonSummary = {
  id: "0194d000-0000-7000-8a00-000000000001",
  locationId: "0194d000-0000-7000-8000-000000000101",
  status: "active",
  givenName: "Ada",
  familyName: "Example",
  preferredName: null,
  dateOfBirth: "1938-02-01",
  nhsNumber: "9990000018",
  roomLabel: "12",
  photoUrl: null,
  allergyStatus: "has_allergies",
  allergies: [{ substance: "Penicillin", severity: "severe", reaction: "Rash" }],
  communicationNeeds: [{ code: "demo:large-print", display: "Needs information in large print" }],
  communicationNeedsStatus: "recorded",
  communicationNeedsConfirmedBy: null,
  communicationNeedsConfirmedAt: null,
  iddsiFoodLevel: "6",
  iddsiDrinkLevel: "not_recorded",
  statusChangedAt: "2026-09-01T00:00:00.000Z",
  resuscitation: {
    status: "not_recorded",
    conflicting: false,
    recordId: null,
    kind: null,
    completedOn: null,
    clinicianName: null,
    clinicianRole: null,
    reviewDueOn: null,
    reviewOverdue: false,
  },
  sample: false,
  version: 1,
};

describe("PersonHeaderCompact", () => {
  it("hazard HZ-001 names the person with photo, room, allergies, resuscitation, IDDSI levels and communication needs", async () => {
    document.body.innerHTML = `<main><h1>Round</h1><h2>Ground floor</h2>${renderToStaticMarkup(
      <PersonHeaderCompact person={ada} />,
    )}</main>`;
    const heading = document.querySelector("h3");
    expect(heading?.textContent).toBe("Ada Example, room 12");
    expect(heading?.querySelector("a")?.getAttribute("href")).toBe(`/people/${ada.id}`);
    const text = document.body.textContent ?? "";
    for (const term of [
      "Allergies",
      "Resuscitation",
      "Food texture (IDDSI)",
      "Drink thickness (IDDSI)",
      "Communication needs",
    ]) {
      expect([...document.querySelectorAll("dt")].map((dt) => dt.textContent)).toContain(term);
    }
    expect(text).toContain("Level 6 Soft and bite-sized (blue)");
    // HZ-016: a level not recorded is never blank and never read as a normal diet.
    expect(text).toContain("Not recorded: check with the nurse in charge before giving any drink");
    const results = await axe.run(document.body, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });

  it("hazard HZ-072 shows the Sample badge, an icon and a word, beside a sample person only", async () => {
    document.body.innerHTML = `<main><h1>Round</h1><h2>Ground floor</h2>${renderToStaticMarkup(
      <PersonHeaderCompact person={{ ...ada, sample: true }} />,
    )}</main>`;
    const badge = document.querySelector("[data-sample-badge]");
    expect(badge?.textContent).toBe("Sample");
    expect(badge?.querySelector("svg")).not.toBeNull();
    const results = await axe.run(document.body, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations.map((v) => v.id)).toEqual([]);
    document.body.innerHTML = renderToStaticMarkup(<PersonHeaderCompact person={ada} />);
    expect(document.querySelector("[data-sample-badge]")).toBeNull();
  });
});
