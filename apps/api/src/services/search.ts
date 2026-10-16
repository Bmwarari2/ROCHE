import type { Transaction } from "@harbour/db";
import {
  type EffectiveAccess,
  type PersonStatus,
  SEARCHABLE_DOCUMENT_CATEGORIES,
  type SearchHit,
  type SearchPlan,
  type SearchPlanEntity,
  scopeFor,
} from "@harbour/domain";
import { type SQL, sql } from "drizzle-orm";
import { inScopeOf } from "../http/context";

/**
 * The database side of search (platform-completions.md rules 1 to 7; ADR-0070; HZ-011). Each kind
 * of record is read in the scope of the permission it rests on (ADR-0071), under forced row-level
 * security, with the tenant stated first and the queries from `normaliseSearchQuery` as bound
 * parameters. The API then applies the plan again to every row (`filterSearchResults`).
 */

/** Rows read per kind before the plan's second filter; the page shows at most `pageSize`. */
const READ_LIMIT = 100;

/** What a search shows beyond the hit itself: names, excerpts and the like, by result id. */
export interface SearchDetail {
  readonly person?: {
    readonly name: string;
    readonly preferredName: string | null;
    readonly dateOfBirth: string | null;
    readonly nhsNumber: string | null;
    readonly locationName: string | null;
    readonly roomLabel: string | null;
    readonly hasPhoto: boolean;
  };
  readonly staff?: {
    readonly name: string;
    readonly roles: string[];
    readonly locations: string[];
  };
  readonly document?: {
    readonly title: string;
    readonly category: string;
    readonly fileName: string | null;
    readonly createdAt: string;
    readonly personName: string | null;
  };
  readonly note?: {
    readonly personName: string;
    readonly excerpt: string;
    readonly occurredAt: string;
    readonly author: string | null;
  };
}

export interface SearchRows {
  readonly hits: SearchHit[];
  readonly details: Map<string, SearchDetail>;
}

type Row = Record<string, unknown>;

const text = (v: unknown) => (v === null || v === undefined ? null : String(v));
const iso = (v: unknown) =>
  v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
const fullName = (r: Row) => `${r.given_name} ${r.family_name}`;

