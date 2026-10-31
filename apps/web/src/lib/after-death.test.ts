import { MEDICAL_EXAMINER_PACK_SECTIONS, SOURCES } from "@harbour/domain";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import { afterDeath, LEDER_REPORT_URL, lederPrompt, packSections } from "./after-death";

const t = createTranslator("en-GB");
const PERSON = "0194d000-0000-7000-8600-000000000003";
const INCIDENT = "0194d000-0000-7000-8000-00000000e001";

const notification = (kind: string, personId: string | null = PERSON, status = "draft") =>
  ({ id: `${kind}-${status}`, kind, personId, status, clock: "overdue" }) as never;

function person(overrides: object = {}) {
  return {
    id: "0194d000-0000-7000-8000-00000000p001",
    kind: "service_user",
    role: "affected",
    personId: PERSON,
    died: true,
    learningDisability: null,
    autistic: null,
    ...overrides,
  } as never;
}

describe("the medical examiner pack (SAFE-008)", () => {
  it("hazard HZ-013 lists every section in pack order, each with where it is kept", () => {
    const sections = packSections(PERSON, INCIDENT);
    expect(sections.map((s) => s.key)).toEqual(MEDICAL_EXAMINER_PACK_SECTIONS.map((s) => s.key));
    expect(Object.fromEntries(sections.map((s) => [s.key, s.href]))).toEqual({
      demographics: `/people/${PERSON}`,
      diagnoses: null,
      recent_notes: `/people/${PERSON}/notes`,
      recent_observations: `/people/${PERSON}/charts`,
      medicines: null,
      advance_care_records: `/people/${PERSON}/advance-care`,
      death_circumstances: `/incidents/${INCIDENT}`,
    });
    // A person the reader cannot open has no links into their record.
    expect(
      packSections(null, INCIDENT)
        .filter((s) => s.href)
        .map((s) => s.key),
    ).toEqual(["death_circumstances"]);
  });

  it("says each section and what it holds in the catalogue's words, matching the domain's", () => {
    for (const section of MEDICAL_EXAMINER_PACK_SECTIONS) {
      expect(t("safety.afterDeath.section", { section: section.key })).toBe(section.title);
      expect(t("safety.afterDeath.contents", { section: section.key })).toBe(section.contents);
    }
    // Every place the pack points to has its own words; "none" says it is not on the web yet.
    for (const section of packSections(PERSON, INCIDENT).filter((s) => s.placeKey !== "none")) {
      expect(t("safety.afterDeath.place", { place: section.placeKey })).not.toBe(
        t("safety.afterDeath.place", { place: "none" }),
      );
    }
  });
});

describe("the LeDeR prompt (safety.md rule 6)", () => {
  it("links LeDeR's own form from the domain's sources, never a literal", () => {
    expect(LEDER_REPORT_URL).toBe(SOURCES.leder);
  });

  it.each([
    ["draft", "drafted"],
    ["ready", "drafted"],
    ["submitted", "submitted"],
    ["not_required", "notRequired"],
  ])("hazard HZ-013 follows a LeDeR notification that is %s (review M1)", (status, kind) => {
    const leder = notification("leder", PERSON, status);
    expect(lederPrompt(person(), [leder])).toEqual({ kind, notification: leder });
  });

  it("hazard HZ-013 prefers an open LeDeR draft to one already decided", () => {
    const open = notification("leder", PERSON, "draft");
    const done = notification("leder", PERSON, "not_required");
    expect(lederPrompt(person(), [done, open])).toEqual({ kind: "drafted", notification: open });
  });

  it("hazard HZ-013 says a learning disability or autism only for an open LeDeR draft (review M1)", () => {
    const words = (kind: string) =>
      t("safety.afterDeath.lederBody", { kind, name: "Ada Example", dateTime: "none" });
    expect(words("drafted")).toContain("records that Ada Example had a learning disability");
    for (const kind of ["submitted", "notRequired"]) {
      expect(words(kind)).not.toContain("learning disability");
    }
    expect(
      t("safety.afterDeath.lederBody", {
        kind: "submitted",
        name: "Ada Example",
        dateTime: "31/10/2026 10:00",
      }),
    ).toBe("It was recorded as submitted 31/10/2026 10:00.");
  });

  it("hazard HZ-013 asks staff to check when the incident does not record learning disability or autism", () => {
    expect(lederPrompt(person(), [])).toEqual({ kind: "unknown", closed: false });
    expect(lederPrompt(person({ learningDisability: false }), [])).toEqual({
      kind: "unknown",
      closed: false,
    });
    // On a closed incident it stays, saying it was not answered (review M7).
    expect(lederPrompt(person(), [], true)).toEqual({ kind: "unknown", closed: true });
    expect(
      t("safety.afterDeath.lederBody", {
        kind: "unknownClosed",
        name: "Ada Example",
        dateTime: "none",
      }),
    ).toMatch(/^This incident was closed without recording whether Ada Example/);
    expect(lederPrompt(person({ learningDisability: false, autistic: false }), [])).toEqual({
      kind: "none",
    });
    // Recorded, but no draft: the classifier excluded it (a child goes to Child Death Review).
    expect(lederPrompt(person({ autistic: true }), [])).toEqual({ kind: "none" });
    // Another person's draft is not theirs.
    expect(lederPrompt(person(), [notification("leder", "someone-else")])).toEqual({
      kind: "unknown",
      closed: false,
    });
  });
});

describe("afterDeath", () => {
  it("lists each person we support who died, with their pack notification and the LeDeR prompt", () => {
    const examiner = notification("medical_examiner");
    const deaths = afterDeath({
      status: "closed",
      restricted: false,
      people: [
        person(),
        person({ id: "w", kind: "worker", personId: null }),
        person({ id: "alive", died: false }),
      ],
      classifier: { notifications: [examiner] } as never,
    });
    expect(deaths).toHaveLength(1);
    expect(deaths[0]?.examiner).toBe(examiner);
    expect(deaths[0]?.leder).toEqual({ kind: "unknown", closed: true });
  });

  it("hazard HZ-013 puts the person's CQC death notification beside the pack, with its clock (H-481)", () => {
    const death = notification("cqc_reg16_death");
    const someoneElse = notification("cqc_reg16_death", "0194d000-0000-7000-8600-000000000009");
    const [entry] = afterDeath({
      status: "open",
      restricted: false,
      people: [person()],
      classifier: {
        notifications: [someoneElse, death, notification("medical_examiner")],
      } as never,
    });
    expect(entry?.death).toBe(death);
    expect(t("safety.afterDeath.deathNotification", { kind: "cqc_reg16_death" })).toBe(
      "CQC death notification (regulation 16): tell CQC without delay",
    );
    expect(t("safety.afterDeath.notificationLink", { kind: "cqc_reg16_death" })).toBe(
      "Open the notification: CQC death notification",
    );
  });

  it("has no death notification line when none is drafted", () => {
    const [entry] = afterDeath({
      status: "open",
      restricted: false,
      people: [person()],
      classifier: { notifications: [notification("medical_examiner")] } as never,
    });
    expect(entry?.death).toBeNull();
  });

  it("shows nothing to a reader who sees the incident only in part", () => {
    expect(
      afterDeath({ status: "open", restricted: true, people: [person()], classifier: null }),
    ).toEqual([]);
  });
});
