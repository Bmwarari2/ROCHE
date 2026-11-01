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

/** A Cloud Storage bucket when configured (production refuses to start without one). */
function gcs(config: Config, bucket: string | undefined): DocumentStoragePort | null {
  if (config.DOCUMENT_STORAGE !== "gcs" || !bucket || !config.GCP_PROJECT_ID || !config.GCS_KMS_KEY)
    return null;
  return GcsDocumentStorage.forBucket(config.GCP_PROJECT_ID, bucket, config.GCS_KMS_KEY);
}
