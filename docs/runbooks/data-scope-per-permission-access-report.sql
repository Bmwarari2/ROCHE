-- Pre-deployment access report for data scope per permission (ADR-0071; HZ-011, HZ-073).
--
-- Read-only: it runs in a READ ONLY transaction and ends with ROLLBACK, and filters every table by
-- the organisation as well as through row-level security. For one organisation it lists each
-- member of staff whose reach changes for any of four reads, one row per change (`narrows` or
-- `widens`):
--   people.person.read    the person's record on screen (the API and row-level security)
--   sync: people          the person and allergies on a phone (people.person.read and
--                         care.plan.read; review round 2)
--   sync: care            the care reference and plan details on a phone (care.plan.read)
--   sync: entries         recent notes, charts and marks on a phone (care.note.read)
-- Before: one merged scope from all the member's roles, applied to every permission they held,
-- with a role scoped to the organisation or to a location reaching its location when assigned at
-- one and everywhere when assigned with none; grants added permissions but no reach; a phone
-- synced every family where the merged scope reached, and the people the member was assigned to,
-- for anyone holding people.person.read. After: each read reaches only where the roles and grants
-- carrying it reach, and the people the member is assigned to only through a role scoped to
-- assigned people that carries it. Opaque ids, location names and counts only; look members up
-- by id in the organisation's team screen.
--
-- Run it BEFORE deploying migrations 0048 and 0049, as harbour_owner, once per organisation:
--   psql "$OWNER_DATABASE_URL" -v tenant_id=<organisation uuid> \
--     -f docs/runbooks/data-scope-per-permission-access-report.sql
-- It reads no column those migrations add, so it also runs after them (a location role with no
-- location is read as organisation-wide, the meaning migration 0048 keeps; a grant with no
-- location is read as organisation-wide, and a live one stops migration 0048 until someone ends it
-- or gives it a location).

BEGIN READ ONLY;
SELECT set_config('app.tenant_id', :'tenant_id', true), set_config('app.scope', 'tenant', true);

