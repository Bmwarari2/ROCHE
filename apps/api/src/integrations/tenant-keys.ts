import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign as signWith,
  verify as verifyWith,
} from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HealthResult, TenantKeyPort } from "@harbour/domain";
import { EnvelopeError, TenantKeysShredded } from "./envelope";

/**
 * Organisation keys (ADR-0109): Cloud KMS in production, a local provider in development and
 * tests. Both wrap per-object data keys with the organisation id as authenticated data, refuse
 * every wrap and unwrap once the organisation is shredded, and sign destruction certificates.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function assertTenant(tenantId: string): void {
  if (!UUID.test(tenantId)) throw new EnvelopeError("Not an organisation id.");
}

const tenantAad = (tenantId: string) => Buffer.from(`harbour:tenant:${tenantId}`, "utf8");

// ---------------------------------------------------------------------------------------------
// Local provider
// ---------------------------------------------------------------------------------------------

interface LocalVersion {
  readonly id: number;
  /** base64; null once destroyed. */
  key: string | null;
  state: "enabled" | "destroy_scheduled" | "destroyed";
  destroyAt: string | null;
}

interface LocalTenantState {
  versions: LocalVersion[];
  /** Shredded: no new version is ever created, so nothing can be written again. */
  shredded: boolean;
}

/**
 * Keys in files under a directory (development: shared by the API and the worker), or in memory
 * when no directory is given (tests). Shredding destroys the key material at once unless a delay is
 * set. Refused in production by the configuration.
 */
export class LocalTenantKeys implements TenantKeyPort {
  readonly provider = "local";
  private readonly memory = new Map<string, LocalTenantState>();
  private signing: { privateKey: KeyObject; publicKey: KeyObject } | null = null;

