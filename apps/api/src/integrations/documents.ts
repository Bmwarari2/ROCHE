import type { DocumentStoragePort, MalwareScanPort, MalwareVerdict } from "@harbour/domain";
import type { Config } from "../config";
import {
  ClamdScanner,
  GcsDocumentStorage,
  LocalDocumentStorage,
  MockMalwareScanner,
} from "./storage";

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
} {
  const storage =
    gcs(config, config.GCS_DOCUMENTS_BUCKET) ??
    new LocalDocumentStorage(config.LOCAL_DOCUMENTS_DIR);
  const scanner =
    config.MALWARE_SCANNER === "clamd"
      ? new ClamdScanner(config.CLAMD_HOST, config.CLAMD_PORT)
      : config.MALWARE_SCANNER === "mock"
        ? new MockMalwareScanner()
        : new NoScanner();
  return { storage, exportStorage: createExportStorage(config), scanner };
}

/** The full export's archives: the exports bucket in Google Cloud, never the documents bucket. */
export function createExportStorage(config: Config): DocumentStoragePort {
  return (
    gcs(config, config.GCS_EXPORTS_BUCKET) ?? new LocalDocumentStorage(config.LOCAL_EXPORTS_DIR)
  );
}

/**
 * A Cloud Storage bucket when `DOCUMENT_STORAGE` is `gcs`, local disk otherwise. Asked for Cloud
 * Storage without the project, the bucket or the key, it throws, in every environment: falling back
 * to local disk would keep documents somewhere nobody chose (#164 security review, L4).
 */
function gcs(config: Config, bucket: string | undefined): DocumentStoragePort | null {
  if (config.DOCUMENT_STORAGE !== "gcs") return null;
  if (!bucket || !config.GCP_PROJECT_ID || !config.GCS_KMS_KEY) {
    throw new Error(
      "DOCUMENT_STORAGE is gcs but GCP_PROJECT_ID, the bucket or GCS_KMS_KEY is not set",
    );
  }
  return GcsDocumentStorage.forBucket(config.GCP_PROJECT_ID, bucket, config.GCS_KMS_KEY);
}

/**
 * At production start (API and worker), both buckets must be what ADR-0098 says before anything is
 * stored: reachable, in europe-west2, encrypted by default with the configured key, and with soft
 * delete off, since soft-deleted copies would outlive `destroy()` and make destruction certificates
 * untrue (#164 security review, L1). Any other answer stops the process; the error names the bucket's
 * role and the problem, never a key or an object.
 */
export async function assertStorageReady(
  config: Config,
  stores: { readonly documents: DocumentStoragePort; readonly exports: DocumentStoragePort } = {
    documents: createDocumentServices(config).storage,
    exports: createExportStorage(config),
  },
): Promise<void> {
  if (config.NODE_ENV !== "production") return;
  for (const [role, store] of Object.entries(stores)) {
    const health = await store.health();
    if (!health.ok) {
      throw new Error(`The ${role} bucket is not ready for production: ${health.detail}`);
    }
  }
}
