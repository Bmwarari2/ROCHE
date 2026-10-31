import type { EvidencePackDetail } from "@harbour/contracts";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  daysUntil,
  evidenceLinkUrl,
  evidencePacksShown,
  expiryChoices,
  expiryWords,
  fieldOutcomeChip,
  keyQuestionLabel,
  latestLink,
  linkState,
  packActions,
  packStateChip,
  readComposeForm,
  readEndReason,
  readRecordChoices,
  redactable,
  shareCounts,
} from "./evidence-packs";

const t = createTranslator("en-GB");
const ME = "0194d000-0000-7000-8100-000000000001";
const OTHER = "0194d000-0000-7000-8100-000000000002";
const LOCATION = "0194d000-0000-7000-8200-000000000001";
const PERSON = "0194d000-0000-7000-8600-000000000003";
const NOTE = "0194d000-0000-7000-8900-000000000001";
const NOW = new Date("2026-10-31T12:00:00Z");

function form(entries: [string, string][]) {
  const data = new FormData();
  for (const [k, v] of entries) data.append(k, v);
  return data;
}

const COMPLETE: [string, string][] = [
  ["recipientName", "Ivy Inspector"],
  ["recipientOrganisation", "CQC"],
  ["recipientEmail", "ivy.inspector@example.invalid"],
  ["purpose", "Assessment of Harbour House, falls"],
  ["from-day", "1"],
  ["from-month", "10"],
  ["from-year", "2026"],
  ["to-day", "31"],
  ["to-month", "10"],
  ["to-year", "2026"],
  ["locationIds", LOCATION],
  ["personIds", PERSON],
  ["staffNames", "role_only"],
  ["statements", "all"],
];

type Field = EvidencePackDetail["items"][number]["fields"][number];
const field = (outcome: Field["outcome"], kind: Field["kind"] = "free_text"): Field => ({
  key: "text",
  label: "Note",
  kind,
  outcome,
  reason: null,
  reasonText: null,
  redactedBy: null,
  value: outcome === "withheld" ? null : "Shown",
});
type Link = EvidencePackDetail["links"][number];
const link = (over: Partial<Link> = {}): Link => ({
  id: "0194d000-0000-7000-8a00-000000000001",
  issuedAt: "2026-10-30T09:00:00Z",
  issuedBy: OTHER,
  expiresAt: "2026-11-06T09:00:00Z",
  replacesLinkId: null,
  revokedAt: null,
  revocationReason: null,
  failedCodeAttempts: 0,
  locked: false,
  lastOpenedAt: null,
  version: 1,
  ...over,
});
type Pack = Parameters<typeof packActions>[0];
const pack = (over: Partial<Pack> = {}): Pack => ({
  state: "draft",
  contributorIds: [OTHER],
  items: [
    {
      id: "i1",
      recordType: "care_note",
      recordId: NOTE,
      recordVersion: 1,
      title: "Care note: mood",
      occurredAt: "2026-10-20T10:00:00Z",
      qualityStatementIds: ["safe"],
      exclusionReason: null,
      fields: [field("included", "organisational"), field("withheld"), field("redacted")],
    },
    {
      id: "i2",
      recordType: "care_note",
      recordId: NOTE,
      recordVersion: 1,
      title: "Care note: night",
      occurredAt: "2026-09-20T10:00:00Z",
      qualityStatementIds: ["safe"],
      exclusionReason: "outside_date_range",
      fields: [],
    },
  ],
  links: [],
  bundleDeleted: false,
  ...over,
});

