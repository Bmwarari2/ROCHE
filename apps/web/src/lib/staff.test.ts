import { describe, expect, it } from "vitest";
import { t } from "./i18n";
import {
  choosableMembers,
  complianceChip,
  consentChip,
  fileChip,
  othersOnly,
  privacyShown,
  readAbsence,
  readComplianceItem,
  readMarkReported,
  readReport,
  readSponsoredWorker,
  readStaffFile,
  reportChip,
  salaryChip,
  sponsorManaged,
  sponsorShown,
  staffFilesManaged,
  staffFilesShown,
  visaChip,
} from "./staff";

/** The staff, sponsor and privacy screens' rules (slice 56). Invented people only. */

const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(values)) data.set(k, v);
  return data;
};
const dateOf = (name: string, iso: string) => {
  const [year, month, day] = iso.split("-");
  return {
    [`${name}-day`]: day ?? "",
    [`${name}-month`]: month ?? "",
    [`${name}-year`]: year ?? "",
  };
};
const fields = (r: { ok: boolean; problems?: { field: string }[] }) =>
  r.ok ? [] : (r.problems ?? []).map((p) => p.field);

describe("who is offered what", () => {
  it.each([
    [
      "HR",
      [
        "workforce.staff_file.read",
        "workforce.staff_file.manage",
        "workforce.immigration.read",
        "workforce.sponsor.manage",
      ],
      [true, true, true, true],
    ],
    [
      "a Registered Manager",
      ["workforce.staff_file.read", "workforce.staff_file.manage"],
      [true, true, false, false],
    ],
    ["immigration read only", ["workforce.immigration.read"], [false, false, true, false]],
    ["a care worker", ["workforce.self.read"], [false, false, false, false]],
  ] as const)("%s", (_who, permissions, [shown, managed, sponsor, sponsorWrite]) => {
    expect(staffFilesShown(permissions)).toBe(shown);
    expect(staffFilesManaged(permissions)).toBe(managed);
    expect(sponsorShown(permissions)).toBe(sponsor);
    expect(sponsorManaged(permissions)).toBe(sponsorWrite);
  });

  it("offers My privacy to staff only", () => {
    expect(privacyShown(["workforce.self.read"])).toBe(true);
    expect(privacyShown(["comms.portal.family"])).toBe(false);
  });

  it("never offers oneself, or a member already kept, as a new record", () => {
    const members = [
      { id: "a", displayName: "Ada Example", jobTitle: null },
      { id: "b", displayName: "Ben Example", jobTitle: "Carer" },
      null,
      { id: "c", displayName: "Cy Example", jobTitle: null },
    ];
    expect(choosableMembers(members, "a", ["c"]).map((m) => m.id)).toEqual(["b"]);
  });

  it("never shows the reader their own sponsor record", () => {
    expect(othersOnly([{ tenantUserId: "a" }, { tenantUserId: "b" }], "a")).toEqual([
      { tenantUserId: "b" },
    ]);
  });
});

describe("states are an icon and a word, never colour alone", () => {
  it.each([
    ["satisfied", "Done", "circle-check"],
    ["due_soon", "Due soon", "clock"],
    ["expired", "Expired", "circle-alert"],
    ["missing", "Not recorded", "circle-alert"],
    ["not_required", "Not needed", "circle-minus"],
  ] as const)("compliance %s", (status, label, icon) => {
    expect(complianceChip(status, t)).toMatchObject({ label, icon });
  });

  it("files, visas, salary, reports and consent", () => {
    expect(fileChip(true, t).label).toBe("Complete");
    expect(fileChip(false, t).label).toBe("Checks outstanding");
    expect(visaChip("due_soon", t)).toMatchObject({ label: "Visa ends soon", icon: "clock" });
    expect(salaryChip(false, t).label).toBe("Below the salary rules");
    expect(reportChip("overdue", t)).toMatchObject({ label: "Overdue", status: "overdue" });
    expect(reportChip("reported_late", t).label).toBe("Reported late");
    expect(consentChip("none", t).label).toBe("Not asked yet");
    expect(consentChip("given", t).label).toBe("Yes");
    expect(consentChip("withdrawn", t).label).toBe("Withdrawn");
  });
});

describe("the staff file form", () => {
  it("needs the member when starting a file, and a job title", () => {
    expect(fields(readStaffFile(form({}), t, true))).toEqual(["tenantUserId", "jobTitle"]);
    const ok = readStaffFile(
      form({
        tenantUserId: "m1",
        jobTitle: "Care worker",
        previousCareWork: "on",
        ...dateOf("startsOn", "2026-09-01"),
      }),
      t,
      true,
    );
    expect(ok).toMatchObject({
      ok: true,
      value: {
        tenantUserId: "m1",
        jobTitle: "Care worker",
        previousCareWork: true,
        startsOn: "2026-09-01",
        locationId: null,
        registrationBody: null,
      },
    });
  });

  it("refuses a leaving date before the start", () => {
    const r = readStaffFile(
      form({
        jobTitle: "Nurse",
        ...dateOf("startsOn", "2026-09-01"),
        ...dateOf("leftOn", "2026-08-01"),
      }),
      t,
      false,
    );
    expect(fields(r)).toEqual(["leftOn"]);
  });
});