  constructor(
    private readonly options: {
      readonly dir?: string;
      readonly destroyDelayMs?: number;
      readonly now?: () => Date;
    } = {},
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private file(tenantId: string): string {
    const dir = resolve(this.options.dir ?? ".");
    return join(dir, `${tenantId}.json`);
  }

  private load(tenantId: string): LocalTenantState | null {
    assertTenant(tenantId);
    if (!this.options.dir) return this.memory.get(tenantId) ?? null;
    try {
      return JSON.parse(readFileSync(this.file(tenantId), "utf8")) as LocalTenantState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private save(tenantId: string, state: LocalTenantState): void {
    if (!this.options.dir) {
      this.memory.set(tenantId, state);
      return;
    }
    mkdirSync(resolve(this.options.dir), { recursive: true, mode: 0o700 });
    const path = this.file(tenantId);
    writeFileSync(`${path}.tmp`, JSON.stringify(state), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }

  /** Destroys scheduled versions whose delay has passed. */
  private settle(state: LocalTenantState): boolean {
    let changed = false;
    for (const v of state.versions) {
      if (v.state === "destroy_scheduled" && v.destroyAt && new Date(v.destroyAt) <= this.now()) {
        v.state = "destroyed";
        v.key = null;
        changed = true;
      }
    }
    return changed;
  }

  private stateFor(tenantId: string, create: boolean): LocalTenantState | null {
    let state = this.load(tenantId);
    if (!state && create) {
      state = {
        versions: [
          { id: 1, key: randomBytes(32).toString("base64"), state: "enabled", destroyAt: null },
        ],
        shredded: false,
      };
      this.save(tenantId, state);
    }
    if (state && this.settle(state)) this.save(tenantId, state);
    return state;
  }

  async wrap(tenantId: string, dataKey: Uint8Array): Promise<Uint8Array> {
    const state = this.stateFor(tenantId, true);
    const primary = state?.versions.at(-1);
    if (!state || state.shredded || !primary || primary.state !== "enabled" || !primary.key) {
      throw new TenantKeysShredded();
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(primary.key, "base64"), iv);
    cipher.setAAD(tenantAad(tenantId));
    const body = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    const version = Buffer.alloc(4);
    version.writeUInt32BE(primary.id, 0);
    return new Uint8Array(Buffer.concat([version, iv, body, cipher.getAuthTag()]));
  }

  async unwrap(tenantId: string, wrapped: Uint8Array): Promise<Uint8Array> {
    const state = this.stateFor(tenantId, false);
    const bytes = Buffer.from(wrapped);
    if (bytes.length < 4 + 12 + 16) throw new EnvelopeError("The wrapped key is malformed.");
    const version = state?.versions.find((v) => v.id === bytes.readUInt32BE(0));
    if (!state || !version) throw new EnvelopeError("The wrapped key is not this organisation's.");
    if (state.shredded || version.state !== "enabled" || !version.key)
      throw new TenantKeysShredded();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(version.key, "base64"),
      bytes.subarray(4, 16),
    );
    decipher.setAAD(tenantAad(tenantId));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    try {
      return new Uint8Array(
        Buffer.concat([decipher.update(bytes.subarray(16, bytes.length - 16)), decipher.final()]),
      );
    } catch {
      throw new EnvelopeError("The wrapped key is not this organisation's.");
    }
  }

  async shred(tenantId: string) {
    const state = this.stateFor(tenantId, true) as LocalTenantState;
    const delay = this.options.destroyDelayMs ?? 0;
    const destroyAt = new Date(this.now().getTime() + delay).toISOString();
    for (const v of state.versions) {
      if (v.state === "enabled") {
        v.state = "destroy_scheduled";
        v.destroyAt = destroyAt;
      }
    }
    state.shredded = true;
    this.settle(state);
    this.save(tenantId, state);
    return state.versions.map((v) => ({
      name: `local/tenants/${tenantId}/versions/${v.id}`,
      destroyAt: v.destroyAt ?? destroyAt,
    }));
  }

  private signingKey() {
    if (this.signing) return this.signing;
    const path = this.options.dir
      ? join(resolve(this.options.dir), "certificate-signing.pem")
      : null;
    if (path) {
      try {
        const privateKey = createPrivateKey(readFileSync(path, "utf8"));
        this.signing = { privateKey, publicKey: createPublicKey(privateKey) };
        return this.signing;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const pair = generateKeyPairSync("ed25519");
    if (path) {
      mkdirSync(resolve(this.options.dir as string), { recursive: true, mode: 0o700 });
      writeFileSync(path, pair.privateKey.export({ type: "pkcs8", format: "pem" }), {
        mode: 0o600,
      });
    }
    this.signing = pair;
    return pair;
  }

  async sign(message: Uint8Array) {
    const signature = signWith(null, message, this.signingKey().privateKey).toString("base64");
    return { signature, key: "local/certificate-signing/1", algorithm: "ED25519" };
  }

  async verify(message: Uint8Array, signature: string, key: string): Promise<boolean> {
    if (key !== "local/certificate-signing/1") return false;
    return verifyWith(null, message, this.signingKey().publicKey, Buffer.from(signature, "base64"));
  }

  async health(): Promise<HealthResult> {
    return { ok: true, detail: this.options.dir ? "local files" : "in memory" };
  }
}

// ---------------------------------------------------------------------------------------------
// Cloud KMS
// ---------------------------------------------------------------------------------------------

/** One Cloud KMS REST call: the adapter's only dependency, replaced by a double in tests. */
export type KmsRequest = (
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
) => Promise<{ readonly status: number; readonly data: Record<string, unknown> }>;

const KMS_BASE = "https://cloudkms.googleapis.com/v1/";

/** A request function signed with the runtime's own identity (Cloud Run's service account). */
export async function googleKmsRequest(): Promise<KmsRequest> {
  const { GoogleAuth } = await import("google-auth-library");
  const client = await new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloudkms"],
  }).getClient();
  return async (method, path, body) => {
    const response = await client.request<Record<string, unknown>>({
      url: `${KMS_BASE}${path}`,
      method,
      ...(body === undefined ? {} : { data: body }),
      validateStatus: () => true,
    });
    return { status: response.status, data: (response.data ?? {}) as Record<string, unknown> };
  };
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** Status text of a Google API error, never its message (which may name the resource). */
function statusOf(data: Record<string, unknown>): string {
  const error = data.error as { status?: unknown } | undefined;
  return typeof error?.status === "string" ? error.status : "UNKNOWN";
}

export class KmsError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(`Cloud KMS ${operation} failed (${status} ${code}).`);
    this.name = "KmsError";
  }
}

/**
 * Cloud KMS in europe-west2 (ADR-0109): one key per organisation, `tenant-<id>`, in the tenants
 * key ring, created on first use (90-day rotation, 30-day scheduled destruction); certificates are
 * signed with an asymmetric P-256 key whose private half never leaves Cloud KMS.
 */
export class CloudKmsTenantKeys implements TenantKeyPort {
  readonly provider = "cloudkms";
  private publicKeys = new Map<string, KeyObject>();

  constructor(
    private readonly request: KmsRequest,
    private readonly keyRing: string,
    private readonly signingKeyVersion: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private keyName(tenantId: string): string {
    assertTenant(tenantId);
    return `${this.keyRing}/cryptoKeys/tenant-${tenantId}`;
  }

  private async createKey(tenantId: string): Promise<void> {
    const next = new Date(this.now().getTime() + 90 * 86_400_000).toISOString();
    const res = await this.request(
      "POST",
      `${this.keyRing}/cryptoKeys?cryptoKeyId=tenant-${tenantId}`,
      {
        purpose: "ENCRYPT_DECRYPT",
        versionTemplate: { algorithm: "GOOGLE_SYMMETRIC_ENCRYPTION", protectionLevel: "SOFTWARE" },
        rotationPeriod: "7776000s",
        nextRotationTime: next,
        destroyScheduledDuration: "2592000s",
        labels: { purpose: "tenant-data" },
      },
    );
    // 409: created meanwhile by another instance.
    if (res.status !== 200 && res.status !== 409) {
      throw new KmsError("create key", res.status, statusOf(res.data));
    }
  }

  async wrap(tenantId: string, dataKey: Uint8Array): Promise<Uint8Array> {
    const name = this.keyName(tenantId);
    const body = { plaintext: b64(dataKey), additionalAuthenticatedData: b64(tenantAad(tenantId)) };
    let res = await this.request("POST", `${name}:encrypt`, body);
    if (res.status === 404) {
      await this.createKey(tenantId);
      res = await this.request("POST", `${name}:encrypt`, body);
    }
    // No enabled primary version: every version is scheduled for destruction or destroyed.
    if (res.status === 400 && statusOf(res.data) === "FAILED_PRECONDITION")
      throw new TenantKeysShredded();
    if (res.status !== 200 || typeof res.data.ciphertext !== "string") {
      throw new KmsError("encrypt", res.status, statusOf(res.data));
    }
    return new Uint8Array(Buffer.from(res.data.ciphertext, "base64"));
  }

  async unwrap(tenantId: string, wrapped: Uint8Array): Promise<Uint8Array> {
    const res = await this.request("POST", `${this.keyName(tenantId)}:decrypt`, {
      ciphertext: b64(wrapped),
      additionalAuthenticatedData: b64(tenantAad(tenantId)),
    });
    if (res.status === 400 && statusOf(res.data) === "FAILED_PRECONDITION")
      throw new TenantKeysShredded();
    if (res.status === 400 || res.status === 404)
      throw new EnvelopeError("The wrapped key is not this organisation's.");
    if (res.status !== 200 || typeof res.data.plaintext !== "string") {
      throw new KmsError("decrypt", res.status, statusOf(res.data));
    }
    return new Uint8Array(Buffer.from(res.data.plaintext, "base64"));
  }

  /**
   * Stops rotation (so no new version can appear), then schedules every version for destruction.
   * A key that does not exist yet is created first and destroyed, so nothing can be written later.
   */
  async shred(tenantId: string) {
    const name = this.keyName(tenantId);
    let res = await this.request("GET", name);
    if (res.status === 404) {
      await this.createKey(tenantId);
      res = await this.request("GET", name);
    }
    if (res.status !== 200) throw new KmsError("get key", res.status, statusOf(res.data));
    const stop = await this.request(
      "PATCH",
      `${name}?updateMask=rotationPeriod,nextRotationTime`,
      {},
    );
    if (stop.status !== 200) throw new KmsError("stop rotation", stop.status, statusOf(stop.data));
    const versions: { name: string; state: string; destroyTime?: string }[] = [];
    let page: string | undefined;
    do {
      const list = await this.request(
        "GET",
        `${name}/cryptoKeyVersions?pageSize=1000${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`,
      );
      if (list.status !== 200)
        throw new KmsError("list versions", list.status, statusOf(list.data));
      versions.push(...((list.data.cryptoKeyVersions as typeof versions | undefined) ?? []));
      page = typeof list.data.nextPageToken === "string" ? list.data.nextPageToken : undefined;
    } while (page);
    const out: { name: string; destroyAt: string }[] = [];
    for (const v of versions) {
      if (v.state === "DESTROYED" || v.state === "DESTROY_SCHEDULED") {
        out.push({ name: v.name, destroyAt: v.destroyTime ?? this.now().toISOString() });
        continue;
      }
      const destroyed = await this.request("POST", `${v.name}:destroy`, {});
      if (destroyed.status !== 200 || typeof destroyed.data.destroyTime !== "string") {
        throw new KmsError("destroy version", destroyed.status, statusOf(destroyed.data));
      }
      out.push({ name: v.name, destroyAt: destroyed.data.destroyTime });
    }
    return out;
  }

  /** Cloud KMS signs the message's SHA-256 digest (ECDSA P-256, DER-encoded signature). */
  async sign(message: Uint8Array) {
    const digest = createHash("sha256").update(message).digest();
    const res = await this.request("POST", `${this.signingKeyVersion}:asymmetricSign`, {
      digest: { sha256: b64(digest) },
    });
    if (res.status !== 200 || typeof res.data.signature !== "string") {
      throw new KmsError("sign", res.status, statusOf(res.data));
    }
    return {
      signature: res.data.signature,
      key: this.signingKeyVersion,
      algorithm: "EC_SIGN_P256_SHA256",
    };
  }

  async verify(message: Uint8Array, signature: string, key: string): Promise<boolean> {
    let publicKey = this.publicKeys.get(key);
    if (!publicKey) {
      const res = await this.request("GET", `${key}/publicKey`);
      if (res.status !== 200 || typeof res.data.pem !== "string") return false;
      publicKey = createPublicKey(res.data.pem);
      this.publicKeys.set(key, publicKey);
    }
    return verifyWith("sha256", message, publicKey, Buffer.from(signature, "base64"));
  }

  async health(): Promise<HealthResult> {
    const res = await this.request("GET", this.keyRing);
    return res.status === 200
      ? { ok: true, detail: "Cloud KMS reachable" }
      : { ok: false, detail: `Cloud KMS ${res.status} ${statusOf(res.data)}` };
  }
}
