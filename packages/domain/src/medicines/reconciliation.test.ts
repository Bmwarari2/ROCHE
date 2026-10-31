import { describe, expect, it } from "vitest";
import { draft, PERSON, PRODUCT, TABLET_FACTS, UNIT } from "../../test/medicines-fixtures";
import { type MarEntryDraft, transcribeMarEntry } from "./mar-entry";
import {
  completeReconciliation,
  type EntryDecision,
  type ItemDecision,
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

const source = (
  id: string,
  kind: ReconciliationSource["kind"],
  reference: string,
): ReconciliationSource => ({
  id,
  kind,
  reference,
  documentId: kind === "person_or_family" ? null : `doc-${id}`,
  receivedAt: returnedAt,
});
const LETTER = source("letter", "discharge_letter", "Discharge letter, Ward 7, 03/11/2026");
const FAMILY = source("family", "person_or_family", "Ada Example and her daughter");

const line = (
  id: string,
  sourceId: string,
  asWritten: string,
  product: ReconciliationItem["product"],
) => ({
  id,
  sourceId,
  asWritten,
  product,
});
const PARA_LINE = line(
  "item-para",
  "letter",
  "Paracetamol 500mg tabs 2 QDS",
  PRODUCT.paracetamolTablets,
);
const ALEN_STOP_LINE = line(
  "item-alen",
  "letter",
  "Alendronic acid 70mg weekly: STOPPED on the ward, GP to review",
  PRODUCT.alendronicAcid,
);
const LEVO_LINE = line(
  "item-levo",
  "letter",
  "Levothyroxine 25 micrograms OM",
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
    expect(result.plan.starts).toHaveLength(1);
    expect(result.plan.starts[0]?.draft).toMatchObject({
      personId: PERSON,
      product: PRODUCT.levothyroxine,
      source: { kind: "discharge_letter", documentId: "doc-letter" },
    });
    expect(result.plan).toMatchObject({ completedBy: NURSE, changes: [], notStarted: [] });
  });

  it("makes a change from the source line that shows it, with the reason when its day count moves", () => {
    const change: EntryDecision = {
      kind: "change",
      entryId: "entry-para",
      itemIds: ["item-para"],
      draft: { ...newDraft, product: PRODUCT.paracetamolTablets, indication: "Pain" },
      reanchorReason: "New pattern from the ward",
    };
    const result = completeReconciliation(completion({ entryDecisions: [change, stopAlen] }));
    if (!result.ok) throw new Error("refused");
    expect(result.plan.changes).toMatchObject([
      {
        entryId: "entry-para",
        reanchorReason: "New pattern from the ward",
        draft: { personId: PERSON, source: { kind: "discharge_letter" } },
      },
    ]);
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
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.issues.map((i) => i.problem)).toEqual(["entry_undecided"]);
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

  it("a stop cites the line that says so, never absence and never only the family's word", () => {
    const noLine = { ...stopAlen, itemIds: [] };
    expect(
      problems(
        completion({ reconciliation: withoutStopLine, entryDecisions: [continuePara, noLine] }),
      ),
    ).toEqual(["stop_needs_source_item"]);
    const familyLine = line("item-fam", "family", "Daughter says the ward stopped it", null);
    const familyOnly = {
      ...reconciliation,
      items: [PARA_LINE, LEVO_LINE, familyLine],
    };
    const byFamily = { ...stopAlen, itemIds: ["item-fam"] };
    expect(
      problems(
        completion({ reconciliation: familyOnly, entryDecisions: [continuePara, byFamily] }),
      ),
    ).toEqual(["source_not_a_document"]);
    expect(
      problems(completion({ entryDecisions: [continuePara, { ...stopAlen, reason: " " }] })),
    ).toEqual(["stop_needs_reason"]);
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
    line("item-warf-family", "family", "Warfarin at teatime, as usual", null),
    line("item-warf-label", "label", "Warfarin 1mg tablets as directed", PRODUCT.warfarin),
    line("item-warf-gp", "gp", "Warfarin 1mg tablets as per INR book", PRODUCT.warfarin),
  ];
  const rec = (overrides: Partial<Reconciliation> = {}): Reconciliation => ({
    ...reconciliation,
    entriesAtStart: [...reconciliation.entriesAtStart, { entryId: "entry-warf", version: 1 }],
    sources: [LETTER, FAMILY, LABEL, GP],
    items: [...reconciliation.items, ...extra],
    ...overrides,
  });
  /** Warfarin continued on the lines given; the other warfarin lines are recorded as not started. */
  const input = (linked: string[], keep: Partial<EntryDecision> = {}, recOverrides = {}) =>
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

  it("on an admission, a label alone is not enough but the GP record is", () => {
    const admission = { trigger: "admission" as const, sources: [FAMILY, LABEL, GP, LETTER] };
    expect(problems(input(["item-warf-label"], {}, admission))).toEqual([
      "continue_not_shown_current",
    ]);
    expect(problems(input(["item-warf-gp"], {}, admission))).toEqual([]);
  });

  it("on a return with no discharge letter and the reason recorded, the GP record shows what is prescribed", () => {
    const noLetter = {
      sources: [FAMILY, LABEL, GP, source("gp2", "gp_record", "GP summary 03/11/2026")],
      items: [
        { ...PARA_LINE, sourceId: "gp2" },
        { ...ALEN_STOP_LINE, sourceId: "gp2" },
        { ...LEVO_LINE, sourceId: "gp2" },
        ...extra,
      ],
    };
    const withReason = {
      ...input(["item-warf-gp"], {}, noLetter),
      noDischargeLetterReason: "Letter not sent; GP surgery read the current list by phone",
    };
    expect(problems(withReason)).toEqual([]);
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
        'Decide what happens to "Levothyroxine 25 micrograms OM": link it to a MAR entry, start it, or say why not.',
      );
    }
  });

  it.each<[string, ItemDecision[], EntryDecision[] | null, ReconciliationProblem[]]>([
    [
      "a line linked and also started",
      [
        { kind: "start", itemId: "item-para", draft: { ...newDraft, product: PRODUCT.warfarin } },
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
    const cream = line("item-cream", "family", "A cream for her knees", null);
    const family: Reconciliation = { ...reconciliation, items: [...reconciliation.items, cream] };
    const start: ItemDecision = { kind: "start", itemId: "item-cream", draft: newDraft };
    expect(
      problems(completion({ reconciliation: family, itemDecisions: [startLevo, start] })),
    ).toEqual(["source_not_a_document"]);
  });

  it("checks each new entry as any MAR entry is checked (dm+d, units, source)", () => {
    const bad: ReconciliationDraft = {
      ...newDraft,
      product: { vmpId: "levothyroxine", ampId: null, name: "Levothyroxine" },
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
    });
    expect(made).toMatchObject({
      ok: true,
      entry: { state: "not_yet_checked", origin: "reconciliation", transcribedBy: NURSE },
    });
  });
});

