import {
  DEFAULT_HYDRATION_STATE,
  type EvaluatedParameters,
  type HydratedSyncConfig,
  RequestParameters,
  type SqliteJsonRow,
  type SqliteRow,
  SqlSyncRules,
} from "@powersync/service-sync-rules";
import { offlineWindowBlocks } from "../../src/client/window";
import type { SyncTokenClaims } from "../../src/streams/index";

/**
 * A minimal in-memory PowerSync: replicate rows through the real sync-rules engine, then work out
 * which rows a device holding a given token would receive. Uses the same library version as the
 * service, so a query that compiles here behaves the same there.
 */

export type SourceRows = Record<string, SqliteRow[]>;

/**
 * The tables whose `sync_location_id` the database sets from the person (migration 0145;
 * ADR-0134). A fixture row that leaves it out gets it here as the trigger would: the person's
 * home while they receive care, else none; a task, its own home while its person receives care;
 * a task about nobody, its own home. A row whose person is not in the fixture gets none, as in the
 * database. The rows are routed by the person's state now: moves within the window, and the
 * insert-move race, are tested against Postgres (packages/db/test/sync-location.test.ts).
 */
const SYNC_LOCATION_TABLES = new Set([
  "care_note",
  "observation",
  "body_map_mark",
  "activity_record",
  "visit_log",
  "medication_administration",
  "task",
]);

const RECEIVES_CARE = new Set(["active", "on_leave", "in_hospital"]);

/**
 * A handover's items, notes and acknowledgements carry its home and shift end, and an item or
 * note whether it is about nobody or someone who lives at that home (`at_home`; migration 0145).
 */
const HANDOVER_CHILD_TABLES = new Set([
  "handover_item",
  "handover_note",
  "handover_acknowledgement",
]);

function withHandoverSync(source: SourceRows): SourceRows {
  const handovers = new Map((source.handover ?? []).map((h) => [h.id, h]));
  const homes = new Map((source.person ?? []).map((p) => [p.id, p.location_id]));
  return Object.fromEntries(
    Object.entries(source).map(([name, rows]) => [
      name,
      HANDOVER_CHILD_TABLES.has(name)
        ? rows.map((r) => {
            const h = handovers.get(String(r.handover_id));
            const home = h?.location_id ?? null;
            const person = r.person_id ?? null;
            return {
              ...r,
              shift_end: r.shift_end !== undefined ? r.shift_end : (h?.shift_end ?? null),
              sync_location_id: r.sync_location_id !== undefined ? r.sync_location_id : home,
              ...(name === "handover_acknowledgement"
                ? {}
                : {
                    person_location_id:
                      r.person_location_id !== undefined
                        ? r.person_location_id
                        : person === null
                          ? null
                          : (homes.get(String(person)) ?? null),
                    at_home:
                      r.at_home !== undefined
                        ? r.at_home
                        : person === null || homes.get(String(person)) === home
                          ? 1
                          : 0,
                  }),
            };
          })
        : rows,
    ]),
  );
}

function withSyncLocation(source: SourceRows): SourceRows {
  const homes = new Map(
    (source.person ?? []).map((p) => [
      p.id,
      RECEIVES_CARE.has(String(p.status ?? "active")) ? p.location_id : null,
    ]),
  );
  return Object.fromEntries(
    Object.entries(source).map(([name, rows]) => [
      name,
      SYNC_LOCATION_TABLES.has(name)
        ? rows.map((r) =>
            r.sync_location_id !== undefined
              ? r
              : {
                  ...r,
                  sync_location_id:
                    r.person_id === null || r.person_id === undefined
                      ? (r.location_id ?? null)
                      : name === "task"
                        ? homes.has(r.person_id) && homes.get(r.person_id) !== null
                          ? (r.location_id ?? null)
                          : null
                        : (homes.get(r.person_id) ?? null),
                },
          )
        : rows,
    ]),
  );
}

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
  /** Rows the parameter queries returned for this connection (PowerSync caps these too). */
  readonly parameterResults: number;
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
  // The API mints the window's ten-day blocks with its days (ADR-0134).
  if (claims.offline_days && !("offline_blocks" in claims)) {
    claims = { ...claims, offline_blocks: offlineWindowBlocks(claims.offline_days) };
  }
  // The API names the homes where the member's assigned people live (ADR-0134).
  if (claims.handover_assigned === true && !("handover_assigned_location_ids" in claims)) {
    const homes = new Map((source.person ?? []).map((p) => [p.id, p.location_id]));
    const assignedHomes = (source.person_assignment ?? [])
      .filter(
        (a) =>
          a.tenant_user_id === claims.sub &&
          a.tenant_id === claims.tenant_id &&
          (a.deleted_at ?? null) === null,
      )
      .map((a) => homes.get(a.person_id))
      .filter((l): l is string => typeof l === "string");
    claims = { ...claims, handover_assigned_location_ids: [...new Set(assignedHomes)].sort() };
  }
  // Tasks about nobody given to the member follow the care family's own assigned reach.
  if (!("care_own_tasks" in claims)) {
    claims = { ...claims, care_own_tasks: claims.care_assigned === true };
  }
  source = withHandoverSync(withSyncLocation(source));
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
  let parameterResults = 0;
  const dynamic = await querier.queryDynamicBucketDescriptions({
    getParameterSets: async (requested) =>
      requested.map((lookup) => {
        const rows = lookups
          .filter((l) => l.lookup.serializedRepresentation === lookup.serializedRepresentation)
          .flatMap((l) => l.bucketParameters);
        parameterResults += rows.length;
        return { lookup, rows };
      }),
  });
  const buckets = [...querier.staticBuckets, ...dynamic].map((b) => b.bucket).sort();

  const tables: Record<string, Map<string, SqliteJsonRow>> = {};
  for (const bucket of buckets) {
    for (const row of bucketRows.get(bucket) ?? []) {
      tables[row.table] ??= new Map();
      tables[row.table]?.set(row.id, row.data);
    }
  }
  return { buckets, tables, parameterResults };
}

export function ids(dataset: DeviceDataset, tableName: string): string[] {
  return [...(dataset.tables[tableName]?.keys() ?? [])].sort();
}
