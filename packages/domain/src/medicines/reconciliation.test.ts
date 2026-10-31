import { describe, expect, it } from "vitest";
import { draft, entry, PERSON, PRODUCT, TABLET_FACTS, UNIT } from "../../test/medicines-fixtures";
import type { DmdProductRef } from "./dmd";
import { type MarEntry, type MarEntryDraft, transcribeMarEntry } from "./mar-entry";
import {
  completeReconciliation,
  type EntryDecision,
  type ItemDecision,
  type LineSays,
  linkDifference,
  outstandingReconciliations,
  type ReconciledEntry,
  type Reconciliation,
  type ReconciliationCompletion,
  type ReconciliationDraft,
  type ReconciliationItem,
  type ReconciliationProblem,
  type ReconciliationSource,
  type ReconciliationTriggerEvent,
} from "./reconciliation";

const NURSE = "member-nurse";
const returnedAt = new Date("2026-11-03T14:30:00Z");

/** On the MAR before the hospital stay: paracetamol and alendronic acid. */
const paracetamol: ReconciledEntry = {
  entryId: "entry-para",
  version: 1,
  personId: PERSON,
  product: PRODUCT.paracetamolTablets,
};
const alendronic: ReconciledEntry = {
  entryId: "entry-alen",
  version: 2,
  personId: PERSON,
  product: PRODUCT.alendronicAcid,
};
const VERSIONS: Record<string, MarEntry[]> = {
  "entry-para": [entry({ product: PRODUCT.paracetamolTablets }, "entry-para")],
  "entry-alen": [entry({ product: PRODUCT.alendronicAcid }, "entry-alen")],
  "entry-warf": [entry({ product: PRODUCT.warfarin }, "entry-warf")],
};

const source = (
  id: string,
  kind: ReconciliationSource["kind"],
  reference: string,
  overrides: Partial<ReconciliationSource> = {},
): ReconciliationSource => ({
  id,
  kind,
  reference,
  documentId: kind === "person_or_family" ? null : `doc-${id}`,
  receivedAt: returnedAt,
  currentBecause: null,
  ...overrides,
});
const LETTER = source("letter", "discharge_letter", "Discharge letter, Ward 7, 03/11/2026");
const FAMILY = source("family", "person_or_family", "Ada Example and her daughter");

const line = (
  id: string,
  sourceId: string,
  says: LineSays,
  asWritten: string,
  product: DmdProductRef | null,
): ReconciliationItem => ({ id, sourceId, says, asWritten, product });
const PARA_LINE = line(
  "item-para",
  "letter",
  "continue",
  "Paracetamol 500mg tabs 2 QDS",
  PRODUCT.paracetamolTablets,
);
const ALEN_STOP_LINE = line(
  "item-alen",
  "letter",
  "stop",
  "Alendronic acid 70mg weekly: STOPPED on the ward, GP to review",
  PRODUCT.alendronicAcid,
);
const LEVO_LINE = line(
  "item-levo",
  "letter",
  "start",
  "Levothyroxine 25 micrograms OM: NEW",
  PRODUCT.levothyroxine,
);

/** The discharge letter continues paracetamol, stops alendronic acid and starts levothyroxine. */
const reconciliation: Reconciliation = {
  id: "rec-1",
  personId: PERSON,
  trigger: "return_from_hospital",
  triggeredAt: returnedAt,
  entriesAtStart: [
    { entryId: "entry-para", version: 1 },
    { entryId: "entry-alen", version: 2 },
  ],
  sources: [LETTER, FAMILY],
  items: [PARA_LINE, ALEN_STOP_LINE, LEVO_LINE],
};
const withoutStopLine: Reconciliation = { ...reconciliation, items: [PARA_LINE, LEVO_LINE] };

const {
  personId: _p,
  source: _s,
  ...levothyroxineDraft
} = draft({
  product: PRODUCT.levothyroxine,
  indication: null,
  startsAt: new Date("2026-11-04T00:00:00Z"),
  directions: {
    kind: "regular",
    schedule: {
      pattern: { kind: "every_day" },
      times: [{ time: "06:00", dose: { kind: "amount", quantity: 1, unit: UNIT.tablet } }],
    },
  },
});
const newDraft: ReconciliationDraft = levothyroxineDraft;
const draftOf = (product: DmdProductRef): ReconciliationDraft => ({
  ...newDraft,
  product,
  indication: "Pain",
});

const continuePara: EntryDecision = {
  kind: "continue",
  entryId: "entry-para",
  itemIds: ["item-para"],
  note: null,
  confirmedWith: null,
};
const stopAlen: Extract<EntryDecision, { kind: "stop" }> = {
  kind: "stop",
  entryId: "entry-alen",
  itemIds: ["item-alen"],
  reason: "Discharge letter: stopped on the ward, GP to review",
};
const startLevo: ItemDecision = { kind: "start", itemId: "item-levo", draft: newDraft };

function completion(overrides: Partial<ReconciliationCompletion> = {}): ReconciliationCompletion {
  return {
    reconciliation,
    currentEntries: [paracetamol, alendronic],
    entryVersions: (id) => VERSIONS[id] ?? [],
    entryDecisions: [continuePara, stopAlen],
    itemDecisions: [startLevo],
    completer: { id: NURSE, competence: "current" },
    completedAt: new Date("2026-11-03T16:00:00Z"),
    allergiesCompared: true,
    personInvolvement: { involved: true },
    noDischargeLetterReason: null,
    dmdFacts: () => TABLET_FACTS,
    ...overrides,
  };
}

