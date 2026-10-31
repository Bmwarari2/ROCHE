import type {
  DocumentStoragePort,
  MalwareScanPort,
  MalwareVerdict,
  TenantKeyPort,
} from "@harbour/domain";
import type { Config } from "../config";
import { DataKeyCache, EncryptingDocumentStorage } from "./envelope";
import {
  ClamdScanner,
  GcsDocumentStorage,
  LocalDocumentStorage,
  MockMalwareScanner,
} from "./storage";
import { CloudKmsTenantKeys, googleKmsRequest, LocalTenantKeys } from "./tenant-keys";

/** Scanner used when none is configured: every upload stays quarantined (fail safe). */
class NoScanner implements MalwareScanPort {
  readonly provider = "none";
  async scan(): Promise<MalwareVerdict> {
    return "unavailable";
  }
}

export function createDocumentServices(config: Config): {
  storage: DocumentStoragePort;
  exportStorage: DocumentStoragePort;
  scanner: MalwareScanPort;
  tenantKeys: TenantKeyPort;
  dataKeyCache: DataKeyCache;
} {
  const { keys, cache } = tenantKeysFor(config);
  const storage = encrypted(
    config,
    gcs(config, config.GCS_DOCUMENTS_BUCKET) ??
      new LocalDocumentStorage(config.LOCAL_DOCUMENTS_DIR),
  );
  const scanner =
    config.MALWARE_SCANNER === "clamd"
      ? new ClamdScanner(config.CLAMD_HOST, config.CLAMD_PORT)
      : config.MALWARE_SCANNER === "mock"
        ? new MockMalwareScanner()
        : new NoScanner();
  return {
    storage,
    exportStorage: createExportStorage(config),
    scanner,
    tenantKeys: keys,
    dataKeyCache: cache,
  };
}

/** The full export's archives: the exports bucket in Google Cloud, never the documents bucket. */
export function createExportStorage(config: Config): DocumentStoragePort {
  return encrypted(
    config,
    gcs(config, config.GCS_EXPORTS_BUCKET) ?? new LocalDocumentStorage(config.LOCAL_EXPORTS_DIR),
  );
}

/**
 * One key provider and one data key cache per configuration, shared by every store in this
 * process. Other processes (other API instances, the worker) have their own caches, which keep a
 * key for at most `DATA_KEY_CACHE_MS` after a shred (platform.md rule 4).
 */
const providers = new WeakMap<Config, { keys: TenantKeyPort; cache: DataKeyCache }>();

export function tenantKeysFor(config: Config): { keys: TenantKeyPort; cache: DataKeyCache } {
  const known = providers.get(config);
  if (known) return known;
  let keys: TenantKeyPort;
  if (config.TENANT_KEY_PROVIDER === "cloudkms") {
    // Never a silent fall back to local keys (security review, L4).
    if (!config.TENANT_KMS_KEY_RING || !config.CERTIFICATE_SIGNING_KEY) {
      throw new Error("TENANT_KMS_KEY_RING and CERTIFICATE_SIGNING_KEY are needed for cloudkms");
    }
    keys = new CloudKmsTenantKeys(
      lazyKms(),
      config.TENANT_KMS_KEY_RING,
      config.CERTIFICATE_SIGNING_KEY,
    );
  } else {
    const dir = config.LOCAL_KEYS_DIR ?? (config.NODE_ENV === "test" ? undefined : ".data/keys");
    keys = new LocalTenantKeys(dir ? { dir } : {});
  }
  const made = { keys, cache: new DataKeyCache() };
  providers.set(config, made);
  return made;
}

/** The Cloud KMS client is made on first use, so the API starts without a network call. */
function lazyKms() {
  let client: ReturnType<typeof googleKmsRequest> | null = null;
  return (...args: Parameters<Awaited<ReturnType<typeof googleKmsRequest>>>) => {
    client ??= googleKmsRequest();
    return client.then((request) => request(...args));
  };
}

/** Every store encrypts with the organisation's key; plain objects read only when switched on. */
function encrypted(config: Config, inner: DocumentStoragePort): DocumentStoragePort {
  const { keys, cache } = tenantKeysFor(config);
  return new EncryptingDocumentStorage(inner, keys, {
    legacyPlaintext: config.DOCUMENTS_LEGACY_PLAINTEXT === "on",
    cache,
  });
}

/** A Cloud Storage bucket when configured (production refuses to start without one). */
function gcs(config: Config, bucket: string | undefined): DocumentStoragePort | null {
  if (config.DOCUMENT_STORAGE !== "gcs" || !bucket || !config.GCP_PROJECT_ID || !config.GCS_KMS_KEY)
    return null;
  return GcsDocumentStorage.forBucket(config.GCP_PROJECT_ID, bucket, config.GCS_KMS_KEY);
}
