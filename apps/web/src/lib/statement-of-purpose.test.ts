import type { StatementOfPurposeVersionItem } from "@harbour/contracts";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  approveBlock,
  awaitingNotification,
  EMPTY_CONTENT,
  linesOf,
  notificationChip,
  readNotifyForm,
  readStatementForm,
  statementShown,
  statementView,
  versionStateChip,
} from "./statement-of-purpose";

const t = createTranslator("en-GB");
const ME = "0194d000-0000-7000-8100-000000000001";
const OTHER = "0194d000-0000-7000-8100-000000000002";
const MANAGER_ID = "0194d000-0000-7000-8b00-000000000001";
const PLACE_ID = "0194d000-0000-7000-8c00-000000000001";
const NOW = new Date("2026-10-31T12:00:00Z");

function form(entries: [string, string][]) {
  const data = new FormData();
  for (const [k, v] of entries) data.append(k, v);
  return data;
}

type Version = StatementOfPurposeVersionItem;
const version = (over: Partial<Version>): Version => ({
  id: "v",
  versionNumber: 1,
  state: "approved",
  kind: "baseline",
  content: EMPTY_CONTENT,
  authorId: OTHER,
  contributorIds: [],
  supersedesId: null,
  missing: [],
  warnings: [],
  changeSummary: [],
  registrationPrompts: [],
  approvedBy: ME,
  approvedAt: "2026-10-01T09:00:00Z",
  notification: {
    state: "not_required",
    dueAt: null,
    notifiedAt: null,
    notifiedBy: null,
    late: false,
  },
  discardReason: null,
  version: 1,
  ...over,
});