const problems = (input: ReconciliationCompletion): ReconciliationProblem[] => {
  const result = completeReconciliation(input);
  return result.ok ? [] : result.issues.map((i) => i.problem);
};

describe("a completed reconciliation is the plan the API applies", () => {
  it("continues, stops and starts as the person decided, each with its source document", () => {
    const result = completeReconciliation(completion());
    if (!result.ok) throw new Error(result.issues.map((i) => i.message).join(" "));
    expect(result.plan.continued).toEqual(["entry-para"]);
    expect(result.plan.stops).toEqual([
      {
        entryId: "entry-alen",
        reason: "Discharge letter: stopped on the ward, GP to review",
        source: { kind: "discharge_letter", reference: LETTER.reference, documentId: "doc-letter" },
      },
    ]);
    expect(result.plan.starts).toMatchObject([
      {
        itemId: "item-levo",
        reanchorReason: null,
        draft: {
          personId: PERSON,
          product: PRODUCT.levothyroxine,
          source: { kind: "discharge_letter" },
        },
      },
    ]);
    expect(result.plan).toMatchObject({ completedBy: NURSE, changes: [], notStarted: [] });
  });

  it("makes a change from the line that says it, with what happened to that day's doses", () => {
    const changeLine = { ...PARA_LINE, says: "change" as const };
    const rec = { ...reconciliation, items: [changeLine, ALEN_STOP_LINE, LEVO_LINE] };
    const change: EntryDecision = {
      kind: "change",
      entryId: "entry-para",
      itemIds: ["item-para"],
      draft: draftOf(PRODUCT.paracetamolTablets),
      todaysDoses: "some_still_due",
    };
    const result = completeReconciliation(
      completion({ reconciliation: rec, entryDecisions: [change, stopAlen] }),
    );
    if (!result.ok) throw new Error(result.issues.map((i) => i.message).join(" "));
    expect(result.plan.changes).toMatchObject([
      {
        entryId: "entry-para",
        todaysDoses: "some_still_due",
        reanchorReason: null,
        draft: { personId: PERSON, source: { kind: "discharge_letter" } },
      },
    ]);
  });

  it("shows a change's day-count and change-day questions when the reconciliation completes", () => {
    const changeLine = { ...PARA_LINE, says: "change" as const };
    const rec = { ...reconciliation, items: [changeLine, ALEN_STOP_LINE, LEVO_LINE] };
    const unstated: EntryDecision = {
      kind: "change",
      entryId: "entry-para",
      itemIds: ["item-para"],
      draft: draftOf(PRODUCT.paracetamolTablets),
    };
    expect(
      completeReconciliation(
        completion({ reconciliation: rec, entryDecisions: [unstated, stopAlen] }),
      ),
    ).toMatchObject({
      ok: false,
      issues: [
        {
          problem: "change_refused",
          entryId: "entry-para",
          draftIssues: [{ problem: "todays_doses_unstated" }],
        },
      ],
    });
    const every3 = (anchorOn: string): ReconciliationDraft => ({
      ...draftOf(PRODUCT.paracetamolTablets),
      directions: {
        kind: "regular",
        schedule: {
          pattern: { kind: "every_n_days", intervalDays: 3, anchorOn },
          times: [{ time: "08:00", dose: { kind: "amount", quantity: 1, unit: UNIT.tablet } }],
        },
      },
    });
    const versions: Record<string, MarEntry[]> = {
      ...VERSIONS,
      "entry-para": [entry({ directions: every3("2026-11-02").directions }, "entry-para")],
    };
    const moved: EntryDecision = {
      kind: "change",
      entryId: "entry-para",
      itemIds: ["item-para"],
      draft: every3("2026-11-04"),
      todaysDoses: "some_still_due",
    };
    expect(
      completeReconciliation(
        completion({
          reconciliation: rec,
          entryVersions: (id) => versions[id] ?? [],
          entryDecisions: [moved, stopAlen],
        }),
      ),
    ).toMatchObject({
      ok: false,
      issues: [{ problem: "change_refused", draftIssues: [{ problem: "count_reanchored" }] }],
    });
  });

  it("records a source line not started, with the reason", () => {
    const notStarted: ItemDecision = {
      kind: "not_started",
      itemId: "item-levo",
      reason: "Already stopped by the GP on 03/11, confirmed by phone",
    };
    expect(completeReconciliation(completion({ itemDecisions: [notStarted] }))).toMatchObject({
      ok: true,
      plan: { notStarted: [{ itemId: "item-levo" }], starts: [] },
    });
  });
});

