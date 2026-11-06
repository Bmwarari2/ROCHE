import { describe, expect, it } from "vitest";
import {
  chosenPerson,
  homePane,
  type RoundChoice,
  type RoundEntry,
  roundPane,
} from "./split-selection";

/**
 * Hazard HZ-001 on a tablet (MOB-013): the detail pane follows what the reader chose, by id, as the
 * list re-sorts, sync removes rows and people leave. Invented people only.
 */

const ADA: RoundChoice = {
  personId: "ada",
  personName: "Ada Example",
  task: "t-ada-1",
  taskTitle: "Reposition",
};
const entry = (id: string, personId: string | null, person: string | null): RoundEntry => ({
  id,
  personId,
  person,
});
const ROUND = [
  entry("t-bob-1", "bob", "Bob Example"),
  entry("t-ada-1", "ada", "Ada Example"),
  entry("t-ada-2", "ada", "Ada Example"),
];

describe("hazard HZ-001 the person beside the round", () => {
  it.each([
    ["nothing chosen", null, ROUND, { kind: "none" }],
    [
      "the task still open",
      ADA,
      ROUND,
      {
        kind: "person",
        personId: "ada",
        personName: "Ada Example",
        task: "t-ada-1",
        taskGone: null,
      },
    ],
    [
      "the round re-sorted: the same person, by id",
      ADA,
      [...ROUND].reverse(),
      {
        kind: "person",
        personId: "ada",
        personName: "Ada Example",
        task: "t-ada-1",
        taskGone: null,
      },
    ],
    [
      "the chosen task left the round, another of theirs remains: said in words",
      ADA,
      ROUND.filter((e) => e.id !== "t-ada-1"),
      {
        kind: "person",
        personId: "ada",
        personName: "Ada Example",
        task: null,
        taskGone: "Reposition",
      },
    ],
    [
      "the person has no task left on the round: the pane closes",
      ADA,
      ROUND.filter((e) => e.personId !== "ada"),
      { kind: "none" },
    ],
    [
      "sync renamed the person: the heading follows the round",
      { ...ADA, task: null, taskTitle: null },
      [entry("t-ada-1", "ada", "Adaline Example")],
      {
        kind: "person",
        personId: "ada",
        personName: "Adaline Example",
        task: null,
        taskGone: null,
      },
    ],
    ["an empty round", ADA, [], { kind: "none" }],
  ] as const)("%s", (_label, choice, entries, expected) => {
    expect(roundPane(choice, entries)).toEqual(expected);
  });

  it("never names anyone but the chosen person in the heading", () => {
    for (const order of [ROUND, [...ROUND].reverse()]) {
      const pane = roundPane({ ...ADA, personId: "bob", personName: "Bob Example" }, order);
      expect(pane).toMatchObject({ kind: "person", personId: "bob", personName: "Bob Example" });
    }
  });
});

describe("hazard HZ-001 the person chosen on People", () => {
  const people = [{ id: "ada" }, { id: "bob" }];
  it.each([
    ["chosen and in the list", "bob", { id: "bob" }],
    ["chosen, then left the list", "cara", null],
    ["nothing chosen", undefined, null],
    ["an empty choice", "", null],
  ])("%s", (_label, chosen, expected) => {
    expect(chosenPerson(people, chosen)).toEqual(expected);
    expect(chosenPerson([...people].reverse(), chosen)).toEqual(expected);
  });
});

describe("hazard HZ-001 the home whose handover is read beside the list", () => {
  const home = (id: string) => ({ location: { id } });
  it.each([
    ["one home, nothing chosen: shown", [home("north")], null, "home:north:auto"],
    [
      "two homes, nothing chosen: the reader chooses",
      [home("north"), home("south")],
      null,
      "choose",
    ],
    [
      "a home added by sync while one was shown unchosen: the reader chooses",
      [home("south"), home("north")],
      null,
      "choose",
    ],
    ["chosen, the list re-ordered", [home("south"), home("north")], "north", "home:north:chosen"],
    ["the chosen home left the phone: said, never another", [home("south")], "north", "gone"],
    ["no homes", [], null, "choose"],
  ])("%s", (_label, homes, chosen, expected) => {
    const pane = homePane(homes, chosen);
    const said =
      pane.kind === "home"
        ? `home:${pane.home.location.id}:${pane.chosen ? "chosen" : "auto"}`
        : pane.kind;
    expect(said).toBe(expected);
  });
});
