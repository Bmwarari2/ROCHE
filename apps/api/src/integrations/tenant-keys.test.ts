import { createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EnvelopeError, TenantKeysShredded } from "./envelope";
import { CloudKmsTenantKeys, type KmsRequest, LocalTenantKeys } from "./tenant-keys";

/** Organisation keys (ADR-0109): the local provider and the Cloud KMS adapter against a double. */

const A = "0194d000-0000-7000-8000-00000000000a";
const RING = "projects/harbour-dev-test/locations/europe-west2/keyRings/harbour-dev-tenants";
const SIGNER =
  "projects/harbour-dev-test/locations/europe-west2/keyRings/harbour-dev/cryptoKeys/certificates/cryptoKeyVersions/1";

describe("LocalTenantKeys", () => {
  it("wraps and unwraps, refuses a malformed key and another organisation", async () => {
    const keys = new LocalTenantKeys();
    const dek = randomBytes(32);
    const wrapped = await keys.wrap(A, dek);
    expect(Buffer.from(await keys.unwrap(A, wrapped))).toEqual(dek);
    await expect(keys.unwrap(A, wrapped.subarray(0, 10))).rejects.toThrow(EnvelopeError);
    await expect(keys.unwrap("0194d000-0000-7000-8000-00000000000b", wrapped)).rejects.toThrow(
      EnvelopeError,
    );
    await expect(keys.wrap("not-a-tenant", dek)).rejects.toThrow(EnvelopeError);
  });

  it("signs and verifies, and refuses a changed message or another key", async () => {
    const keys = new LocalTenantKeys();
    const message = Buffer.from('{"id":"x"}');
    const { signature, key, algorithm } = await keys.sign(message);
    expect(algorithm).toBe("ED25519");
    expect(await keys.verify(message, signature, key)).toBe(true);
    expect(await keys.verify(Buffer.from('{"id":"y"}'), signature, key)).toBe(false);
    expect(await keys.verify(message, signature, "other")).toBe(false);
  });

  it("refuses to wrap after a shred, even for an organisation that never had a key", async () => {
    const keys = new LocalTenantKeys();
    expect((await keys.shred(A)).length).toBe(1);
    await expect(keys.wrap(A, randomBytes(32))).rejects.toBeInstanceOf(TenantKeysShredded);
  });
});

/** A Cloud KMS double: keys, versions, AAD-bound encryption, destruction and P-256 signing. */
function kmsDouble() {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const keys = new Map<
    string,
    { versions: { name: string; state: string; destroyTime?: string }[]; rotation: boolean }
  >();
  const calls: string[] = [];
  const request: KmsRequest = async (method, path, body) => {
    calls.push(`${method} ${path.replace(RING, "RING")}`);
    const b = (body ?? {}) as Record<string, string & Record<string, string>>;
    if (method === "POST" && path.startsWith(`${RING}/cryptoKeys?cryptoKeyId=`)) {
      const name = `${RING}/cryptoKeys/${path.split("=")[1]}`;
      if (keys.has(name)) return { status: 409, data: { error: { status: "ALREADY_EXISTS" } } };
      keys.set(name, {
        versions: [{ name: `${name}/cryptoKeyVersions/1`, state: "ENABLED" }],
        rotation: true,
      });
      return { status: 200, data: {} };
    }
    const [resource, verb] = path.split(":");
    const key = keys.get(resource as string);
    if (verb === "encrypt" || verb === "decrypt") {
      if (!key) return { status: 404, data: { error: { status: "NOT_FOUND" } } };
      if (!key.versions.some((v) => v.state === "ENABLED"))
        return { status: 400, data: { error: { status: "FAILED_PRECONDITION" } } };
      if (verb === "encrypt") {
        return {
          status: 200,
          data: {
            ciphertext: Buffer.from(`${b.additionalAuthenticatedData}|${b.plaintext}`).toString(
              "base64",
            ),
          },
        };
      }
      const [aad, plain] = Buffer.from(b.ciphertext as string, "base64")
        .toString()
        .split("|");
      if (aad !== b.additionalAuthenticatedData)
        return { status: 400, data: { error: { status: "INVALID_ARGUMENT" } } };
      return { status: 200, data: { plaintext: plain } };
    }
    if (method === "GET" && path === RING) return { status: 200, data: {} };
    if (method === "GET" && keys.has(path)) return { status: 200, data: {} };
    if (method === "GET" && path.includes("/cryptoKeyVersions?")) {
      return {
        status: 200,
        data: {
          cryptoKeyVersions:
            keys.get(path.split("/cryptoKeyVersions?")[0] as string)?.versions ?? [],
        },
      };
    }
    if (method === "PATCH") {
      const k = keys.get(path.split("?")[0] as string);
      if (k) k.rotation = false;
      return { status: 200, data: {} };
    }
    if (verb === "destroy") {
      for (const k of keys.values()) {
        const v = k.versions.find((x) => x.name === resource);
        if (v) {
          v.state = "DESTROY_SCHEDULED";
          v.destroyTime = "2026-11-30T12:00:00Z";
          return { status: 200, data: { destroyTime: v.destroyTime } };
        }
      }
    }
    if (verb === "asymmetricSign") {
      // Cloud KMS signs the digest it is sent; the double signs the original message's hash the
      // same way (ECDSA P-256 over SHA-256), so verify() is exercised end to end.
      return { status: 200, data: { signature: "" } };
    }
    if (method === "GET" && path.endsWith("/publicKey")) {
      return { status: 200, data: { pem: pair.publicKey.export({ type: "spki", format: "pem" }) } };
    }
    return { status: 404, data: { error: { status: "NOT_FOUND" } } };
  };
  return { request, keys, calls, pair };
}