describe("hazard HZ-121 every medicine on the MAR needs a decision before a reconciliation completes", () => {
  it("never stops a medicine because a source leaves it out: the person decides", () => {
    const result = completeReconciliation(
      completion({ reconciliation: withoutStopLine, entryDecisions: [continuePara] }),
    );
    expect(result.ok ? [] : result.issues.map((i) => i.problem)).toEqual(["entry_undecided"]);
    if (!result.ok) {
      expect(result.issues[0]?.message).toBe(
        "Decide what happens to Alendronic acid 70mg tablets: continue, change, stop or ask.",
      );
    }
  });

  it("continuing a medicine no source lists needs a note and the clinician who confirmed it", () => {
    const keep: EntryDecision = {
      kind: "continue",
      entryId: "entry-alen",
      itemIds: [],
      note: "Still prescribed",
      confirmedWith: null,
    };
    const input = { reconciliation: withoutStopLine, entryDecisions: [continuePara, keep] };
    expect(problems(completion(input))).toEqual(["continue_not_in_sources"]);
    const confirmed = { ...keep, confirmedWith: "Dr Example, GP, by phone 03/11/2026" };
    expect(problems(completion({ ...input, entryDecisions: [continuePara, confirmed] }))).toEqual(
      [],
    );
  });

  it("a stop cites a current document's line that says so, never absence and never only the family's word", () => {
    const noLine = { ...stopAlen, itemIds: [] };
    expect(
      problems(
        completion({ reconciliation: withoutStopLine, entryDecisions: [continuePara, noLine] }),
      ),
    ).toEqual(["stop_needs_source_item"]);
    const familyLine = line(
      "item-fam",
      "family",
      "stop",
      "Daughter says the ward stopped it",
      PRODUCT.alendronicAcid,
    );
    const familyOnly = { ...reconciliation, items: [PARA_LINE, LEVO_LINE, familyLine] };
    expect(
      problems(
        completion({
          reconciliation: familyOnly,
          entryDecisions: [continuePara, { ...stopAlen, itemIds: ["item-fam"] }],
        }),
      ),
    ).toEqual(["source_not_a_document"]);
    expect(
      problems(completion({ entryDecisions: [continuePara, { ...stopAlen, reason: " " }] })),
    ).toEqual(["stop_needs_reason"]);
  });

  it("a stop is never supported by a pre-admission label that says the medicine continues (M2)", () => {
    const LABEL = source("label", "pharmacy_label", "Pack brought in, labelled 12/10/2026", {
      receivedAt: new Date("2026-10-12T10:00:00Z"),
    });
    const labelLine = line(
      "item-label",
      "label",
      "continue",
      "Alendronic acid 70mg once a week",
      PRODUCT.alendronicAcid,
    );
    const rec = {
      ...reconciliation,
      sources: [LETTER, FAMILY, LABEL],
      items: [PARA_LINE, LEVO_LINE, labelLine],
    };
    const byLabel = { ...stopAlen, itemIds: ["item-label"], reason: "Not on the letter" };
    expect(
      problems(completion({ reconciliation: rec, entryDecisions: [continuePara, byLabel] })),
    ).toEqual(["line_does_not_support"]);
    const stopLabel = { ...labelLine, says: "stop" as const };
    expect(
      problems(
        completion({
          reconciliation: { ...rec, items: [PARA_LINE, LEVO_LINE, stopLabel] },
          entryDecisions: [continuePara, byLabel],
        }),
      ),
    ).toEqual(["stop_not_shown_current"]);
  });

  it("refuses to complete when the medicines record changed after the reconciliation began", () => {
    expect(
      problems(completion({ currentEntries: [paracetamol, { ...alendronic, version: 3 }] })),
    ).toContain("record_changed");
    const added: ReconciledEntry = {
      entryId: "entry-new",
      version: 1,
      personId: PERSON,
      product: PRODUCT.warfarin,
    };
    expect(problems(completion({ currentEntries: [paracetamol, alendronic, added] }))).toEqual([
      "record_changed",
      "entry_undecided",
    ]);
    expect(problems(completion({ currentEntries: [paracetamol] }))).toEqual([
      "record_changed",
      "unknown_entry",
      "item_undecided",
    ]);
  });

  it("refuses an entry that belongs to someone else (HZ-001)", () => {
    expect(
      problems(
        completion({ currentEntries: [paracetamol, { ...alendronic, personId: "person-other" }] }),
      ),
    ).toEqual(["wrong_person"]);
  });

  it("refuses two decisions for one medicine", () => {
    const again: EntryDecision = {
      ...continuePara,
      itemIds: [],
      note: "Still taking",
      confirmedWith: "Dr Example",
    };
    expect(problems(completion({ entryDecisions: [continuePara, stopAlen, again] }))).toEqual([
      "entry_decided_twice",
    ]);
  });
});

