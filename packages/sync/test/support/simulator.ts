import {
  DEFAULT_HYDRATION_STATE,
  type EvaluatedParameters,
  type HydratedSyncConfig,
  RequestParameters,
  type SqliteJsonRow,
  type SqliteRow,
  SqlSyncRules,
} from "@powersync/service-sync-rules";
import type { SyncTokenClaims } from "../../src/streams/index";

/**
 * A minimal in-memory PowerSync: replicate rows through the real sync-rules engine, then work out
 * which rows a device holding a given token would receive. Uses the same library version as the
 * service, so a query that compiles here behaves the same there.
 */

export type SourceRows = Record<string, SqliteRow[]>;

const table = (name: string) => ({ connectionTag: "default", schema: "public", name });

export function compile(yaml: string): { hydrated: HydratedSyncConfig; errors: string[] } {
  const { config, errors } = SqlSyncRules.fromYaml(yaml, {
    defaultSchema: "public",
    throwOnError: false,
  });
  return {
    hydrated: config.hydrate({ hydrationState: DEFAULT_HYDRATION_STATE, sqlite: null }),
    errors: errors.map((e) => e.message),
  };
}

export interface DeviceDataset {
  readonly buckets: string[];
  /** Output table name to the rows it holds, keyed by id. */
  readonly tables: Record<string, Map<string, SqliteJsonRow>>;
}

/**
 * `connection` is what the device sends as connection parameters (`connect({ params })`); the
 * device controls it, so tests pass hostile values to prove it cannot widen the token's scope.
 */
export async function syncFor(
  hydrated: HydratedSyncConfig,
  source: SourceRows,
  claims: Partial<SyncTokenClaims>,
  connection: Record<string, unknown> = {},
): Promise<DeviceDataset> {
  // Replication: assign every row to buckets and build the parameter lookup index.
  const bucketRows = new Map<string, { table: string; id: string; data: SqliteJsonRow }[]>();
  const lookups: EvaluatedParameters[] = [];
  for (const [name, rows] of Object.entries(source)) {
    for (const record of rows) {
      for (const result of hydrated.evaluateRow({ sourceTable: table(name), record })) {
        const list = bucketRows.get(result.bucket) ?? [];
        list.push({ table: result.table, id: result.id, data: result.data });
        bucketRows.set(result.bucket, list);
      }
      lookups.push(...hydrated.evaluateParameterRow(table(name), record));
    }
  }

  // Connection: resolve the buckets this token may read.
  const request = new RequestParameters(
    { userIdJson: claims.sub ?? null, parsedPayload: { ...claims } },
    { ...connection },
  );
  const { querier, errors } = hydrated.getBucketParameterQuerier({
    globalParameters: request,
    hasDefaultStreams: true,
    streams: {},
  });
  if (errors.length > 0) throw new Error(errors.map((e) => e.message).join("; "));
  const dynamic = await querier.queryDynamicBucketDescriptions({
    getParameterSets: async (requested) =>
      requested.map((lookup) => ({
        lookup,
        rows: lookups
          .filter((l) => l.lookup.serializedRepresentation === lookup.serializedRepresentation)
          .flatMap((l) => l.bucketParameters),
      })),
  });
  const buckets = [...querier.staticBuckets, ...dynamic].map((b) => b.bucket).sort();

  const tables: Record<string, Map<string, SqliteJsonRow>> = {};
  for (const bucket of buckets) {
    for (const row of bucketRows.get(bucket) ?? []) {
      tables[row.table] ??= new Map();
      tables[row.table]?.set(row.id, row.data);
    }
  }
  return { buckets, tables };
}

export function ids(dataset: DeviceDataset, tableName: string): string[] {
  return [...(dataset.tables[tableName]?.keys() ?? [])].sort();
}
