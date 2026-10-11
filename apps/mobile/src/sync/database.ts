/**
 * Opens the on-device database: PowerSync over op-sqlite built with SQLCipher (AES-256), keyed
 * with the per-install key. Demo data lives in a separate file with an all-local schema.
 */
import { isSQLCipher, open as openRawDatabase } from "@op-engineering/op-sqlite";
import type { AbstractPowerSyncDatabase } from "@powersync/common";
import { PowerSyncDatabase } from "@powersync/react-native";
import { AppSchema, DemoSchema } from "./schema";

export class EncryptionUnavailableError extends Error {
  constructor() {
    super(
      'This build cannot encrypt the local database, so it will not store care records. Rebuild with "op-sqlite": { "sqlcipher": true } in the package.json that op-sqlite reads.',
    );
    this.name = "EncryptionUnavailableError";
  }
}

/** Fails closed: care data is never written to an unencrypted SQLite file. */
export function assertEncryptionAvailable(): void {
  let available = false;
  try {
    available = isSQLCipher();
  } catch {
    available = false;
  }
  if (!available) throw new EncryptionUnavailableError();
}

export interface OpenDatabaseOptions {
  readonly filename: string;
  /** SQLCipher raw key, x'<64 hex>'. */
  readonly encryptionKey: string;
  readonly demo: boolean;
}

export async function openDatabase(
  options: OpenDatabaseOptions,
): Promise<AbstractPowerSyncDatabase> {
  assertEncryptionAvailable();
  const db = new PowerSyncDatabase({
    schema: options.demo ? DemoSchema : AppSchema,
    database: {
      dbFilename: options.filename,
      sqliteOptions: { encryptionKey: options.encryptionKey },
    },
  });
  // Surfaces a wrong key ("file is not a database") here rather than on the first query.
  await db.init();
  await db.execute("SELECT count(*) FROM sqlite_master");
  return db;
}

/**
 * Deletes a database file (and SQLite's side files) after it has been closed. Used on sign-out and
 * when the key was invalidated: without its key the file is unreadable anyway, but nothing should
 * be left behind.
 */
export function deleteDatabaseFile(filename: string): void {
  for (const name of [filename, `${filename}-wal`, `${filename}-shm`]) {
    try {
      openRawDatabase({ name }).delete();
    } catch {
      // Missing side files are expected.
    }
  }
}