describe("the compliance item form", () => {
  it("reads a DBS check and refuses a short certificate number", () => {
    const base = {
      level: "enhanced_adults_barred",
      result: "clear",
      ...dateOf("issuedOn", "2026-08-01"),
    };
    expect(
      fields(readComplianceItem(form({ ...base, number: "123" }), "dbs_certificate", null, t)),
    ).toEqual(["number"]);
    const ok = readComplianceItem(
      form({ ...base, number: "0012 3456 7890", verifiedToday: "on" }),
      "dbs_certificate",
      null,
      t,
      "2026-10-31",
    );
    expect(ok).toMatchObject({
      ok: true,
      value: {
        verifiedOn: "2026-10-31",
        detail: {
          kind: "dbs_certificate",
          certificate: { number: "001234567890", issuedOn: "2026-08-01" },
          updateService: null,
        },
      },
    });
  });

  it("adds a right to work check to those kept, and needs an end for time-limited permission", () => {
    const kept = {
      kind: "right_to_work" as const,
      checks: [
        {
          checkedOn: "2026-01-01",
          method: "manual_document" as const,
          permission: "unlimited" as const,
          expiresOn: null,
        },
      ],
    };
    const limited = {
      method: "online_share_code",
      permission: "time_limited",
      ...dateOf("checkedOn", "2026-10-01"),
    };
    expect(fields(readComplianceItem(form(limited), "right_to_work", kept, t))).toEqual([
      "expiresOn",
    ]);
    const ok = readComplianceItem(
      form({ ...limited, ...dateOf("expiresOn", "2028-10-01") }),
      "right_to_work",
      kept,
      t,
    );
    expect(
      ok.ok && ok.value.detail.kind === "right_to_work" ? ok.value.detail.checks.length : 0,
    ).toBe(2);
  });

  it.each([
    ["references", { count: "2" }, true],
    ["references", { count: "21" }, false],
    ["conduct_in_care_work", { count: "x" }, false],
    ["identity_with_photo", { document: "passport" }, true],
    ["identity_with_photo", { document: "library_card" }, false],
    ["health_fitness", { declaredFit: "on" }, true],
    [
      "relevant_qualifications",
      { qualifications: "Level 2 Adult Social Care\nCare Certificate" },
      true,
    ],
    [
      "professional_registration",
      { body: "nmc", pin: "12a3456e", ...dateOf("renewalDueOn", "2027-01-31") },
      true,
    ],
    [
      "professional_registration",
      { body: "nmc", pin: "x", ...dateOf("renewalDueOn", "2027-01-31") },
      false,
    ],
    ["employment_history", {}, false],
  ] as const)("%s with %j reads %s", (kind, values, ok) => {
    expect(readComplianceItem(form(values as Record<string, string>), kind, null, t).ok).toBe(ok);
  });
});

describe("the sponsor forms", () => {
  const worker = {
    tenantUserId: "m1",
    cosReference: "c2x 000 0001",
    socCode: "6145",
    route: "health_and_care_worker",
    contractedWeeklyHours: "37.5",
    guaranteedYearlyPay: "£25,000",
    englishEvidence: "secure_english_language_test",
    "appendixD.right_to_work_check": "on",
    ...dateOf("cosAssignedOn", "2026-01-10"),
    ...dateOf("visaExpiresOn", "2029-01-10"),
  };

  it("reads a record, tidying the certificate number and pay", () => {
    expect(readSponsoredWorker(form(worker), t, true)).toMatchObject({
      ok: true,
      value: {
        cosReference: "C2X0000001",
        guaranteedYearlyPay: 25000,
        contractedWeeklyHours: 37.5,
        appendixDHeld: ["right_to_work_check"],
      },
    });
  });

  it("names every field it cannot use", () => {
    expect(fields(readSponsoredWorker(form({}), t, true))).toEqual([
      "tenantUserId",
      "cosReference",
      "cosAssignedOn",
      "socCode",
      "route",
      "visaExpiresOn",
      "contractedWeeklyHours",
      "guaranteedYearlyPay",
    ]);
    expect(
      fields(readSponsoredWorker(form({ ...worker, contractedWeeklyHours: "0" }), t, true)),
    ).toEqual(["contractedWeeklyHours"]);
  });

  it("absences, reports and marking reported", () => {
    expect(
      fields(
        readAbsence(
          form({
            ...dateOf("fromOn", "2026-06-10"),
            ...dateOf("toOn", "2026-06-01"),
            authorised: "no",
          }),
          t,
        ),
      ),
    ).toEqual(["toOn"]);
    expect(
      readAbsence(
        form({
          ...dateOf("fromOn", "2026-06-01"),
          ...dateOf("toOn", "2026-06-10"),
          authorised: "no",
        }),
        t,
      ),
    ).toMatchObject({
      ok: true,
      value: { authorised: false },
    });
    expect(
      fields(
        readReport(
          form({ kind: "change_of_hours", ...dateOf("happenedOn", "2027-01-01") }),
          t,
          "2026-10-31",
        ),
      ),
    ).toEqual(["happenedOn"]);
    expect(
      fields(
        readMarkReported(
          form({ ...dateOf("reportedOn", "2026-05-01"), smsReference: "" }),
          "2026-06-01",
          t,
          "2026-10-31",
        ),
      ),
    ).toEqual(["reportedOn", "smsReference"]);
  });
});
