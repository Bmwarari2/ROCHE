import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { createSsoKeyStore, SecretManagerKeyStore, ssoSecretId } from "./sso";

/** Single sign-on keys in Secret Manager (ADR-0091, ADR-0098). Invented ids only. */
const TENANT = "0b5f2c1e-9d4a-4c7b-8e21-5a6f3d2b1c00";
const REF = `harbour/sso/${TENANT}/acme-care`;
const SECRET = `harbour_sso_${TENANT}_acme-care`;
const LATEST = `https://secretmanager.europe-west2.rep.googleapis.com/v1/projects/harbour-dev/locations/europe-west2/secrets/${SECRET}/versions/latest`;

function failure(status: number): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), { status });
}

/** A double for the authorised GET: records each URL and answers from the map. */
function store(answers: Record<string, unknown | Error>) {
  const urls: string[] = [];
  const keys = new SecretManagerKeyStore("harbour-dev", async (url) => {
    urls.push(url);
    const answer = answers[url];
    if (answer instanceof Error) throw answer;
    if (answer === undefined) throw failure(404);
    return answer;
  });
  return { keys, urls };
}

describe("single sign-on keys in Secret Manager", () => {
  it.each([
    ["a key under the organisation's prefix", REF, SECRET],
    ["a one-character name", `harbour/sso/${TENANT}/a`, `harbour_sso_${TENANT}_a`],
    ["another organisation's shape of name", "harbour/sso/acme-care", null],
    ["a name with an underscore", `harbour/sso/${TENANT}/acme_care`, null],
    ["a name with a slash", `harbour/sso/${TENANT}/acme/care`, null],
    ["an upper-case tenant id", `harbour/sso/${TENANT.toUpperCase()}/acme-care`, null],
    ["a key itself", "-----BEGIN PRIVATE KEY-----", null],
    ["a full secret name", `projects/harbour-dev/secrets/${SECRET}`, null],
  ])("maps %s to a secret id", (_label, ref, expected) => {
    expect(ssoSecretId(ref)).toBe(expected);
  });

  it("reads the latest version through the europe-west2 endpoint", async () => {
    const pem = "-----BEGIN PRIVATE KEY-----\ninvented\n-----END PRIVATE KEY-----\n";
    const { keys, urls } = store({
      [`${LATEST}:access`]: { payload: { data: Buffer.from(pem).toString("base64") } },
    });
    expect(await keys.get(REF)).toBe(pem);
    expect(urls).toEqual([`${LATEST}:access`]);
  });

  it("checks a key exists from its metadata, never by reading it (#33 review M3)", async () => {
    const { keys, urls } = store({ [LATEST]: { state: "ENABLED" } });
    expect(await keys.has(REF)).toBe(true);
    expect(urls).toEqual([LATEST]);
  });

  it.each([
    ["disabled", { state: "DISABLED" }],
    ["destroyed", { state: "DESTROYED" }],
    ["missing", failure(404)],
  ])("treats a %s latest version as no key", async (_label, answer) => {
    const { keys } = store({ [LATEST]: answer });
    expect(await keys.has(REF)).toBe(false);
  });

  it("reads a missing secret as no key", async () => {
    const { keys } = store({});
    expect(await keys.get(REF)).toBeNull();
  });

  it("never looks up a name outside the organisation's prefix", async () => {
    const { keys, urls } = store({});
    expect(await keys.has("harbour/sso/acme-care")).toBe(false);
    expect(await keys.get("harbour/sso/acme-care")).toBeNull();
    expect(urls).toEqual([]);
  });

  it("counts a key it may not read as missing, but fails a sign-in that cannot read it", async () => {
    const { keys } = store({ [LATEST]: failure(403), [`${LATEST}:access`]: failure(403) });
    expect(await keys.has(REF)).toBe(false);
    await expect(keys.get(REF)).rejects.toThrow("403");
  });

  it("fails rather than guessing when Secret Manager is unavailable", async () => {
    const { keys } = store({ [LATEST]: failure(503) });
    await expect(keys.has(REF)).rejects.toThrow("503");
  });

  it("needs the project to use Secret Manager", () => {
    expect(() => createSsoKeyStore(loadConfig({ SSO_KEY_STORE: "gcp" }))).toThrow("GCP_PROJECT_ID");
    expect(
      createSsoKeyStore(loadConfig({ SSO_KEY_STORE: "gcp", GCP_PROJECT_ID: "harbour-dev" })),
    ).toBeInstanceOf(SecretManagerKeyStore);
  });
});
