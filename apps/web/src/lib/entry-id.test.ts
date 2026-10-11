import { CreateCareNote } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import { isUuid } from "./context-cookies";
import { uuidv7 } from "./entry-id";

describe("uuidv7 (hazard HZ-029)", () => {
  it("makes RFC 9562 version 7 ids that the API's contracts accept", () => {
    const id = uuidv7(Date.parse("2026-10-11T10:00:00Z"), new Uint8Array(10).fill(255));
    expect(id).toBe("01a12a67-ad00-7fff-bfff-ffffffffffff");
    expect(isUuid(id)).toBe(true);
    expect(
      CreateCareNote.safeParse({
        id: uuidv7(),
        occurredAt: "2026-10-11T10:00:00.000Z",
        category: "other",
        body: "Ada had breakfast.",
      }).success,
    ).toBe(true);
  });

  it("orders ids by time and makes a new one each time", () => {
    const earlier = uuidv7(Date.parse("2026-10-11T10:00:00Z"));
    const later = uuidv7(Date.parse("2026-10-11T10:00:01Z"));
    expect(earlier < later).toBe(true);
    expect(uuidv7()).not.toBe(uuidv7());
  });
});