describe("the evidence pack screens (quality.md section 16; QUAL-003; HZ-050)", () => {
  it("shows the screens to holders of compose or release only", () => {
    expect(evidencePacksShown(["quality.evidence_pack.compose"])).toBe(true);
    expect(evidencePacksShown(["quality.evidence_pack.release"])).toBe(true);
    expect(evidencePacksShown(["quality.evidence.read", "care.note.read"])).toBe(false);
  });

  it("reads a complete compose form, every key question when none is chosen", () => {
    const read = readComposeForm(form(COMPLETE), t);
    expect(read).toEqual({
      ok: true,
      body: {
        recipient: {
          name: "Ivy Inspector",
          organisation: "CQC",
          email: "ivy.inspector@example.invalid",
        },
        purpose: "Assessment of Harbour House, falls",
        from: "2026-10-01",
        to: "2026-10-31",
        locationIds: [LOCATION],
        qualityStatementIds: null,
        personIds: [PERSON],
        staffNames: "role_only",
      },
    });
  });

  it("hazard HZ-050 lists every compose problem at once, with no 'everyone' for the people in scope", () => {
    const read = readComposeForm(form([["statements", "some"]]), t);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problems.map((p) => p.field)).toEqual([
      "recipientName",
      "recipientOrganisation",
      "recipientEmail",
      "purpose",
      "from",
      "to",
      "locationIds",
      "personIds",
      "statementIds",
    ]);
    expect(read.problems.find((p) => p.field === "personIds")?.message).toBe(
      "Tick at least one person the pack is about",
    );
  });

  it("refuses dates out of order, a short purpose and an address that is not an email", () => {
    const read = readComposeForm(
      form(
        COMPLETE.map(([k, v]) =>
          k === "to-day"
            ? [k, "1"]
            : k === "to-month"
              ? [k, "9"]
              : k === "purpose"
                ? [k, "Falls"]
                : k === "recipientEmail"
                  ? [k, "not an email"]
                  : [k, v],
        ),
      ),
      t,
    );
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problems.map((p) => p.field)).toEqual(["recipientEmail", "purpose", "to"]);
  });

  it("keeps only the chosen key questions and ignores ids it does not offer", () => {
    const read = readComposeForm(
      form([
        ...COMPLETE.filter(([k]) => k !== "statements"),
        ["statements", "some"],
        ["statementIds", "well-led"],
        ["statementIds", "<script>"],
      ]),
      t,
    );
    expect(read.ok && read.body.qualityStatementIds).toEqual(["well-led"]);
    expect(keyQuestionLabel("well-led", t)).toBe("Well-led");
  });

  it("reads ticked records with the areas they are evidence for, or says what is missing", () => {
    expect(
      readRecordChoices(
        form([
          ["records", `care_note:${NOTE}`],
          ["records", "medicine:x"],
          ["statementIds", "safe"],
        ]),
        t,
      ),
    ).toEqual({
      ok: true,
      items: [{ recordType: "care_note", recordId: NOTE, qualityStatementIds: ["safe"] }],
    });
    const none = readRecordChoices(form([]), t);
    expect(none.ok).toBe(false);
    expect(!none.ok && Object.keys(none.errors)).toEqual(["records", "statementIds"]);
  });

  it("takes a reason of 3 to 500 characters to withdraw or discard", () => {
    expect(readEndReason(form([["reason", "ok"]]), t).ok).toBe(false);
    expect(readEndReason(form([["reason", "Inspection over"]]), t)).toEqual({
      ok: true,
      reason: "Inspection over",
    });
  });

  it("says each state and field outcome with an icon and a word, never colour alone", () => {
    expect(packStateChip("released", t)).toEqual({
      status: "info",
      icon: "send",
      label: "Released",
    });
    expect(packStateChip("revoked", t).label).toBe("Withdrawn");
    expect(fieldOutcomeChip("withheld", t)).toEqual({
      status: "neutral",
      icon: "eye-off",
      label: "Withheld",
    });
    expect(fieldOutcomeChip("redacted", t).label).toBe("Redacted by hand");
    expect(fieldOutcomeChip("included", t).label).toBe("Shown");
  });

  it("hazard HZ-050 counts what will be shared, and free text still waiting for a hand redaction", () => {
    expect(shareCounts(pack())).toEqual({
      included: 1,
      excluded: 1,
      withheld: 1,
      redacted: 1,
      awaitingRedaction: 1,
    });
    expect(redactable(field("withheld"))).toBe(true);
    expect(redactable(field("withheld", "direct_identifier"))).toBe(false);
    expect(redactable(field("redacted"))).toBe(false);
  });

  it.each<[string, Partial<Link>, string]>([
    ["working before expiry", {}, "live"],
    ["expired at the expiry instant", { expiresAt: NOW.toISOString() }, "expired"],
    [
      "withdrawn",
      { revokedAt: "2026-10-31T10:00:00Z", revocationReason: "pack_revoked" },
      "revoked",
    ],
    [
      "replaced by a new link",
      { revokedAt: "2026-10-31T10:00:00Z", revocationReason: "reissued" },
      "replaced",
    ],
    ["locked after wrong codes", { locked: true, failedCodeAttempts: 5 }, "locked"],
  ])("hazard HZ-050 a link is %s", (_, over, state) => {
    expect(linkState(link(over), NOW)).toBe(state);
  });

  it("says the link's expiry in words, rounding up so a link never reads as ended early", () => {
    expect(daysUntil("2026-11-06T09:00:00Z", NOW)).toBe(6);
    expect(daysUntil("2026-10-31T13:00:00Z", NOW)).toBe(1);
    expect(daysUntil("2026-10-31T11:00:00Z", NOW)).toBe(0);
    expect(expiryWords("2026-11-06T09:00:00Z", "06/11/2026 09:00", NOW, t)).toBe(
      "Works until 06/11/2026 09:00, in 6 days",
    );
    expect(expiryWords("2026-10-31T13:00:00Z", "31/10/2026 13:00", NOW, t)).toBe(
      "Works until 31/10/2026 13:00, ends within a day",
    );
    expect(expiryWords("2026-10-30T09:00:00Z", "30/10/2026 09:00", NOW, t)).toBe(
      "Stopped working at 30/10/2026 09:00",
    );
  });

  it("offers link lengths never past the maximum, the default among them", () => {
    expect(expiryChoices(7, 30)).toEqual([1, 3, 7, 14, 30]);
    expect(expiryChoices(7, 7)).toEqual([1, 3, 7]);
    expect(expiryChoices(2, 2)).toEqual([1, 2]);
  });

  it("hazard HZ-050 keeps the token in the link's fragment, which never reaches a server", () => {
    const url = evidenceLinkUrl("https://harbour.example.invalid/", "a".repeat(43));
    expect(url).toBe(`https://harbour.example.invalid/evidence#${"a".repeat(43)}`);
    expect(new URL(url).search).toBe("");
  });

  it("finds the newest link", () => {
    const older = link({ id: "old", issuedAt: "2026-10-01T09:00:00Z" });
    const newer = link({ id: "new", issuedAt: "2026-10-30T09:00:00Z" });
    expect(latestLink({ links: [newer, older] })?.id).toBe("new");
    expect(latestLink({ links: [] })).toBeNull();
  });

  describe("hazard HZ-050 nobody who shaped a pack is offered its release or a new link", () => {
    const both = ["quality.evidence_pack.compose", "quality.evidence_pack.release"];

    it("offers release to a holder who did not work on the draft", () => {
      const actions = packActions(pack(), { tenantUserId: ME, permissions: both }, NOW);
      expect(actions).toMatchObject({ release: true, releaseBlock: null, addRecords: true });
    });

    it("tells a contributor why they cannot release", () => {
      const actions = packActions(
        pack({ contributorIds: [ME] }),
        { tenantUserId: ME, permissions: both },
        NOW,
      );
      expect(actions).toMatchObject({ release: false, releaseBlock: "contributor" });
    });

    it("needs something to send", () => {
      const actions = packActions(
        pack({ items: [] }),
        { tenantUserId: ME, permissions: both },
        NOW,
      );
      expect(actions.releaseBlock).toBe("no_items");
    });

    it("needs the release permission", () => {
      const actions = packActions(
        pack(),
        { tenantUserId: ME, permissions: ["quality.evidence_pack.compose"] },
        NOW,
      );
      expect(actions).toMatchObject({ release: false, releaseBlock: "no_permission" });
    });

    it("offers a new link only on a released pack with a live link, to a non-contributor", () => {
      const released = pack({ state: "released", links: [link()] });
      expect(packActions(released, { tenantUserId: ME, permissions: both }, NOW)).toMatchObject({
        reissue: true,
        revoke: true,
        release: false,
        addRecords: false,
        redact: false,
      });
      expect(
        packActions(
          { ...released, contributorIds: [ME] },
          { tenantUserId: ME, permissions: both },
          NOW,
        ).reissue,
      ).toBe(false);
      expect(
        packActions(
          { ...released, links: [link({ expiresAt: "2026-10-30T09:00:00Z" })] },
          { tenantUserId: ME, permissions: both },
          NOW,
        ).reissue,
      ).toBe(false);
      expect(
        packActions(
          { ...released, bundleDeleted: true },
          { tenantUserId: ME, permissions: both },
          NOW,
        ).reissue,
      ).toBe(false);
    });
  });
});
