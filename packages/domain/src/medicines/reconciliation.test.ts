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
  type ReconciliationProblem,
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

/** The discharge letter lists paracetamol and a new medicine, and leaves alendronic acid out. */
const reconciliation: Reconciliation = {
  id: "rec-1",
  personId: PERSON,
  trigger: "return_from_hospital",
  triggeredAt: returnedAt,
  entriesAtStart: [
    { entryId: "entry-para", version: 1 },
    { entryId: "entry-alen", version: 2 },
  ],
  sources: [
    {
      id: "src-letter",
      kind: "discharge_letter",
      reference: "Discharge letter, Ward 7, 03/11/2026",
      documentId: "doc-7",
      receivedAt: returnedAt,
    },
    {
      id: "src-family",
      kind: "person_or_family",
      reference: "Ada Example and her daughter",
      documentId: null,
      receivedAt: returnedAt,
    },
  ],
  items: [
    {
      id: "item-para",
      sourceId: "src-letter",
      asWritten: "Paracetamol 500mg tabs 2 QDS",
      product: PRODUCT.paracetamolTablets,
    },
    {
      id: "item-levo",
      sourceId: "src-letter",
      asWritten: "Levothyroxine 25 micrograms OM",
      product: PRODUCT.levothyroxine,
    },
  ],
};

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

const decisions: { entry: EntryDecision[]; item: ItemDecision[] } = {
  entry: [
    { kind: "continue", entryId: "entry-para", itemIds: ["item-para"], note: null },
    {
      kind: "stop",
      entryId: "entry-alen",
      itemIds: [],
      sourceId: "src-letter",
      reason: "Discharge letter: alendronic acid stopped on the ward, review by GP",
    },
  ],
  item: [{ kind: "start", itemId: "item-levo", draft: newDraft }],
};

function completion(overrides: Partial<ReconciliationCompletion> = {}): ReconciliationCompletion {
  return {
    reconciliation,
    currentEntries: [paracetamol, alendronic],
    entryDecisions: decisions.entry,
    itemDecisions: decisions.item,
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
        reason: "Discharge letter: alendronic acid stopped on the ward, review by GP",
        source: {
          kind: "discharge_letter",
          reference: "Discharge letter, Ward 7, 03/11/2026",
          documentId: "doc-7",
        },
      },
    ]);
    expect(result.plan.starts).toHaveLength(1);
    expect(result.plan.starts[0]?.draft).toMatchObject({
      personId: PERSON,
      product: PRODUCT.levothyroxine,
      source: { kind: "discharge_letter", documentId: "doc-7" },
    });
    expect(result.plan).toMatchObject({ completedBy: NURSE, changes: [], notStarted: [] });
  });

  it("makes a change from the source line that shows it", () => {
    const change: EntryDecision = {
      kind: "change",
      entryId: "entry-para",
      itemIds: ["item-para"],
      draft: { ...newDraft, product: PRODUCT.paracetamolTablets, indication: "Pain" },
    };
    const result = completeReconciliation(
      completion({ entryDecisions: [change, decisions.entry[1] as EntryDecision] }),
    );
    if (!result.ok) throw new Error("refused");
    expect(result.plan.changes).toMatchObject([
      { entryId: "entry-para", draft: { personId: PERSON, source: { kind: "discharge_letter" } } },
    ]);
  });

  it("records a source line not started, with the reason", () => {
    const result = completeReconciliation(
      completion({
        itemDecisions: [
          {
            kind: "not_started",
            itemId: "item-levo",
            reason: "Already stopped by the GP on 03/11, confirmed by phone",
          },
        ],
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      plan: { notStarted: [{ itemId: "item-levo" }], starts: [] },
    });
  });
});