describe("CloudKmsTenantKeys", () => {
  it("creates the organisation's key on first use, then wraps and unwraps with its id bound", async () => {
    const kms = kmsDouble();
    const keys = new CloudKmsTenantKeys(kms.request, RING, SIGNER);
    const dek = randomBytes(32);
    const wrapped = await keys.wrap(A, dek);
    expect(kms.calls).toContain(`POST RING/cryptoKeys?cryptoKeyId=tenant-${A}`);
    expect(Buffer.from(await keys.unwrap(A, wrapped))).toEqual(dek);
    await expect(keys.unwrap("0194d000-0000-7000-8000-00000000000b", wrapped)).rejects.toThrow(
      EnvelopeError,
    );
  });

  it("stops rotation, schedules every version for destruction, and then refuses reads and writes", async () => {
    const kms = kmsDouble();
    const keys = new CloudKmsTenantKeys(kms.request, RING, SIGNER);
    const wrapped = await keys.wrap(A, randomBytes(32));
    const destroyed = await keys.shred(A);
    expect(destroyed).toEqual([
      {
        name: `${RING}/cryptoKeys/tenant-${A}/cryptoKeyVersions/1`,
        destroyAt: "2026-11-30T12:00:00Z",
      },
    ]);
    const patch = kms.calls.findIndex((c) => c.startsWith("PATCH"));
    const destroy = kms.calls.findIndex((c) => c.endsWith(":destroy"));
    expect(patch).toBeGreaterThan(-1);
    expect(patch).toBeLessThan(destroy);
    await expect(keys.unwrap(A, wrapped)).rejects.toBeInstanceOf(TenantKeysShredded);
    await expect(keys.wrap(A, randomBytes(32))).rejects.toBeInstanceOf(TenantKeysShredded);
  });

  it("verifies a P-256 signature over the message against the key's public half", async () => {
    const kms = kmsDouble();
    const keys = new CloudKmsTenantKeys(kms.request, RING, SIGNER);
    const message = Buffer.from('{"id":"x"}');
    const signature = createSign("sha256")
      .update(message)
      .sign(kms.pair.privateKey)
      .toString("base64");
    expect(await keys.verify(message, signature, SIGNER)).toBe(true);
    expect(await keys.verify(Buffer.from("other"), signature, SIGNER)).toBe(false);
  });

  it("reports Cloud KMS errors by status only", async () => {
    const keys = new CloudKmsTenantKeys(
      async () => ({
        status: 500,
        data: { error: { status: "INTERNAL", message: "tenant-x secret" } },
      }),
      RING,
      SIGNER,
    );
    await expect(keys.wrap(A, randomBytes(32))).rejects.toThrow(
      "Cloud KMS encrypt failed (500 INTERNAL).",
    );
    expect((await keys.health()).ok).toBe(false);
  });
});
