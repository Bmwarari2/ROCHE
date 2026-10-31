import { describe, expect, it } from "vitest";
import { type PersonNames, personFields } from "../src/services/evidence-pack";

/** Sample data in an evidence pack (platform-completions.md rule 29; HZ-072). */

const someone = (sample: boolean): PersonNames => ({
  id: "0194d000-0000-7000-8600-000000000099",
  display: "Sam Sample",
  sample,
  names: ["Sam Sample", "Sam", "Sample"],
  room: "12",
  nhsNumber: "9990001545",
  dateOfBirth: "1940-01-01",
});

describe("hazard HZ-072 an evidence pack names a sample person as invented", () => {
  it.each([
    [true, "Sam Sample (Sample)"],
    [false, "Sam Sample"],
  ])("sample %s is named %s", (sample, name) => {
    const fields = personFields(someone(sample));
    expect(fields.find((f) => f.key === "person_name")?.value).toBe(name);
    // Only the name says so: the other fields are as they are.
    expect(fields.find((f) => f.key === "room")?.value).toBe("12");
  });
});
