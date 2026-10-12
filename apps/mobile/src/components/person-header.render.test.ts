import { PersonHeader } from "@harbour/ui-native";
import { act, createElement, type ReactElement } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import { carePersonHeaderModel } from "../care/person-header";
import {
  type AdvanceCareRow,
  CARE_PROFILE_SQL,
  type CareProfileRow,
  PERSON_ADVANCE_CARE_SQL,
} from "../care/queries";
import { DEMO_TENANT_ID, demoPeople } from "../demo/demo-data";
import { toPersonView } from "../people/person-view";
import { PERSON_SQL, type PersonRow, personParams } from "../people/queries";
import { all, openLocalDatabase, type SqliteDatabase } from "../test-support/local-db";

/**
 * Hazard HZ-001 (wrong person): the point-of-care header is rendered, not looked for in a file
 * (clinical review C11). The rows come from the device's own tables with the invented demo
 * records, go through the same model the header component uses, and `PersonHeader` is drawn with
 * react-test-renderer against a stand-in for the native runtime. The test then reads what a carer
 * would see.
 */

interface RenderedNode {
  readonly type: string;
  readonly props: Record<string, unknown>;
  readonly children: ReadonlyArray<RenderedNode | string> | null;
}

interface TestRendererModule {
  create(element: ReactElement): {
    toJSON(): RenderedNode | RenderedNode[] | null;
    unmount(): void;
  };
}

async function render(element: ReactElement): Promise<RenderedNode[]> {
  // A variable module name keeps the renderer, a test-only package, out of the app's type graph.
  const name = "react-test-renderer";
  const renderer = (await import(/* @vite-ignore */ name)) as TestRendererModule;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: ReturnType<TestRendererModule["create"]> | null = null;
  await act(async () => {
    root = renderer.create(element);
  });
  // Read once the render has been committed, after act.
  const json = (root as ReturnType<TestRendererModule["create"]> | null)?.toJSON() ?? null;
  return json === null ? [] : Array.isArray(json) ? json : [json];
}

/** Every piece of text drawn, in order, with each Text element's children joined. */
function textsOf(nodes: ReadonlyArray<RenderedNode | string>): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (typeof node === "string") continue;
    if (node.type === "Text") {
      out.push((node.children ?? []).filter((c): c is string => typeof c === "string").join(""));
    }
    out.push(...textsOf((node.children ?? []).filter((c) => typeof c !== "string")));
  }
  return out;
}

const [ADA, , CAL] = demoPeople.map((p) => p.id) as [string, string, string];
const TODAY = "2026-10-11";
let db: SqliteDatabase;

beforeAll(async () => {
  db = await openLocalDatabase({ seedDemo: new Date("2026-10-11T09:00:00Z") });
});

async function renderHeaderFor(personId: string, options: { dropProfile?: boolean } = {}) {
  const [row] = all<PersonRow>(db, PERSON_SQL, personParams(DEMO_TENANT_ID, personId));
  if (!row) throw new Error("person not on the device");
  const advanceCare = all<AdvanceCareRow>(db, PERSON_ADVANCE_CARE_SQL, [DEMO_TENANT_ID, personId]);
  const [profile] = options.dropProfile
    ? []
    : all<CareProfileRow>(db, CARE_PROFILE_SQL, [DEMO_TENANT_ID, personId]);
  const person = toPersonView(row);
  const model = carePersonHeaderModel({
    person,
    advanceCare,
    profile: profile ?? null,
    profileLoaded: true,
    today: TODAY,
  });
  const nodes = await render(createElement(PersonHeader, { photo: null, ...model.props }));
  return { person, texts: textsOf(nodes), nodes };
}

describe("hazard HZ-001 the point-of-care header renders who this is", () => {
  it("draws the name, date of birth, NHS number, allergies, resuscitation status and IDDSI levels", async () => {
    const { person, texts } = await renderHeaderFor(ADA);
    expect(texts).toContain(person.knownAs);
    const identifiers = texts.find((x) => x.startsWith("Born "));
    expect(identifiers).toMatch(/^Born \d{2}\/\d{2}\/\d{4} {2}· {2}NHS number 999 \d{3} \d{4}$/);
    // Allergies (HZ-007) and the resuscitation status (HZ-015) are always there, in words.
    expect(texts.some((x) => x.startsWith("Allergies") || x === "No known allergies")).toBe(true);
    expect(texts.some((x) => x.startsWith("Resuscitation") || x.includes("CPR"))).toBe(true);
    // The prescribed levels (HZ-016).
    expect(texts.some((x) => x.startsWith("Food: Level"))).toBe(true);
  });

  it("hazard HZ-016 says the food and drink levels are not recorded when the profile is not on the device (C3)", async () => {
    const { texts } = await renderHeaderFor(ADA, { dropProfile: true });
    expect(texts).toContain(
      "Food and drink levels are not on this device. Check with the nurse in charge.",
    );
    expect(texts.some((x) => x.startsWith("Food: Level"))).toBe(false);
  });

  it("hazard HZ-015 shows a resuscitation status for someone with no decision on the device", async () => {
    const { texts } = await renderHeaderFor(CAL);
    expect(texts.some((x) => /not recorded/i.test(x) || x.includes("CPR"))).toBe(true);
  });

  it("marks the header with its test id and never makes identifiers selectable", async () => {
    const { nodes } = await renderHeaderFor(ADA);
    expect(nodes[0]?.props.testID).toBe("person-header");
    const identifiers = (function find(
      list: ReadonlyArray<RenderedNode | string>,
    ): RenderedNode | null {
      for (const node of list) {
        if (typeof node === "string") continue;
        if (node.props.testID === "person-header-identifiers") return node;
        const inner = find(node.children ?? []);
        if (inner) return inner;
      }
      return null;
    })(nodes);
    expect(identifiers?.props.selectable).toBe(false);
  });
});
