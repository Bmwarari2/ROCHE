import type { DocumentStoragePort, MalwareScanPort, MalwareVerdict } from "@harbour/domain";
import type { Config } from "../config";
import {
  ClamdScanner,
  LocalDocumentStorage,
  MockMalwareScanner,
  S3DocumentStorage,
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
  scanner: MalwareScanPort;
} {
  const storage =
    config.DOCUMENT_STORAGE === "s3" && config.S3_DOCUMENTS_BUCKET
      ? new S3DocumentStorage(config.S3_DOCUMENTS_BUCKET)
      : new LocalDocumentStorage(config.LOCAL_DOCUMENTS_DIR);
  const scanner =
    config.MALWARE_SCANNER === "clamd"
      ? new ClamdScanner(config.CLAMD_HOST, config.CLAMD_PORT)
      : config.MALWARE_SCANNER === "mock"
        ? new MockMalwareScanner()
        : new NoScanner();
  return { storage, scanner };
}