describe("hazard HZ-121 a decision is supported only by a line that says it, about the same dm+d product", () => {
  it("never continues alendronic acid on the letter's line that says it was stopped, whatever the note", () => {
    const keep: EntryDecision = {
      kind: "continue",
      entryId: "entry-alen",
      itemIds: ["item-alen"],
      note: "Carry on as before",
      confirmedWith: "Daughter",
    };
    const result = completeReconciliation(completion({ entryDecisions: [continuePara, keep] }));
    expect(result).toMatchObject({
      ok: false,
      issues: [{ problem: "line_does_not_support", entryId: "entry-alen", itemId: "item-alen" }],
    });
    if (!result.ok) expect(result.issues[0]?.message).toContain("says stop it");
  });

  describe("warfarin on the MAR, and a letter that stops it and starts apixaban", () => {
    const warfarin: ReconciledEntry = {
      entryId: "entry-warf",
      version: 1,
      personId: PERSON,
      product: PRODUCT.warfarin,
    };
    const stopWarf = line("item-warf", "letter", "stop", "Warfarin: STOPPED", PRODUCT.warfarin);
    const startApix = line(
      "item-apix",
      "letter",
      "start",
      "Apixaban 5mg twice a day: NEW",
      PRODUCT.apixaban,
    );
    const rec: Reconciliation = {
      ...reconciliation,
      entriesAtStart: [...reconciliation.entriesAtStart, { entryId: "entry-warf", version: 1 }],
      items: [...reconciliation.items, stopWarf, startApix],
    };
    const base = { reconciliation: rec, currentEntries: [paracetamol, alendronic, warfarin] };
    const apixaban: ItemDecision = {
      kind: "start",
      itemId: "item-apix",
      draft: draftOf(PRODUCT.apixaban),
    };

    it("refuses warfarin continued on the apixaban line, with a note and without the clinician", () => {
      const keep: EntryDecision = {
        kind: "continue",
        entryId: "entry-warf",
        itemIds: ["item-apix"],
        note: "Anticoagulant continues",
        confirmedWith: null,
      };
      const result = completeReconciliation(
        completion({
          ...base,
          entryDecisions: [continuePara, stopAlen, keep],
          itemDecisions: [startLevo],
        }),
      );
      expect(result.ok ? [] : result.issues.map((i) => i.problem)).toEqual([
        "line_does_not_support",
        "item_undecided",
      ]);
    });

    it("stops warfarin on its own line and starts apixaban on its line", () => {
      const stop: EntryDecision = {
        kind: "stop",
        entryId: "entry-warf",
        itemIds: ["item-warf"],
        reason: "Switched to apixaban on the ward",
      };
      const result = completeReconciliation(
        completion({
          ...base,
          entryDecisions: [continuePara, stopAlen, stop],
          itemDecisions: [startLevo, apixaban],
        }),
      );
      expect(result).toMatchObject({
        ok: true,
        plan: {
          stops: [{ entryId: "entry-alen" }, { entryId: "entry-warf" }],
          starts: [{ itemId: "item-levo" }, { itemId: "item-apix" }],
        },
      });
    });
  });

  it.each<[string, ItemDecision, ReconciliationItem]>([
    [
      "from a line that says stop",
      { kind: "start", itemId: "item-x", draft: draftOf(PRODUCT.warfarin) },
      line("item-x", "letter", "stop", "Warfarin: STOPPED", PRODUCT.warfarin),
    ],
    [
      "of another product than the line's",
      { kind: "start", itemId: "item-x", draft: draftOf(PRODUCT.warfarin) },
      line("item-x", "letter", "start", "Apixaban: NEW", PRODUCT.apixaban),
    ],
    [
      "from a line with no dm+d product",
      { kind: "start", itemId: "item-x", draft: draftOf(PRODUCT.warfarin) },
      line("item-x", "letter", "start", "Blood thinner", null),
    ],
  ])("refuses a start %s", (_name, decision, item) => {
    const rec = { ...reconciliation, items: [...reconciliation.items, item] };
    expect(
      problems(completion({ reconciliation: rec, itemDecisions: [startLevo, decision] })),
    ).toEqual(["line_does_not_support"]);
  });

  it("refuses a change on a line that says continue, or about another product", () => {
    const change: EntryDecision = {
      kind: "change",
      entryId: "entry-para",
      itemIds: ["item-para"],
      draft: draftOf(PRODUCT.paracetamolTablets),
      todaysDoses: "some_still_due",
    };
    expect(problems(completion({ entryDecisions: [change, stopAlen] }))).toEqual([
      "line_does_not_support",
    ]);
    const otherProduct = { ...change, draft: draftOf(PRODUCT.paracetamolCapsules) };
    const changeLine = { ...PARA_LINE, says: "change" as const };
    expect(
      problems(
        completion({
          reconciliation: { ...reconciliation, items: [changeLine, ALEN_STOP_LINE, LEVO_LINE] },
          entryDecisions: [otherProduct, stopAlen],
        }),
      ),
    ).toEqual(["line_does_not_support"]);
  });

  it("an unclear line is a question: completion waits until it says what it means", () => {
    const unclear = line("item-q", "letter", "unclear", "Bisoprolol ?dose", null);
    const rec = { ...reconciliation, items: [...reconciliation.items, unclear] };
    const asked: ItemDecision = {
      kind: "query",
      itemId: "item-q",
      question: "What dose of bisoprolol? Ask the ward.",
    };
    expect(
      problems(completion({ reconciliation: rec, itemDecisions: [startLevo, asked] })),
    ).toEqual(["line_unclear", "query_open"]);
    const notStarted: ItemDecision = { kind: "not_started", itemId: "item-q", reason: "Not ours" };
    expect(
      problems(completion({ reconciliation: rec, itemDecisions: [startLevo, notStarted] })),
    ).toEqual(["line_unclear"]);
  });
});