describe("hazard HZ-121 a medicine is never on the MAR twice without a reason", () => {
  const prnLine = line(
    "item-para-prn",
    "letter",
    "Paracetamol 500mg tabs 1-2 PRN",
    PRODUCT.paracetamolTablets,
  );
  const capsLine = line(
    "item-caps",
    "letter",
    "Paracetamol 500mg caps",
    PRODUCT.paracetamolCapsules,
  );
  const rec = { ...reconciliation, items: [...reconciliation.items, prnLine, capsLine] };
  const start = (
    itemId: string,
    product: ReconciliationDraft["product"],
    note: string | null = null,
  ): ItemDecision => ({
    kind: "start",
    itemId,
    draft: { ...newDraft, product, indication: "Pain" },
    note,
  });
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
    const caps = start("item-caps", PRODUCT.paracetamolCapsules);
    expect(
      problems(completion({ reconciliation: rec, itemDecisions: [startLevo, notPrn, caps] })),
    ).toEqual([]);
  });
});

describe("hazard HZ-121 continuing a medicine the sources show as a different product needs a note", () => {
  it.each([
    [
      "another VMP (tablets on the MAR, capsules on the letter)",
      PRODUCT.paracetamolCapsules,
      "product",
    ],
    ["another brand of the same VMP", PRODUCT.paracetamolBrandB, "brand"],
    ["a line that is not dm+d coded", null, "not_coded"],
  ] as const)("%s", (_name, product, difference) => {
    const mar = { ...paracetamol, product: PRODUCT.paracetamolBrandA };
    const item = { ...PARA_LINE, product };
    expect(linkDifference(mar, item)).toBe(difference);
    const rec = { ...reconciliation, items: [item, ALEN_STOP_LINE, LEVO_LINE] };
    const input = completion({ reconciliation: rec, currentEntries: [mar, alendronic] });
    expect(problems(input)).toEqual(["continue_with_difference"]);
    const noted = {
      ...continuePara,
      note: "The pharmacy supplies this brand; same medicine and strength",
    };
    expect(problems({ ...input, entryDecisions: [noted, stopAlen] })).toEqual([]);
  });

  it("the same product needs no note", () => {
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
    const done = [{ personId: PERSON, triggerEventId: "adm-1" }];
    expect(outstandingReconciliations([admission, back], done).map((o) => o.event.id)).toEqual([
      "ret-1",
    ]);
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