describe("the statement of purpose screens (quality.md section 16; QUAL-009; HZ-080)", () => {
  it("shows the screens to writers, approvers and those who send to CQC", () => {
    expect(statementShown(["quality.statement_of_purpose.write"])).toBe(true);
    expect(statementShown(["quality.statement_of_purpose.approve"])).toBe(true);
    expect(statementShown(["safety.notification.submit"])).toBe(true);
    expect(statementShown(["care.note.read"])).toBe(false);
  });

  it("reads the editor: kinds one per line, rows keeping their ids, empty rows and emails dropped", () => {
    const read = readStatementForm(
      form([
        ["aimsAndObjectives", "  To support people to live well.  "],
        ["serviceKinds", "Care home service with nursing\n\n Care home service without nursing "],
        ["needsMet", "Older people, dementia."],
        ["providerName", "Harbour Care Ltd"],
        ["providerAddress", "1 Example Street"],
        ["providerPhone", "01632 960000"],
        ["providerEmail", ""],
        ["managerId", MANAGER_ID],
        ["managerName", "Ada Example"],
        ["managerAddress", "1 Example Street"],
        ["managerPhone", "01632 960001"],
        ["managerEmail", "ada@example.invalid"],
        ["managerId", "0194d000-0000-7000-8b00-000000000002"],
        ["managerName", ""],
        ["managerAddress", ""],
        ["managerPhone", ""],
        ["managerEmail", ""],
        ["serviceAddress", "1 Example Street"],
        ["legalStatus", "limited_company"],
        ["legalStatusDetail", "ignored unless other"],
        ["locationId", PLACE_ID],
        ["locationName", "Harbour House"],
        ["locationAddress", "1 Example Street"],
        ["locationCqcId", "1-000000001"],
      ]),
      t,
    );
    expect(read).toEqual({
      ok: true,
      content: {
        aimsAndObjectives: "To support people to live well.",
        serviceKinds: ["Care home service with nursing", "Care home service without nursing"],
        needsMet: "Older people, dementia.",
        provider: {
          fullName: "Harbour Care Ltd",
          businessAddress: "1 Example Street",
          businessPhone: "01632 960000",
          email: null,
        },
        registeredManagers: [
          {
            id: MANAGER_ID,
            fullName: "Ada Example",
            businessAddress: "1 Example Street",
            businessPhone: "01632 960001",
            email: "ada@example.invalid",
          },
        ],
        serviceAddress: "1 Example Street",
        consentsToEmailService: false,
        serviceEmail: null,
        legalStatus: "limited_company",
        legalStatusDetail: null,
        locations: [
          {
            id: PLACE_ID,
            name: "Harbour House",
            address: "1 Example Street",
            cqcLocationId: "1-000000001",
          },
        ],
      },
    });
  });

  it("refuses only what the API would: too long, too many kinds of service", () => {
    const read = readStatementForm(
      form([
        ["serviceKinds", Array.from({ length: 21 }, (_, i) => `Kind ${i}`).join("\n")],
        ["providerPhone", "0".repeat(41)],
      ]),
      t,
    );
    expect(read.ok).toBe(false);
    expect(!read.ok && Object.keys(read.errors)).toEqual(["serviceKinds", "providerPhone"]);
  });

  it("hazard HZ-080 says each version's state and its CQC clock with an icon and a word", () => {
    expect(versionStateChip("approved", t).label).toBe("In force");
    expect(versionStateChip("superseded", t).label).toBe("Replaced");
    const n = (state: Version["notification"]["state"], late = false) => ({
      state,
      dueAt: "2026-11-28T00:00:00Z",
      notifiedAt: null,
      notifiedBy: null,
      late,
    });
    expect(notificationChip(n("overdue"), t)).toEqual({
      status: "overdue",
      icon: "circle-alert",
      label: "Overdue at CQC",
    });
    expect(notificationChip(n("due"), t).label).toBe("Due at CQC");
    expect(notificationChip(n("notified", true), t).label).toBe("Sent to CQC late");
    expect(notificationChip(n("not_required"), t).label).toBe("CQC already holds it");
  });

  it("hazard HZ-080 puts every revision still to reach CQC first, the earliest due at the top", () => {
    const due = (id: string, state: "due" | "overdue", dueAt: string) =>
      version({
        id,
        kind: "revision",
        notification: { state, dueAt, notifiedAt: null, notifiedBy: null, late: false },
      });
    const list = awaitingNotification([
      version({ id: "base" }),
      due("later", "due", "2026-11-20T00:00:00Z"),
      due("first", "overdue", "2026-10-20T00:00:00Z"),
    ]);
    expect(list.map((v) => v.id)).toEqual(["first", "later"]);
  });

  it("offers the baseline only before any version, and a revision only with none in draft", () => {
    const write = ["quality.statement_of_purpose.write"];
    expect(statementView([], write)).toMatchObject({ startBaseline: true, startRevision: false });
    expect(statementView([version({})], write)).toMatchObject({
      startBaseline: false,
      startRevision: true,
    });
    const withDraft = statementView([version({ id: "d", state: "draft" }), version({})], write);
    expect(withDraft).toMatchObject({ startBaseline: false, startRevision: false });
    expect(withDraft.draft?.id).toBe("d");
    expect(statementView([], []).startBaseline).toBe(false);
  });

  it("hazard HZ-080 never offers approval to the author or an editor, and says why", () => {
    const approve = ["quality.statement_of_purpose.approve"];
    const draft = version({ state: "draft", authorId: OTHER, contributorIds: [] });
    expect(approveBlock(draft, { tenantUserId: ME, permissions: approve })).toBeNull();
    expect(
      approveBlock({ ...draft, authorId: ME }, { tenantUserId: ME, permissions: approve }),
    ).toBe("author");
    expect(
      approveBlock({ ...draft, contributorIds: [ME] }, { tenantUserId: ME, permissions: approve }),
    ).toBe("author");
    expect(
      approveBlock(
        { ...draft, missing: ["Give the provider's full name."] },
        { tenantUserId: ME, permissions: approve },
      ),
    ).toBe("incomplete");
    expect(approveBlock(draft, { tenantUserId: ME, permissions: [] })).toBe("no_permission");
  });

  it("reads when it was sent to CQC, chosen every time, and how", () => {
    expect(
      readNotifyForm(
        form([
          ["sentAt-mode", "now"],
          ["evidence", "Portal ref 123"],
        ]),
        NOW,
        t,
      ),
    ).toEqual({
      ok: true,
      sentAt: null,
      evidence: "Portal ref 123",
    });
    const blank = readNotifyForm(form([]), NOW, t);
    expect(!blank.ok && Object.keys(blank.errors)).toEqual(["sentAt", "evidence"]);
  });

  it("reads the API's change lines and prompts as text", () => {
    expect(
      linesOf([
        { key: "locations", lines: ["Location added: Harbour Lodge"] },
        { message: "Apply to vary" },
        3,
      ]),
    ).toEqual(["Location added: Harbour Lodge", "Apply to vary"]);
  });
});