describe("hazard HZ-121 continuing a medicine needs a line that shows what is prescribed now", () => {
  const warfarin: ReconciledEntry = {
    entryId: "entry-warf",
    version: 1,
    personId: PERSON,
    product: PRODUCT.warfarin,
  };
  const LABEL = source(
    "label",
    "pharmacy_label",
    "Pharmacy label on the pack brought in, 12/10/2026",
  );
  const GP = source("gp", "gp_record", "GP summary printed 01/10/2026");
  const extra = [
    line("item-warf-family", "family", "continue", "Warfarin at teatime, as usual", null),
    line(
      "item-warf-label",
      "label",
      "continue",
      "Warfarin 1mg tablets as directed",
      PRODUCT.warfarin,
    ),
    line(
      "item-warf-gp",
      "gp",
      "continue",
      "Warfarin 1mg tablets as per INR book",
      PRODUCT.warfarin,
    ),
  ];
  const rec = (overrides: Partial<Reconciliation> = {}): Reconciliation => ({
    ...reconciliation,
    entriesAtStart: [...reconciliation.entriesAtStart, { entryId: "entry-warf", version: 1 }],
    sources: [LETTER, FAMILY, LABEL, GP],
    items: [...reconciliation.items, ...extra],
    ...overrides,
  });
  /** Warfarin continued on the lines given; the other warfarin lines are recorded as not started. */
  const input = (
    linked: string[],
    keep: Partial<EntryDecision> = {},
    recOverrides: Partial<Reconciliation> = {},
  ) =>
    completion({
      reconciliation: rec(recOverrides),
      currentEntries: [paracetamol, alendronic, warfarin],
      entryDecisions: [
        continuePara,
        stopAlen,
        { ...continuePara, entryId: "entry-warf", itemIds: linked, ...keep } as EntryDecision,
      ],
      itemDecisions: [
        startLevo,
        ...extra
          .filter((i) => !linked.includes(i.id))
          .map((i) => ({
            kind: "not_started" as const,
            itemId: i.id,
            reason: "The warfarin entry",
          })),
      ],
    });

  it.each([
    ["only what the family says", ["item-warf-family"]],
    ["only a label from before the admission", ["item-warf-label"]],
    ["the family and the label", ["item-warf-family", "item-warf-label"]],
    ["the GP record from before the stay, when the discharge letter is here", ["item-warf-gp"]],
  ])("refuses warfarin continued after a return from hospital on %s", (_name, linked) => {
    const result = completeReconciliation(input(linked));
    expect(result).toMatchObject({
      ok: false,
      issues: [{ problem: "continue_not_shown_current", entryId: "entry-warf" }],
    });
    if (!result.ok) expect(result.issues[0]?.message).toContain("Only the discharge letter");
  });

  it("accepts it with a note and the prescriber or clinician who confirmed it, never a note alone", () => {
    expect(
      problems(input(["item-warf-family"], { note: "Ward omitted it from the letter" })),
    ).toEqual(["continue_not_shown_current"]);
    const confirmed = {
      note: "Ward omitted it from the letter",
      confirmedWith: "Ward 7 pharmacist, by phone 03/11/2026 15:10",
    };
    expect(problems(input(["item-warf-family"], confirmed))).toEqual([]);
  });

  it("on an admission, a label alone is not enough but a current GP record is", () => {
    const admission = { trigger: "admission" as const };
    expect(problems(input(["item-warf-label"], {}, admission))).toEqual([
      "continue_not_shown_current",
    ]);
    expect(problems(input(["item-warf-gp"], {}, admission))).toEqual([]);
  });

  it("a GP record from June does not show what is prescribed after the return, unless the person says why it is current (M3)", () => {
    const june = source("gp", "gp_record", "GP summary, June 2026", {
      receivedAt: new Date("2026-06-15T10:00:00Z"),
    });
    const noLetter = { sources: [FAMILY, LABEL, june] };
    const withReason = (r: ReconciliationCompletion) => ({
      ...r,
      noDischargeLetterReason: "No letter sent",
    });
    const stopLine = { ...ALEN_STOP_LINE, sourceId: "gp" };
    const items = [
      { ...PARA_LINE, sourceId: "gp" },
      stopLine,
      { ...LEVO_LINE, sourceId: "gp" },
      ...extra,
    ];
    const juneOnly = withReason(input(["item-warf-gp"], {}, { ...noLetter, items }));
    expect(problems(juneOnly)).toContain("continue_not_shown_current");
    const marked = {
      sources: [
        FAMILY,
        LABEL,
        {
          ...june,
          currentBecause: "GP surgery confirmed by phone on 03/11 that this list is current",
        },
      ],
      items,
    };
    expect(problems(withReason(input(["item-warf-gp"], {}, marked)))).toEqual([]);
  });
});