describe("hazard HZ-121 every medicine on the MAR needs a decision before a reconciliation completes", () => {
  it("never stops a medicine because the discharge letter leaves it out: the person decides", () => {
    const withoutStop = completion({ entryDecisions: [decisions.entry[0] as EntryDecision] });
    const result = completeReconciliation(withoutStop);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ problem: "entry_undecided", entryId: "entry-alen" }),
      );
      expect(result.issues.find((i) => i.problem === "entry_undecided")?.message).toBe(
        "Decide what happens to Alendronic acid 70mg tablets: continue, change, stop or ask.",
      );
    }
  });

  it("continuing a medicine no source lists needs a note saying how it was confirmed", () => {
    const keep: EntryDecision = {
      kind: "continue",
      entryId: "entry-alen",
      itemIds: [],
      note: null,
    };
    expect(
      problems(completion({ entryDecisions: [decisions.entry[0] as EntryDecision, keep] })),
    ).toEqual(["continue_not_in_sources"]);
    const confirmed = { ...keep, note: "GP confirmed by phone on 03/11/2026 that it continues" };
    expect(
      problems(completion({ entryDecisions: [decisions.entry[0] as EntryDecision, confirmed] })),
    ).toEqual([]);
  });

  it("a stop names the source document that shows it, never only what the family says", () => {
    const stop = decisions.entry[1] as Extract<EntryDecision, { kind: "stop" }>;
    const others = [decisions.entry[0] as EntryDecision];
    expect(
      problems(completion({ entryDecisions: [...others, { ...stop, sourceId: "src-family" }] })),
    ).toEqual(["source_not_a_document"]);
    expect(
      problems(completion({ entryDecisions: [...others, { ...stop, sourceId: "src-unknown" }] })),
    ).toEqual(["unknown_source"]);
    expect(problems(completion({ entryDecisions: [...others, { ...stop, reason: " " }] }))).toEqual(
      ["stop_needs_reason"],
    );
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
      kind: "continue",
      entryId: "entry-para",
      itemIds: [],
      note: "Still taking",
    };
    expect(problems(completion({ entryDecisions: [...decisions.entry, again] }))).toEqual([
      "entry_decided_twice",
    ]);
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
      [{ kind: "start", itemId: "item-para", draft: newDraft }, decisions.item[0] as ItemDecision],
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
      [...decisions.item, { kind: "not_started", itemId: "item-x", reason: "n/a" }],
      null,
      ["unknown_item"],
    ],
    [
      "a change with no source line to show it",
      decisions.item,
      [
        { kind: "change", entryId: "entry-para", itemIds: [], draft: newDraft },
        decisions.entry[1] as EntryDecision,
      ],
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
    const family: Reconciliation = {
      ...reconciliation,
      items: [
        ...reconciliation.items,
        {
          id: "item-cream",
          sourceId: "src-family",
          asWritten: "A cream for her knees",
          product: null,
        },
      ],
    };
    const start: ItemDecision = { kind: "start", itemId: "item-cream", draft: newDraft };
    expect(
      problems(completion({ reconciliation: family, itemDecisions: [...decisions.item, start] })),
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
    const item = { ...reconciliation.items[0], product } as Reconciliation["items"][number];
    expect(linkDifference(mar, item)).toBe(difference);
    const rec = {
      ...reconciliation,
      items: [item, reconciliation.items[1] as Reconciliation["items"][number]],
    };
    const input = completion({ reconciliation: rec, currentEntries: [mar, alendronic] });
    expect(problems(input)).toEqual(["continue_with_difference"]);
    const noted = {
      ...(decisions.entry[0] as EntryDecision),
      note: "The pharmacy supplies this brand; same medicine and strength",
    };
    expect(
      problems({ ...input, entryDecisions: [noted, decisions.entry[1] as EntryDecision] }),
    ).toEqual([]);
  });

  it("the same product needs no note", () => {
    expect(
      linkDifference(paracetamol, reconciliation.items[0] as Reconciliation["items"][number]),
    ).toBeNull();
  });
});

describe("hazard HZ-121 a reconciliation cannot complete while a query is open", () => {
  it.each<[string, Partial<ReconciliationCompletion>]>([
    [
      "about a MAR entry",
      {
        entryDecisions: [
          decisions.entry[0] as EntryDecision,
          {
            kind: "query",
            entryId: "entry-alen",
            question: "Was alendronic acid stopped on purpose?",
          },
        ],
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
      {
        entryDecisions: [
          decisions.entry[0] as EntryDecision,
          { kind: "query", entryId: "entry-alen", question: "" },
        ],
      },
    ],
  ])("%s", (_name, overrides) => {
    expect(problems(completion(overrides))).toEqual(["query_open"]);
  });
});

describe("hazard HZ-121 a return from hospital needs the discharge letter or a reason it is not there", () => {
  const noLetter: Reconciliation = {
    ...reconciliation,
    sources: [
      {
        id: "src-gp",
        kind: "gp_record",
        reference: "GP summary, 03/11/2026",
        documentId: null,
        receivedAt: returnedAt,
      },
    ],
    items: [
      { ...(reconciliation.items[0] as Reconciliation["items"][number]), sourceId: "src-gp" },
    ],
  };
  const gpStop = {
    ...(decisions.entry[1] as Extract<EntryDecision, { kind: "stop" }>),
    sourceId: "src-gp",
  };
  const input = completion({
    reconciliation: noLetter,
    entryDecisions: [decisions.entry[0] as EntryDecision, gpStop],
    itemDecisions: [],
  });

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

describe("who completes a reconciliation and what they confirm", () => {
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
          { kind: "continue", entryId: "entry-para", itemIds: [], note: "x" },
          { kind: "continue", entryId: "entry-alen", itemIds: [], note: "x" },
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
    expect(
      problems(
        completion({
          personInvolvement: {
            involved: false,
            reason: "Asleep after the journey; daughter involved instead",
          },
        }),
      ),
    ).toEqual([]);
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
