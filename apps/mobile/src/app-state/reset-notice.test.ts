import { describe, expect, it } from "vitest";
import { resetNoticeWords } from "./reset-notice";

describe("hazard HZ-006 a phone whose security settings changed says what was lost (guides review)", () => {
  it.each([
    [0, "Nothing was waiting to be sent"],
    [1, "1 entry that had not been sent is lost. Tell the nurse in charge now"],
    [3, "3 entries that had not been sent are lost. Tell the nurse in charge now"],
    [null, "Any entries that had not been sent are lost"],
  ])("with %s entries the phone knew were waiting", (count, words) => {
    const text = resetNoticeWords(count);
    expect(text).toContain(words);
    expect(text).not.toContain("was reset");
  });
});
