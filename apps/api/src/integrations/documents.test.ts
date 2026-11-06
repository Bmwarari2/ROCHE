import type { DocumentStoragePort, HealthResult } from "@harbour/domain";
import { describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../config";
import { assertStorageReady, createDocumentServices, createExportStorage } from "./documents";
import { GcsDocumentStorage, LocalDocumentStorage } from "./storage";

/**
 * #164 security review: production checks both buckets before it starts (L1), and Cloud Storage
 * asked for without what it needs never falls back to local disk (L4). No cloud is called: the
 * stores are doubles, and building a Cloud Storage client makes no request.
 */

const KEY = "projects/harbour-dev/locations/europe-west2/keyRings/harbour/cryptoKeys/storage";

function store(health: HealthResult): DocumentStoragePort {
  return { health: async () => health } as unknown as DocumentStoragePort;
}

const production = { ...loadConfig({ NODE_ENV: "test" }), NODE_ENV: "production" } as Config;

describe("assertStorageReady (L1)", () => {
  it("starts when both buckets are ready", async () => {
    await expect(
      assertStorageReady(production, {
        documents: store({ ok: true, detail: "bucket reachable" }),
        exports: store({ ok: true, detail: "bucket reachable" }),
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["outside europe-west2", "bucket outside europe-west2"],
    ["the wrong default key", "bucket default key is not the configured key"],
    ["soft delete on", "bucket keeps soft-deleted objects"],
    ["unreachable", "unreachable (403)"],
  ])(
    "refuses to start with the exports bucket %s, saying which bucket and why",
    async (_l, detail) => {
      await expect(
        assertStorageReady(production, {
          documents: store({ ok: true, detail: "bucket reachable" }),
          exports: store({ ok: false, detail }),
        }),
      ).rejects.toThrow(`The exports bucket is not ready for production: ${detail}`);
    },
  );

  it("refuses to start when the documents bucket is not ready", async () => {
    await expect(
      assertStorageReady(production, {
        documents: store({ ok: false, detail: "bucket keeps soft-deleted objects" }),
        exports: store({ ok: true, detail: "bucket reachable" }),
      }),
    ).rejects.toThrow("The documents bucket");
  });

  it("does not check outside production", async () => {
    await expect(
      assertStorageReady(loadConfig({ NODE_ENV: "test" }), {
        documents: store({ ok: false, detail: "unreachable" }),
        exports: store({ ok: false, detail: "unreachable" }),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("Cloud Storage never falls back to local disk (L4)", () => {
  const gcs = { NODE_ENV: "development", DOCUMENT_STORAGE: "gcs" } as const;
  it.each([
    [
      "no project",
      {
        GCS_DOCUMENTS_BUCKET: "harbour-docs",
        GCS_EXPORTS_BUCKET: "harbour-exports",
        GCS_KMS_KEY: KEY,
      },
    ],
    [
      "no key",
      {
        GCP_PROJECT_ID: "harbour-dev",
        GCS_DOCUMENTS_BUCKET: "harbour-docs",
        GCS_EXPORTS_BUCKET: "harbour-exports",
      },
    ],
    [
      "no documents bucket",
      { GCP_PROJECT_ID: "harbour-dev", GCS_EXPORTS_BUCKET: "harbour-exports", GCS_KMS_KEY: KEY },
    ],
  ])("throws with %s", (_label, env) => {
    const config = loadConfig({ ...gcs, ...env });
    expect(() => createDocumentServices(config)).toThrow("DOCUMENT_STORAGE is gcs");
  });

  it("throws for the exports bucket too", () => {
    const config = loadConfig({
      ...gcs,
      GCP_PROJECT_ID: "harbour-dev",
      GCS_DOCUMENTS_BUCKET: "harbour-docs",
      GCS_KMS_KEY: KEY,
    });
    expect(() => createExportStorage(config)).toThrow("DOCUMENT_STORAGE is gcs");
  });

  it("uses Cloud Storage when everything is set, and local disk only when asked for", () => {
    const configured = loadConfig({
      ...gcs,
      GCP_PROJECT_ID: "harbour-dev",
      GCS_DOCUMENTS_BUCKET: "harbour-docs",
      GCS_EXPORTS_BUCKET: "harbour-exports",
      GCS_KMS_KEY: KEY,
    });
    expect(createDocumentServices(configured).storage).toBeInstanceOf(GcsDocumentStorage);
    expect(createExportStorage(configured)).toBeInstanceOf(GcsDocumentStorage);
    const local = loadConfig({ NODE_ENV: "development" });
    expect(createDocumentServices(local).storage).toBeInstanceOf(LocalDocumentStorage);
  });
});