WITH live_roles AS (
  SELECT ra.tenant_user_id, r.scope_kind::text AS kind, r.permissions, ra.location_id
  FROM role_assignment ra
  JOIN role r ON r.id = ra.role_id AND r.tenant_id = ra.tenant_id
  JOIN tenant_user u ON u.id = ra.tenant_user_id AND u.tenant_id = ra.tenant_id
  WHERE ra.tenant_id = current_setting('app.tenant_id')::uuid
    AND ra.deleted_at IS NULL AND r.archived_at IS NULL
    AND u.status IN ('invited', 'active')
    AND ra.valid_from <= now() AND (ra.valid_to IS NULL OR ra.valid_to > now())
    -- A role with any portal permission gives a staff session nothing, then and now.
    AND NOT (r.permissions && ARRAY['comms.portal.family', 'comms.portal.self', 'comms.feed.read',
      'comms.notification.subscribe', 'comms.visit_booking.request']::text[])
),
live_grants AS (
  SELECT g.tenant_user_id, g.permissions, g.location_id
  FROM access_grant g
  JOIN tenant_user u ON u.id = g.tenant_user_id AND u.tenant_id = g.tenant_id
  WHERE g.tenant_id = current_setting('app.tenant_id')::uuid
    AND g.deleted_at IS NULL AND g.revoked_at IS NULL
    AND u.status IN ('invited', 'active')
    AND g.valid_from <= now() AND g.valid_to > now()
),
members AS (
  SELECT tenant_user_id FROM live_roles UNION SELECT tenant_user_id FROM live_grants
),
-- The people each member is assigned to now, with where they live (counted, never named).
assigned_people AS (
  SELECT pa.tenant_user_id, p.location_id
  FROM person_assignment pa
  JOIN person p ON p.id = pa.person_id AND p.tenant_id = pa.tenant_id
  WHERE pa.tenant_id = current_setting('app.tenant_id')::uuid
    AND pa.deleted_at IS NULL AND p.deleted_at IS NULL
    AND pa.valid_from <= now() AND (pa.valid_to IS NULL OR pa.valid_to > now())
),
-- Before: the merged scope of all the member's roles, whatever each carried.
merged AS (
  SELECT m.tenant_user_id,
         coalesce(bool_or(lr.kind IN ('tenant', 'location') AND lr.location_id IS NULL), false)
           AS everywhere,
         coalesce(array_agg(DISTINCT lr.location_id)
                    FILTER (WHERE lr.kind IN ('tenant', 'location') AND lr.location_id IS NOT NULL),
                  '{}') AS locations,
         -- Assigned people counted on screen only when some role gave a scope at all.
         coalesce(bool_or(lr.kind IN ('tenant', 'location', 'assigned', 'self')), false) AS scoped,
         EXISTS (SELECT 1 FROM live_roles r2
                 WHERE r2.tenant_user_id = m.tenant_user_id
                   AND 'people.person.read' = ANY (r2.permissions))
         OR EXISTS (SELECT 1 FROM live_grants g2
                    WHERE g2.tenant_user_id = m.tenant_user_id
                      AND 'people.person.read' = ANY (g2.permissions)) AS synced
  FROM members m
  LEFT JOIN live_roles lr ON lr.tenant_user_id = m.tenant_user_id
  GROUP BY m.tenant_user_id
),
perms (permission) AS (
  VALUES ('people.person.read'), ('care.plan.read'), ('care.note.read')
),
-- After: each permission from the roles and grants carrying it only.
per_permission AS (
  SELECT m.tenant_user_id, p.permission,
         EXISTS (SELECT 1 FROM live_roles lr
                 WHERE lr.tenant_user_id = m.tenant_user_id AND p.permission = ANY (lr.permissions))
         OR EXISTS (SELECT 1 FROM live_grants g
                    WHERE g.tenant_user_id = m.tenant_user_id
                      AND p.permission = ANY (g.permissions)) AS held,
         EXISTS (SELECT 1 FROM live_roles lr
                 WHERE lr.tenant_user_id = m.tenant_user_id AND p.permission = ANY (lr.permissions)
                   AND lr.kind IN ('tenant', 'location') AND lr.location_id IS NULL)
         OR EXISTS (SELECT 1 FROM live_grants g
                    WHERE g.tenant_user_id = m.tenant_user_id
                      AND p.permission = ANY (g.permissions) AND g.location_id IS NULL)
           AS everywhere,
         EXISTS (SELECT 1 FROM live_grants g
                 WHERE g.tenant_user_id = m.tenant_user_id
                   AND p.permission = ANY (g.permissions) AND g.location_id IS NULL)
           AS by_grant_without_location,
         ARRAY(SELECT lr.location_id FROM live_roles lr
               WHERE lr.tenant_user_id = m.tenant_user_id AND p.permission = ANY (lr.permissions)
                 AND lr.kind IN ('tenant', 'location') AND lr.location_id IS NOT NULL
               UNION
               SELECT g.location_id FROM live_grants g
               WHERE g.tenant_user_id = m.tenant_user_id AND p.permission = ANY (g.permissions)
                 AND g.location_id IS NOT NULL) AS locations,
         EXISTS (SELECT 1 FROM live_roles lr
                 WHERE lr.tenant_user_id = m.tenant_user_id AND p.permission = ANY (lr.permissions)
                   AND lr.kind IN ('assigned', 'self')) AS assigned
  FROM members m CROSS JOIN perms p
),
pivot AS (
  SELECT pp.tenant_user_id,
         pp.held AS person_held, pp.everywhere AS person_everywhere,
         pp.by_grant_without_location AS person_by_grant, pp.locations AS person_locations,
         pp.assigned AS person_assigned,
         pl.held AS plan_held, pl.everywhere AS plan_everywhere,
         pl.by_grant_without_location AS plan_by_grant, pl.locations AS plan_locations,
         pl.assigned AS plan_assigned,
         nt.held AS note_held, nt.everywhere AS note_everywhere,
         nt.by_grant_without_location AS note_by_grant, nt.locations AS note_locations,
         nt.assigned AS note_assigned
  FROM per_permission pp
  JOIN per_permission pl
    ON pl.tenant_user_id = pp.tenant_user_id AND pl.permission = 'care.plan.read'
  JOIN per_permission nt
    ON nt.tenant_user_id = pp.tenant_user_id AND nt.permission = 'care.note.read'
  WHERE pp.permission = 'people.person.read'
),
-- Each read, before and after: whether it reaches anyone, everywhere, which homes, and the people
-- the member is assigned to. The phone needs people.person.read for a token at all, then and now;
-- the people family needs care.plan.read too, and reaches where both do.
reads AS (
  SELECT m.tenant_user_id, 1 AS ord, 'people.person.read' AS read,
         x.person_held AS was_held, m.everywhere AS was_everywhere, m.locations AS was_at,
         m.scoped AS was_assigned,
         x.person_held AS held, x.person_everywhere AS everywhere, x.person_locations AS locations,
         x.person_assigned AS assigned, x.person_by_grant AS by_grant
  FROM merged m JOIN pivot x USING (tenant_user_id)
  UNION ALL
  SELECT m.tenant_user_id, 2, 'sync: people',
         m.synced, m.everywhere, m.locations, true,
         x.person_held AND x.plan_held,
         x.person_everywhere AND x.plan_everywhere,
         CASE WHEN x.person_everywhere THEN x.plan_locations
              WHEN x.plan_everywhere THEN x.person_locations
              ELSE ARRAY(SELECT unnest(x.person_locations) INTERSECT
                         SELECT unnest(x.plan_locations)) END,
         (x.person_everywhere OR x.person_assigned) AND (x.plan_everywhere OR x.plan_assigned),
         (x.person_by_grant OR x.plan_by_grant)
  FROM merged m JOIN pivot x USING (tenant_user_id)
  UNION ALL
  SELECT m.tenant_user_id, 3, 'sync: care',
         m.synced, m.everywhere, m.locations, true,
         x.person_held AND x.plan_held, x.plan_everywhere, x.plan_locations, x.plan_assigned,
         x.plan_by_grant
  FROM merged m JOIN pivot x USING (tenant_user_id)
  UNION ALL
  SELECT m.tenant_user_id, 4, 'sync: entries',
         m.synced, m.everywhere, m.locations, true,
         x.person_held AND x.note_held, x.note_everywhere, x.note_locations, x.note_assigned,
         x.note_by_grant
  FROM merged m JOIN pivot x USING (tenant_user_id)
),
-- Nothing is reached where the read is not held; then compare the places and count the assigned
-- people (never named) each side reaches.
compared AS (
  SELECT r.tenant_user_id, r.ord, r.read,
         r.was_held AND r.was_everywhere AS was_everywhere,
         CASE WHEN r.was_held THEN r.was_at ELSE '{}' END AS was_at,
         r.was_held AND r.was_assigned AS was_assigned,
         r.held AND r.everywhere AS everywhere,
         CASE WHEN r.held THEN r.locations ELSE '{}' END AS locations,
         r.held AND r.assigned AS assigned,
         r.held AND r.everywhere AND r.by_grant AS by_grant,
         (r.was_held OR r.held) AS relevant
  FROM reads r
),
counted AS (
  SELECT c.*,
         EXISTS (SELECT 1 FROM assigned_people ap WHERE ap.tenant_user_id = c.tenant_user_id)
           AS has_people,
         ARRAY(SELECT unnest(c.was_at) EXCEPT SELECT unnest(c.locations)) AS lost_at,
         ARRAY(SELECT unnest(c.locations) EXCEPT SELECT unnest(c.was_at)) AS gained_at,
         (SELECT count(*) FROM assigned_people ap
          WHERE ap.tenant_user_id = c.tenant_user_id
            AND (c.was_everywhere OR ap.location_id = ANY (c.was_at) OR c.was_assigned)
            AND NOT (c.everywhere OR ap.location_id = ANY (c.locations) OR c.assigned))
           AS lost_people,
         (SELECT count(*) FROM assigned_people ap
          WHERE ap.tenant_user_id = c.tenant_user_id
            AND NOT (c.was_everywhere OR ap.location_id = ANY (c.was_at) OR c.was_assigned)
            AND (c.everywhere OR ap.location_id = ANY (c.locations) OR c.assigned))
           AS gained_people
  FROM compared c
  WHERE c.relevant
),
changes AS (
  SELECT 'narrows' AS change, n.*,
         concat_ws('; ',
           CASE WHEN n.was_everywhere AND NOT n.everywhere THEN 'loses the whole organisation' END,
           CASE WHEN NOT n.everywhere AND cardinality(n.lost_at) > 0 THEN
             'loses ' || (SELECT string_agg(l.name, ', ' ORDER BY l.name) FROM location l
                          WHERE l.id = ANY (n.lost_at)) END,
           CASE WHEN n.lost_people > 0 THEN
             'loses ' || n.lost_people || ' assigned ' ||
             CASE WHEN n.lost_people = 1 THEN 'person' ELSE 'people' END END) AS detail
  FROM counted n
  WHERE (n.was_everywhere AND NOT n.everywhere)
     OR (NOT n.everywhere AND cardinality(n.lost_at) > 0)
     OR n.lost_people > 0
  UNION ALL
  SELECT 'widens', w.*,
         concat_ws('; ',
           CASE WHEN w.everywhere AND NOT w.was_everywhere THEN
             'gains the whole organisation' ||
             CASE WHEN w.by_grant THEN ' (through a grant with no location)' ELSE '' END END,
           CASE WHEN NOT w.was_everywhere AND NOT w.everywhere AND cardinality(w.gained_at) > 0 THEN
             'gains ' || (SELECT string_agg(l.name, ', ' ORDER BY l.name) FROM location l
                          WHERE l.id = ANY (w.gained_at)) END,
           CASE WHEN w.gained_people > 0 THEN
             'gains ' || w.gained_people || ' assigned ' ||
             CASE WHEN w.gained_people = 1 THEN 'person' ELSE 'people' END END)
  FROM counted w
  WHERE (w.everywhere AND NOT w.was_everywhere)
     OR (NOT w.was_everywhere AND NOT w.everywhere AND cardinality(w.gained_at) > 0)
     OR w.gained_people > 0
)
SELECT ch.change,
       ch.tenant_user_id,
       ch.read,
       CASE WHEN ch.was_everywhere THEN 'whole organisation'
            WHEN cardinality(ch.was_at) > 0 THEN
              (SELECT string_agg(l.name, ', ' ORDER BY l.name) FROM location l
               WHERE l.id = ANY (ch.was_at))
              || CASE WHEN ch.was_assigned AND ch.has_people THEN ' and assigned people'
                      ELSE '' END
            WHEN ch.was_assigned THEN 'assigned people only'
            ELSE 'no one' END AS before,
       CASE WHEN ch.everywhere THEN 'whole organisation'
            WHEN cardinality(ch.locations) > 0 THEN
              (SELECT string_agg(l.name, ', ' ORDER BY l.name) FROM location l
               WHERE l.id = ANY (ch.locations))
              || CASE WHEN ch.assigned AND ch.has_people THEN ' and assigned people'
                      ELSE '' END
            WHEN ch.assigned THEN 'assigned people only'
            ELSE 'no one' END AS after,
       ch.detail
FROM changes ch
ORDER BY ch.change, ch.tenant_user_id, ch.ord;

ROLLBACK;