/** Up to 160 characters of a note, cut at a word, for the result line. */
function excerptOf(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= 160) return flat;
  const cut = flat.slice(0, 160);
  const space = cut.lastIndexOf(" ");
  return `${(space > 80 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Whether the searching member holds an unexpired assignment to the person. */
const assignedTo = (actor: string, personColumn: SQL) => sql`EXISTS (
  SELECT 1 FROM person_assignment pa
  WHERE pa.person_id = ${personColumn} AND pa.tenant_user_id = ${actor}
    AND pa.valid_from <= now() AND (pa.valid_to IS NULL OR pa.valid_to > now()))`;

export async function searchRows(
  tx: Transaction,
  input: {
    readonly tenantId: string;
    readonly actor: string;
    readonly access: EffectiveAccess;
    readonly plan: SearchPlan;
  },
): Promise<SearchRows> {
  const { tenantId, actor, access, plan } = input;
  const hits: SearchHit[] = [];
  const details = new Map<string, SearchDetail>();
  const query = plan.query;
  const prefix = query.kind === "text" ? query.tsQuery : "";
  const exact = query.kind === "text" ? query.exactTsQuery : "";
  const statuses = plan.personStatuses.join(",");
  const statusIn = (column: SQL) => sql`${column}::text = ANY(string_to_array(${statuses}, ','))`;
  const matches = (vector: SQL, q: string) =>
    sql`${vector} @@ to_tsquery('app.harbour_search', ${q})`;
  const rank = (vector: SQL) =>
    sql`ts_rank(${vector}, to_tsquery('app.harbour_search', ${prefix}))`;
  // Each kind in the scope of its own permission (ADR-0071), never widened by break-glass: people
  // opened that way are found only through break-glass search (rule 9), so ordinary search reads
  // exactly the scope the plan holds every row to.
  const scoped = <T>(permission: SearchPlanEntity["permission"], run: () => Promise<T>) =>
    inScopeOf(tx, { ...scopeFor(access, permission), includesBreakGlass: false }, run);
  const rows = async (q: SQL) => (await tx.execute<Row>(q)).rows;

  for (const entity of plan.entities) {
    if (entity.type === "person") {
      const where =
        query.kind === "nhs_number"
          ? sql`p.nhs_number = ${query.nhsNumber}`
          : sql`(${matches(sql`p.search_names`, prefix)} OR ${matches(sql`p.search_room`, prefix)})`;
      const isExact =
        query.kind === "nhs_number"
          ? sql`true`
          : sql`(${matches(sql`p.search_names`, exact)} OR ${matches(sql`p.search_room`, exact)})`;
      const found = await scoped(entity.permission, () =>
        rows(sql`
          SELECT p.id, p.given_name, p.family_name, p.preferred_name, p.date_of_birth::text AS dob,
                 p.nhs_number, p.status, p.location_id, l.name AS location_name, p.room_label,
                 p.photo_document_id IS NOT NULL AS has_photo, ${isExact} AS exact,
                 ${query.kind === "text" ? rank(sql`p.search_names`) : sql`1`} AS rank,
                 ${assignedTo(actor, sql`p.id`)} AS assigned
          FROM person p
          LEFT JOIN location l ON l.tenant_id = p.tenant_id AND l.id = p.location_id
          WHERE p.tenant_id = ${tenantId} AND p.deleted_at IS NULL AND ${statusIn(sql`p.status`)}
            AND ${where}
          LIMIT ${READ_LIMIT}`),
      );
      for (const r of found) {
        const id = String(r.id);
        hits.push({
          entityType: "person",
          id,
          rank: Number(r.rank),
          matchQuality: r.exact ? "exact" : "prefix",
          sortName: fullName(r),
          dateOfBirth: text(r.dob),
          personId: id,
          personStatus: r.status as PersonStatus,
          personLocationId: text(r.location_id),
          assignedToActor: Boolean(r.assigned),
        });
        details.set(id, {
          person: {
            name: fullName(r),
            preferredName: text(r.preferred_name),
            dateOfBirth: text(r.dob),
            nhsNumber: text(r.nhs_number),
            locationName: text(r.location_name),
            roomLabel: text(r.room_label),
            hasPhoto: Boolean(r.has_photo),
          },
        });
      }
    }

    if (entity.type === "staff" && query.kind === "text") {
      // Colleagues only: members whose roles are all portal roles (families) are never listed.
      const found = await rows(sql`
        SELECT u.id, u.display_name,
               ${matches(sql`u.search_name`, exact)} AS exact, ${rank(sql`u.search_name`)} AS rank,
               coalesce(array_agg(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles,
               coalesce(array_agg(DISTINCT l.name) FILTER (WHERE l.name IS NOT NULL), '{}') AS location_names,
               coalesce(array_agg(DISTINCT ra.location_id) FILTER (WHERE ra.location_id IS NOT NULL), '{}') AS location_ids,
               bool_or(ra.location_id IS NULL) AS anywhere
        FROM tenant_user u
        JOIN role_assignment ra ON ra.tenant_id = u.tenant_id AND ra.tenant_user_id = u.id
          AND ra.deleted_at IS NULL AND ra.valid_from <= now()
          AND (ra.valid_to IS NULL OR ra.valid_to > now())
        JOIN role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id AND r.deleted_at IS NULL
          AND NOT ('comms.portal.family' = ANY(r.permissions))
        LEFT JOIN location l ON l.tenant_id = ra.tenant_id AND l.id = ra.location_id
        WHERE u.tenant_id = ${tenantId} AND u.deleted_at IS NULL AND u.status = 'active'
          AND ${matches(sql`u.search_name`, prefix)}
        GROUP BY u.id, u.display_name, u.search_name
        LIMIT ${READ_LIMIT}`);
      for (const r of found) {
        const id = String(r.id);
        hits.push({
          entityType: "staff",
          id,
          rank: Number(r.rank),
          matchQuality: r.exact ? "exact" : "prefix",
          sortName: String(r.display_name),
          personId: null,
          personStatus: null,
          personLocationId: null,
          assignedToActor: false,
          staffLocationIds: r.anywhere ? null : (r.location_ids as string[]),
        });
        details.set(id, {
          staff: {
            name: String(r.display_name),
            roles: (r.roles as string[]).sort(),
            locations: (r.location_names as string[]).sort(),
          },
        });
      }
    }

    if (entity.type === "document" && query.kind === "text") {
      for (const category of entity.documentCategories ?? []) {
        const rule = SEARCHABLE_DOCUMENT_CATEGORIES.find((c) => c.category === category);
        if (!rule) continue;
        const found = await scoped(rule.permission, () =>
          rows(sql`
            SELECT d.id, d.title, d.category, d.file_name, d.created_at, d.person_id,
                   p.given_name, p.family_name, p.status, p.location_id,
                   ${matches(sql`d.search_title`, exact)} AS exact, ${rank(sql`d.search_title`)} AS rank,
                   ${rule.personScoped ? assignedTo(actor, sql`d.person_id`) : sql`false`} AS assigned
            FROM document d
            LEFT JOIN person p ON p.tenant_id = d.tenant_id AND p.id = d.person_id
            WHERE d.tenant_id = ${tenantId} AND d.deleted_at IS NULL AND d.status = 'available'
              AND d.category = ${category}
              AND ${rule.personScoped ? sql`d.person_id IS NOT NULL AND ${statusIn(sql`p.status`)}` : sql`d.person_id IS NULL`}
              AND ${matches(sql`d.search_title`, prefix)}
            LIMIT ${READ_LIMIT}`),
        );
        for (const r of found) {
          const id = String(r.id);
          hits.push({
            entityType: "document",
            id,
            rank: Number(r.rank),
            matchQuality: r.exact ? "exact" : "prefix",
            sortName: String(r.title),
            personId: text(r.person_id),
            // An organisation document is about no one: the plan checks it by its category.
            personStatus: r.person_id ? (r.status as PersonStatus | null) : null,
            personLocationId: text(r.location_id),
            assignedToActor: Boolean(r.assigned),
            documentCategory: String(r.category),
          });
          details.set(id, {
            document: {
              title: String(r.title),
              category: String(r.category),
              fileName: text(r.file_name),
              createdAt: iso(r.created_at),
              personName: r.given_name ? fullName(r) : null,
            },
          });
        }
      }
    }

    if (entity.type === "note" && query.kind === "text") {
      const found = await scoped(entity.permission, () =>
        rows(sql`
          SELECT n.id, n.person_id, n.body, n.occurred_at, p.given_name, p.family_name, p.status,
                 p.location_id, a.display_name AS author,
                 ${matches(sql`n.search_body`, exact)} AS exact, ${rank(sql`n.search_body`)} AS rank,
                 ${assignedTo(actor, sql`n.person_id`)} AS assigned,
                 EXISTS (SELECT 1 FROM care_note later
                         WHERE later.tenant_id = n.tenant_id AND later.supersedes_id = n.id) AS superseded
          FROM care_note n
          JOIN person p ON p.tenant_id = n.tenant_id AND p.id = n.person_id
          LEFT JOIN tenant_user a ON a.tenant_id = n.tenant_id AND a.id = n.created_by
          WHERE n.tenant_id = ${tenantId} AND ${statusIn(sql`p.status`)}
            AND ${matches(sql`n.search_body`, prefix)}
          ORDER BY n.occurred_at DESC
          LIMIT ${READ_LIMIT}`),
      );
      for (const r of found) {
        const id = String(r.id);
        hits.push({
          entityType: "note",
          id,
          rank: Number(r.rank),
          matchQuality: r.exact ? "exact" : "prefix",
          sortName: fullName(r),
          personId: String(r.person_id),
          personStatus: r.status as PersonStatus,
          personLocationId: text(r.location_id),
          assignedToActor: Boolean(r.assigned),
          superseded: Boolean(r.superseded),
        });
        details.set(id, {
          note: {
            personName: fullName(r),
            excerpt: excerptOf(String(r.body)),
            occurredAt: iso(r.occurred_at),
            author: text(r.author),
          },
        });
      }
    }
  }
  return { hits, details };
}