describe("hazard HZ-121 every medicine in the sources needs a decision, so a new one is never missed", () => {
  it("refuses to complete with a source line nobody decided on", () => {
    const result = completeReconciliation(completion({ itemDecisions: [] }));
    expect(result).toMatchObject({
      ok: false,
      issues: [{ problem: "item_undecided", itemId: "item-levo" }],
    });
    if (!result.ok) {
      expect(result.issues[0]?.message).toBe(
        'Decide what happens to "Levothyroxine 25 micrograms OM: NEW": link it to a MAR entry, start it, or say why not.',
      );
    }
  });

  it.each<[string, ItemDecision[], EntryDecision[] | null, ReconciliationProblem[]]>([
    [
      "a line linked and also started",
      [
        {
          kind: "start",
          itemId: "item-para",
          draft: draftOf(PRODUCT.paracetamolTablets),
          note: "x",
        },
        startLevo,
      ],
      null,
      ["item_decided_twice"],
    ],
    [
      "a line not started without a reason",
      [{ kind: "not_started", itemId: "item-levo", reason: "" }],
      null,
      ["not_started_needs_reason"],
    ],
    [
      "a decision for a line not in the sources",
      [startLevo, { kind: "not_started", itemId: "item-x", reason: "n/a" }],
      null,
      ["unknown_item"],
    ],
    [
      "a change with no source line to show it",
      [startLevo],
      [{ kind: "change", entryId: "entry-para", itemIds: [], draft: newDraft }, stopAlen],
      ["change_needs_source_item", "item_undecided"],
    ],
  ])("refuses %s", (_name, items, entries, expected) => {
    expect(
      problems(
        completion({ itemDecisions: items, ...(entries ? { entryDecisions: entries } : {}) }),
      ),
    ).toEqual(expected);
  });

  it("starts a medicine only from a document, never from what the family says", () => {
    const cream = line(
      "item-cream",
      "family",
      "start",
      "A cream for her knees",
      PRODUCT.levothyroxine,
    );
    const family: Reconciliation = { ...reconciliation, items: [...reconciliation.items, cream] };
    const start: ItemDecision = { kind: "start", itemId: "item-cream", draft: newDraft, note: "x" };
    expect(
      problems(completion({ reconciliation: family, itemDecisions: [startLevo, start] })),
    ).toEqual(["source_not_a_document"]);
  });

  it("checks each new entry as any MAR entry is checked (dm+d, units, source)", () => {
    const bad: ReconciliationDraft = {
      ...newDraft,
      product: { ...PRODUCT.levothyroxine, vmpId: PRODUCT.levothyroxine.vmpId, name: "" },
    };
    const result = completeReconciliation(
      completion({ itemDecisions: [{ kind: "start", itemId: "item-levo", draft: bad }] }),
    );
    expect(result).toMatchObject({
      ok: false,
      issues: [
        {
          problem: "draft_invalid",
          itemId: "item-levo",
          draftIssues: [{ problem: "product_not_dmd" }],
        },
      ],
    });
  });

  it("hazard HZ-005 new and changed medicines from a reconciliation arrive not yet checked, for a second person", () => {
    const result = completeReconciliation(completion());
    if (!result.ok) throw new Error("refused");
    const start = result.plan.starts[0] as { draft: MarEntryDraft };
    const made = transcribeMarEntry(start.draft, TABLET_FACTS, {
      id: "entry-levo",
      by: NURSE,
      at: returnedAt,
      origin: "reconciliation",
      earlierEntries: [],
    });
    expect(made).toMatchObject({
      ok: true,
      entry: { state: "not_yet_checked", origin: "reconciliation", transcribedBy: NURSE },
    });
  });
});

describe("hazard HZ-121 a medicine stopped and started again in a reconciliation keeps its day count", () => {
  const every3 = (anchorOn: string): ReconciliationDraft => ({
    ...draftOf(PRODUCT.paracetamolTablets),
    directions: {
      kind: "regular",
      schedule: {
        pattern: { kind: "every_n_days", intervalDays: 3, anchorOn },
        times: [{ time: "08:00", dose: { kind: "amount", quantity: 1, unit: UNIT.tablet } }],
      },
    },
  });
  const versions: Record<string, MarEntry[]> = {
    ...VERSIONS,
    "entry-para": [entry({ directions: every3("2026-11-02").directions }, "entry-para")],
  };
  const stopPara = line(
    "item-para-stop",
    "letter",
    "stop",
    "Paracetamol: STOPPED",
    PRODUCT.paracetamolTablets,
  );
  const restart = line(
    "item-para-new",
    "letter",
    "start",
    "Paracetamol: restart every 3 days",
    PRODUCT.paracetamolTablets,
  );
  const rec = { ...reconciliation, items: [stopPara, restart, ALEN_STOP_LINE, LEVO_LINE] };
  const stop: EntryDecision = {
    kind: "stop",
    entryId: "entry-para",
    itemIds: ["item-para-stop"],
    reason: "Stopped on the ward",
  };
  const base = {
    reconciliation: rec,
    entryVersions: (id: string) => versions[id] ?? [],
    entryDecisions: [stop, stopAlen],
  };

  it("refuses a restart off the count without a reason, and takes one on it or with a reason", () => {
    const off: ItemDecision = {
      kind: "start",
      itemId: "item-para-new",
      draft: every3("2026-11-04"),
    };
    expect(
      completeReconciliation(completion({ ...base, itemDecisions: [startLevo, off] })),
    ).toMatchObject({
      ok: false,
      issues: [
        {
          problem: "start_refused",
          itemId: "item-para-new",
          draftIssues: [{ problem: "count_reanchored" }],
        },
      ],
    });
    const on: ItemDecision = {
      kind: "start",
      itemId: "item-para-new",
      draft: every3("2026-11-05"),
    };
    expect(problems(completion({ ...base, itemDecisions: [startLevo, on] }))).toEqual([]);
    const withReason: ItemDecision = { ...off, reanchorReason: "Ward restarted it on 04/11" };
    expect(
      completeReconciliation(completion({ ...base, itemDecisions: [startLevo, withReason] })),
    ).toMatchObject({
      ok: true,
      plan: {
        starts: [{}, { itemId: "item-para-new", reanchorReason: "Ward restarted it on 04/11" }],
      },
    });
  });
});

