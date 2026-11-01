import { describe, expect, it } from "vitest";
import { secretRefProblem, senderAllowed } from "./secret-ref";

/**
 * #164 security review: an organisation names only its own integration secrets, in this
 * environment's project (L3), and sends only from allowed domains (L2). Invented ids only.
 */

const TENANT = "0194d000-0000-7000-8000-000000000001";
const OTHER = "0194d000-0000-7000-8000-000000000002";
const PROJECT = "harbour-prod";
const ref = (project: string, location: string, id: string, version = "") =>
  `projects/${project}/locations/${location}/secrets/${id}${version}`;

describe("secretRefProblem (L3)", () => {
  it.each([
    [
      "this organisation's secret",
      ref(PROJECT, "europe-west2", `harbour_int_${TENANT}_smtp`),
      null,
    ],
    [
      "with a version",
      ref(PROJECT, "europe-west2", `harbour_int_${TENANT}_payroll-key`, "/versions/3"),
      null,
    ],
    [
      "with the latest version",
      ref(PROJECT, "europe-west2", `harbour_int_${TENANT}_smtp`, "/versions/latest"),
      null,
    ],
    [
      "another organisation's secret",
      ref(PROJECT, "europe-west2", `harbour_int_${OTHER}_smtp`),
      "own prefix",
    ],
    ["an SSO key", ref(PROJECT, "europe-west2", `harbour_sso_${TENANT}_okta`), "harbour_int_"],
    ["a platform secret", ref(PROJECT, "europe-west2", "better-auth-secret"), "harbour_int_"],
    [
      "another project's secret",
      ref("harbour-other", "europe-west2", `harbour_int_${TENANT}_smtp`),
      "project",
    ],
    [
      "a secret in another region",
      ref(PROJECT, "europe-west1", `harbour_int_${TENANT}_smtp`),
      "europe-west2",
    ],
    [
      "a name trying to reach past its prefix",
      ref(PROJECT, "europe-west2", `harbour_int_${TENANT}_smtp_${OTHER}`),
      "harbour_int_",
    ],
    ["an AWS secret", "arn:aws:secretsmanager:eu-west-2:111122223333:secret:x", "harbour_int_"],
  ])("%s", (_label, value, expected) => {
    const problem = secretRefProblem(value, { projectId: PROJECT, tenantId: TENANT });
    if (expected === null) expect(problem).toBeNull();
    else expect(problem).toContain(expected);
  });

  it("refuses every secret where the environment names no project", () => {
    expect(
      secretRefProblem(ref(PROJECT, "europe-west2", `harbour_int_${TENANT}_smtp`), {
        projectId: undefined,
        tenantId: TENANT,
      }),
    ).toContain("project");
  });

  it("never repeats the secret's name in what it says", () => {
    const value = ref(PROJECT, "europe-west2", `harbour_int_${OTHER}_smtp`);
    expect(secretRefProblem(value, { projectId: PROJECT, tenantId: TENANT })).not.toContain(OTHER);
  });
});

describe("senderAllowed (L2)", () => {
  const DOMAINS = ["harbour.example.invalid", "carehome.example.invalid"];
  it.each([
    ["an allowed domain", "alerts@harbour.example.invalid", true],
    ["a name and an allowed address", "Harbour <alerts@carehome.example.invalid>", true],
    ["upper case", "Alerts@HARBOUR.Example.Invalid", true],
    ["a domain not listed", "alerts@elsewhere.example.invalid", false],
    ["a subdomain of a listed domain", "alerts@mail.harbour.example.invalid", false],
    ["a look-alike ending", "alerts@evilharbour.example.invalid", false],
    ["two addresses", "a@harbour.example.invalid, b@elsewhere.example.invalid", false],
    ["a display name naming an allowed domain", "harbour.example.invalid <a@evil.example>", false],
    ["empty", "", false],
  ])("%s", (_label, from, allowed) => {
    expect(senderAllowed(from, DOMAINS)).toBe(allowed);
  });

  it("allows nothing when no domains are configured", () => {
    expect(senderAllowed("alerts@harbour.example.invalid", [])).toBe(false);
  });
});
