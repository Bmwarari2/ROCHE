import { Text } from "@harbour/ui-native";
import { createElement } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import { resuscitationFlag } from "../care/person-summary";
import { type AdvanceCareRow, PERSON_ADVANCE_CARE_SQL } from "../care/queries";
import { DEMO_TENANT_ID, demoPeople } from "../demo/demo-data";
import { type PersonView, toPersonView } from "../people/person-view";
import { PERSON_SQL, type PersonRow, personParams } from "../people/queries";
import { all, openLocalDatabase, type SqliteDatabase } from "../test-support/local-db";
import { type RenderedNode, render } from "../test-support/render";
import { FormLayout, type FormLayoutProps } from "./FormLayout";
import { IdentityBarView } from "./IdentityBarView";

/**
 * Hazard HZ-001 (wrong person), clinical reviews C7 and round 3 M4: the identity bar pinned above
 * every form, and the form's order, are rendered from the device's own rows with the invented demo
 * records, not looked for in a source file.
 */

const [ADA, BEA] = demoPeople.map((p) => p.id) as [string, string];
const TODAY = "2026-10-11";
const PHOTO = { uri: "https://api.example.invalid/v1/documents/photo-fixture" };
let db: SqliteDatabase;

beforeAll(async () => {
  db = await openLocalDatabase({ seedDemo: new Date("2026-10-11T09:00:00Z") });
});

function personFor(personId: string): { person: PersonView; advanceCare: AdvanceCareRow[] } {
  const [row] = all<PersonRow>(db, PERSON_SQL, personParams(DEMO_TENANT_ID, personId));
  if (!row) throw new Error("person not on the device");
  const advanceCare = all<AdvanceCareRow>(db, PERSON_ADVANCE_CARE_SQL, [DEMO_TENANT_ID, personId]);
  return { person: toPersonView(row), advanceCare };
}

function bar(personId: string, photo: { uri: string } | null = PHOTO) {
  const { person, advanceCare } = personFor(personId);
  const { flag } = resuscitationFlag(advanceCare, TODAY);
  return {
    person,
    element: createElement(IdentityBarView, { person, photo, resuscitation: flag }),
  };
}

function testIdsIn(node: RenderedNode | string): string[] {
  if (typeof node === "string") return [];
  const own = typeof node.props.testID === "string" ? [node.props.testID] : [];
  return [...own, ...(node.children ?? []).flatMap(testIdsIn)];
}

describe("hazard HZ-001 the pinned identity bar shows who the form is for (round 3 M4)", () => {
  it("hazard HZ-001 draws the photo, name, allergies, communication needs and resuscitation status", async () => {
    const { person, element } = bar(ADA);
    expect(person.communicationNeeds.length).toBeGreaterThan(0);
    const view = await render(element);
    const texts = view.texts();
    expect(texts).toContain(person.displayName);
    // The communication need is flagged, not counted as none (it was always 0 before).
    expect(texts.some((x) => x.startsWith("Communication need"))).toBe(true);
    expect(texts.some((x) => x.startsWith("Allergies") || x === "No known allergies")).toBe(true);
    expect(texts.some((x) => x.startsWith("Resuscitation") || x.includes("CPR"))).toBe(true);
    // The photo itself, not only initials.
    const photo = view.find("identity-bar-photo");
    expect(photo?.props.source).toEqual(PHOTO);
  });

  it("hazard HZ-001 shows no communication flag for someone with none recorded", async () => {
    const { person, element } = bar(BEA);
    expect(person.communicationNeeds).toEqual([]);
    const texts = (await render(element)).texts();
    expect(texts.some((x) => x.startsWith("Communication need"))).toBe(false);
  });

  it("hazard HZ-001 falls back to initials when there is no photo", async () => {
    const { element } = bar(ADA, null);
    const view = await render(element);
    expect(view.find("identity-bar-photo")?.props.source).toBeUndefined();
  });
});

describe("hazard HZ-001 the form keeps the person in view and saves only once they are shown (C7)", () => {
  async function form(personLoaded: boolean) {
    const saves: number[] = [];
    const { element } = bar(ADA);
    const view = await render(
      createElement(
        FormLayout,
        {
          identityBar: element,
          header: createElement(Text, { testID: "full-header" }, "Full header"),
          personLoaded,
          showErrors: false,
          saveFailed: false,
          saving: false,
          onSave: () => {
            saves.push(1);
          },
        } as FormLayoutProps,
        createElement(Text, { testID: "form-fields" }, "Fields"),
      ),
    );
    return { view, saves };
  }

  it("hazard HZ-001 pins the identity bar outside the scrolling form, with the header first inside it", async () => {
    const { view } = await form(true);
    const [first, second] = view.nodes();
    expect(first?.props.testID).toBe("identity-bar");
    expect(second?.props.testID).toBe("form-keyboard");
    const scroll = second?.children?.find(
      (c): c is RenderedNode => typeof c !== "string" && c.props.testID === "form-scroll",
    );
    const inside = scroll ? testIdsIn(scroll) : [];
    expect(inside).not.toContain("identity-bar");
    expect(inside.indexOf("full-header")).toBe(1);
    expect(inside.indexOf("full-header")).toBeLessThan(inside.indexOf("form-fields"));
  });

  it("hazard HZ-001 hides Save until the person has loaded", async () => {
    const hidden = await form(false);
    expect(hidden.view.find("save-entry")).toBeNull();
    const shown = await form(true);
    expect(shown.view.find("save-entry")).not.toBeNull();
    await shown.view.press("save-entry");
    expect(shown.saves).toEqual([1]);
  });
});
