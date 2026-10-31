import { describe, expect, it } from "vitest";
import { loggableError } from "../src/http/error-log";

describe("loggableError (section 5.3: no personal data in logs)", () => {
  it("drops the message, which may repeat a query's parameters, and keeps the frames", () => {
    const cause = Object.assign(new Error('date/time field value out of range: "0000-01-01"'), {
      code: "22008",
    });
    const error = new Error(
      'Failed query: insert into "person" ... params: Ada,Example,0000-01-01,9990000018',
      { cause },
    );
    error.name = "DrizzleQueryError";
    const logged = loggableError(error);
    expect(logged.name).toBe("DrizzleQueryError");
    expect(logged.code).toBe("22008");
    const text = JSON.stringify(logged);
    for (const secret of ["Ada", "Example", "0000-01-01", "9990000018", "Failed query"]) {
      expect(text).not.toContain(secret);
    }
    expect(logged.stack).toMatch(/^\s+at /);
  });

  it("keeps a multi-line message out too, and copes with values that are not errors", () => {
    const error = new Error("first line\nAda Example lives here");
    expect(JSON.stringify(loggableError(error))).not.toContain("Ada Example");
    expect(loggableError("a string")).toEqual({ name: "Error", code: null, stack: null });
  });
});