describe("hazard HZ-121 a medicine is never on the MAR twice without a reason", () => {
  const prnLine = line(
    "item-para-prn",
    "letter",
    "start",
    "Paracetamol 500mg tabs 1-2 PRN",
    PRODUCT.paracetamolTablets,
  );
  const capsLine = line(
    "item-caps",
    "letter",
    "start",
    "Paracetamol 500mg caps",
    PRODUCT.paracetamolCapsules,
  );
  const rec = { ...reconciliation, items: [...reconciliation.items, prnLine, capsLine] };
  const start = (
    itemId: string,
    product: DmdProductRef,
    note: string | null = null,
  ): ItemDecision => ({ kind: "start", itemId, draft: draftOf(product), note });
  const notCaps: ItemDecision = {
    kind: "not_started",
    itemId: "item-caps",
    reason: "Same as the tablets",
  };

  it("flags a start of the same dm+d product as an entry that continues, by identity", () => {
    const result = completeReconciliation(
      completion({
        reconciliation: rec,
        itemDecisions: [startLevo, start("item-para-prn", PRODUCT.paracetamolTablets), notCaps],
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      issues: [{ problem: "possible_duplicate", itemId: "item-para-prn" }],
    });
  });

  it("accepts it with a note, as for a regular and a when-required entry of one product", () => {
    const noted = start(
      "item-para-prn",
      PRODUCT.paracetamolTablets,
      "Regular and when-required doses both prescribed",
    );
    expect(
      problems(completion({ reconciliation: rec, itemDecisions: [startLevo, noted, notCaps] })),
    ).toEqual([]);
  });

  it("never matches by ingredient: another VMP with the same ingredient is not flagged", () => {
    const notPrn: ItemDecision = {
      kind: "not_started",
      itemId: "item-para-prn",
      reason: "Same as the regular entry",
    };
    expect(
      problems(
        completion({
          reconciliation: rec,
          itemDecisions: [startLevo, notPrn, start("item-caps", PRODUCT.paracetamolCapsules)],
        }),
      ),
    ).toEqual([]);
  });

  it("flags a change into a product that is already continued", () => {
    const alenChange = line(
      "item-alen-change",
      "letter",
      "change",
      "Paracetamol in place of alendronic acid",
      PRODUCT.paracetamolTablets,
    );
    const recChange = { ...reconciliation, items: [PARA_LINE, alenChange, LEVO_LINE] };
    const change: EntryDecision = {
      kind: "change",
      entryId: "entry-alen",
      itemIds: ["item-alen-change"],
      draft: draftOf(PRODUCT.paracetamolTablets),
      todaysDoses: "some_still_due",
    };
    expect(
      problems(completion({ reconciliation: recChange, entryDecisions: [continuePara, change] })),
    ).toEqual(["possible_duplicate"]);
    expect(
      problems(
        completion({
          reconciliation: recChange,
          entryDecisions: [continuePara, { ...change, note: "Two strengths prescribed" }],
        }),
      ),
    ).toEqual([]);
  });
});

describe("hazard HZ-121 continuing a medicine a source shows as another brand needs a note", () => {
  it.each([
    [
      "another VMP (tablets on the MAR, capsules on the letter)",
      PRODUCT.paracetamolCapsules,
      "product",
      ["line_does_not_support"],
    ],
    [
      "another brand of the same VMP",
      PRODUCT.paracetamolBrandB,
      "brand",
      ["continue_with_difference"],
    ],
    ["a line that is not dm+d coded", null, "not_coded", ["continue_not_shown_current"]],
  ] as const)("%s", (_name, product, difference, expected) => {
    const mar = { ...paracetamol, product: PRODUCT.paracetamolBrandA };
    const item = { ...PARA_LINE, product };
    expect(linkDifference(mar, item)).toBe(difference);
    const rec = { ...reconciliation, items: [item, ALEN_STOP_LINE, LEVO_LINE] };
    expect(
      problems(completion({ reconciliation: rec, currentEntries: [mar, alendronic] })),
    ).toEqual(expected);
  });

  it("accepts another brand with a note, and the same product with none", () => {
    const mar = { ...paracetamol, product: PRODUCT.paracetamolBrandA };
    const rec = {
      ...reconciliation,
      items: [{ ...PARA_LINE, product: PRODUCT.paracetamolBrandB }, ALEN_STOP_LINE, LEVO_LINE],
    };
    const noted = {
      ...continuePara,
      note: "The pharmacy supplies this brand; same medicine and strength",
    };
    expect(
      problems(
        completion({
          reconciliation: rec,
          currentEntries: [mar, alendronic],
          entryDecisions: [noted, stopAlen],
        }),
      ),
    ).toEqual([]);
    expect(linkDifference(paracetamol, PARA_LINE)).toBeNull();
  });
});

describe("hazard HZ-121 a reconciliation cannot complete while a query is open", () => {
  const ask = (question: string): EntryDecision => ({
    kind: "query",
    entryId: "entry-alen",
    question,
  });
  it.each<[string, Partial<ReconciliationCompletion>]>([
    [
      "about a MAR entry",
      {
        reconciliation: withoutStopLine,
        entryDecisions: [continuePara, ask("Stopped on purpose?")],
      },
    ],
    [
      "about a source line",
      {
        itemDecisions: [
          { kind: "query", itemId: "item-levo", question: "New since admission? Ask the ward." },
        ],
      },
    ],
    [
      "with no question written",
      { reconciliation: withoutStopLine, entryDecisions: [continuePara, ask("")] },
    ],
  ])("%s", (_name, overrides) => {
    expect(problems(completion(overrides))).toEqual(["query_open"]);
  });
});

describe("hazard HZ-121 a return from hospital needs the discharge letter or a reason it is not there", () => {
  const GP_NOW = source("gp", "gp_record", "GP summary, 03/11/2026");
  const noLetter: Reconciliation = {
    ...reconciliation,
    sources: [GP_NOW],
    items: [PARA_LINE, ALEN_STOP_LINE, LEVO_LINE].map((i) => ({ ...i, sourceId: "gp" })),
  };
  const input = completion({ reconciliation: noLetter });

  it("refuses without a discharge letter or a reason", () => {
    expect(problems(input)).toEqual(["return_without_discharge_letter"]);
  });

  it("completes with the reason and how the medicines were confirmed", () => {
    expect(
      problems({
        ...input,
        noDischargeLetterReason: "Letter not sent; ward pharmacist read the list by phone",
      }),
    ).toEqual([]);
  });

  it("an admission needs no discharge letter", () => {
    expect(problems({ ...input, reconciliation: { ...noLetter, trigger: "admission" } })).toEqual(
      [],
    );
  });
});

describe("hazard HZ-121 completion is refused without a competent completer, the allergies compared and the person's involvement", () => {
  it.each<[string, Partial<ReconciliationCompletion>, ReconciliationProblem[]]>([
    [
      "a completer whose medicines competence has expired",
      { completer: { id: NURSE, competence: "expired" } },
      ["completer_not_competent"],
    ],
    [
      "allergies not compared with the sources (Harbour matches no allergen)",
      { allergiesCompared: false },
      ["allergies_not_compared"],
    ],
    [
      "the person not involved, with no reason",
      { personInvolvement: { involved: false, reason: " " } },
      ["involvement_reason_required"],
    ],
    [
      "no sources at all",
      {
        reconciliation: { ...reconciliation, sources: [], items: [] },
        itemDecisions: [],
        entryDecisions: [
          { ...continuePara, itemIds: [], note: "x", confirmedWith: "Dr Example" },
          {
            ...continuePara,
            entryId: "entry-alen",
            itemIds: [],
            note: "x",
            confirmedWith: "Dr Example",
          },
        ],
      },
      ["no_sources", "return_without_discharge_letter"],
    ],
    [
      "a source with nothing to say what it is",
      {
        reconciliation: {
          ...reconciliation,
          sources: reconciliation.sources.map((s) => ({ ...s, reference: "" })),
        },
      },
      ["source_reference_required", "draft_invalid"],
    ],
  ])("refuses %s", (_name, overrides, expected) => {
    expect(problems(completion(overrides))).toEqual(expected);
  });

  it("accepts a reason the person was not involved", () => {
    const involvement = {
      involved: false as const,
      reason: "Asleep after the journey; daughter involved instead",
    };
    expect(problems(completion({ personInvolvement: involvement }))).toEqual([]);
  });
});

describe("hazard HZ-121 the medicines record says it is not yet reconciled after admission, transfer or return until a reconciliation completes", () => {
  const admission: ReconciliationTriggerEvent = {
    id: "adm-1",
    personId: PERSON,
    kind: "admission",
    at: new Date("2026-10-01T11:00:00Z"),
  };
  const back: ReconciliationTriggerEvent = {
    id: "ret-1",
    personId: PERSON,
    kind: "return_from_hospital",
    at: returnedAt,
  };
  const other: ReconciliationTriggerEvent = {
    id: "adm-2",
    personId: "person-ben-example",
    kind: "transfer",
    at: new Date("2026-11-02T09:00:00Z"),
  };

  it("lists each event with no completed reconciliation, oldest first, in UK time", () => {
    expect(outstandingReconciliations([back, admission, other], []).map((o) => o.notice)).toEqual([
      "Medicines not yet reconciled since the admission on 01/10/2026 12:00.",
      "Medicines not yet reconciled since the transfer on 02/11/2026 09:00.",
      "Medicines not yet reconciled since the return from hospital on 03/11/2026 14:30.",
    ]);
  });

  it("a reconciliation for the admission clears it, never the later return", () => {
    expect(
      outstandingReconciliations(
        [admission, back],
        [{ personId: PERSON, triggerEventId: "adm-1" }],
      ).map((o) => o.event.id),
    ).toEqual(["ret-1"]);
  });

  it("a reconciliation for the return also covers the admission before it", () => {
    expect(
      outstandingReconciliations(
        [admission, back],
        [{ personId: PERSON, triggerEventId: "ret-1" }],
      ),
    ).toEqual([]);
  });

  it("a reconciliation for a change, or for someone else, clears nothing", () => {
    const done = [
      { personId: PERSON, triggerEventId: null },
      { personId: PERSON, triggerEventId: "adm-2" },
      { personId: PERSON, triggerEventId: "missing" },
    ];
    expect(outstandingReconciliations([admission, other], done).map((o) => o.event.id)).toEqual([
      "adm-1",
      "adm-2",
    ]);
  });
});
