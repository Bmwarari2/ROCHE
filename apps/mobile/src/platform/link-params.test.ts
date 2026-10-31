import { describe, expect, it } from "vitest";
import { redirectSystemPath } from "../app/+native-intent";
import { stripInternalParams } from "./link-params";

describe("hazard HZ-029 hazard HZ-004 a link from outside never names a round's task (#123 security review, M2)", () => {
  it.each([
    ["/people/p1/note?task=t1", "/people/p1/note"],
    ["harbour:///people/p1/note?task=t1&taskTitle=Turn%20now", "harbour:///people/p1/note"],
    ["/people/p1?chart=fluid_intake&task=t1", "/people/p1?chart=fluid_intake"],
    ["/people/p1/chart?task=t1#top", "/people/p1/chart#top"],
    ["/people/p1/note", "/people/p1/note"],
    ["/people/p1/chart?chart=weight", "/people/p1/chart?chart=weight"],
  ])("%s opens as %s", (path, expected) => {
    expect(stripInternalParams(path)).toBe(expected);
  });

  it("strips them from every link the system hands the router", () => {
    expect(redirectSystemPath({ path: "harbour:///people/p1/note?task=t1", initial: true })).toBe(
      "harbour:///people/p1/note",
    );
  });
});
