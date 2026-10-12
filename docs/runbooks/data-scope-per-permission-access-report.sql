-- Pre-deployment access report for data scope per permission (ADR-0071; HZ-011, HZ-073).
--
-- Read-only: it runs in a READ ONLY transaction and ends with ROLLBACK, and filters every table by
-- the organisation as well as through row-level security. It lists, for one
-- organisation, each member of staff whose reach narrows for people.person.read and the three
-- reads the sync streams serve (people.person.read, care.plan.read, care.note.read): before, one
-- merged scope from all their roles applied to every permission they held, and the people they
-- were assigned to counted for every permission; after, each permission reaches only where the
-- roles and grants carrying it reach. Opaque ids and location names only; look members up by id
-- in the organisation's team screen.
--
-- Run it BEFORE deploying migrations 0048 and 0049, as harbour_owner, once per organisation:
--   psql "$OWNER_DATABASE_URL" -v tenant_id=<organisation uuid> \
--     -f docs/runbooks/data-scope-per-permission-access-report.sql
-- It reads no column those migrations add, so it also runs after them (a grant or location role
-- with no location is read as organisation-wide, the meaning migration 0048 keeps).

BEGIN READ ONLY;
SELECT set_config('app.tenant_id', :'tenant_id', true), set_config('app.scope', 'tenant', true);

WITH live_roles AS (
  SELECT ra.tenant_user_id, r.key, r.scope_kind::text AS kind, r.permissions, ra.location_id
  FROM role_assignment ra
  JOIN role r ON r.id = ra.role_id AND r.tenant_id = ra.tenant_id
  JOIN tenant_user u ON u.id = ra.tenant_user_id AND u.tenant_id = ra.tenant_id
  WHERE ra.tenant_id = current_setting('app.tenant_id')::uuid
    AND ra.deleted_at IS NULL AND r.archived_at IS NULL
    AND u.status IN ('invited', 'active')
    AND ra.valid_from <= now() AND (ra.valid_to IS NULL OR ra.valid_to > now())
    -- A role mixing portal and staff permissions gives a staff session nothing, then and now.
    AND NOT (r.permissions && ARRAY['comms.portal.family', 'comms.portal.self', 'comms.feed.read',
      'comms.notification.subscribe', 'comms.visit_booking.request']::text[])
),
live_grants AS (
  SELECT g.tenant_user_id, g.permissions, g.location_id
  FROM access_grant g
  WHERE g.tenant_id = current_setting('app.tenant_id')::uuid
    AND g.deleted_at IS NULL AND g.revoked_at IS NULL
    AND g.valid_from <= now() AND g.valid_to > now()
),
members AS (
  SELECT tenant_user_id FROM live_roles UNION SELECT tenant_user_id FROM live_grants
),
reads (permission) AS (
  VALUES ('people.person.read'), ('care.plan.read'), ('care.note.read')
),
assigned_people AS (
  SELECT DISTINCT pa.tenant_user_id
  FROM person_assignment pa
  WHERE pa.tenant_id = current_setting('app.tenant_id')::uuid
    AND pa.deleted_at IS NULL AND pa.valid_from <= now()
    AND (pa.valid_to IS NULL OR pa.valid_to > now())
),
-- Before: the widest scope of all the member's roles, whatever each carried.
before AS (
  SELECT m.tenant_user_id,
         coalesce(bool_or(lr.kind = 'tenant' OR (lr.kind = 'location' AND lr.location_id IS NULL)),
                  false) AS everywhere,
         coalesce(array_agg(DISTINCT lr.location_id)
                    FILTER (WHERE lr.kind IN ('tenant', 'location') AND lr.location_id IS NOT NULL),
                  '{}') AS locations,
         coalesce(bool_or(lr.kind IN ('assigned', 'self')), false)
           OR m.tenant_user_id IN (SELECT tenant_user_id FROM assigned_people) AS assigned
  FROM members m
  LEFT JOIN live_roles lr ON lr.tenant_user_id = m.tenant_user_id
  GROUP BY m.tenant_user_id
),
-- After: each read from the roles and grants carrying it only.
after AS (
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
  FROM members m CROSS JOIN reads p
),
named AS (
  SELECT a.tenant_user_id, a.permission, b.everywhere AS was_everywhere, b.locations AS was_at,
         b.assigned AS was_assigned, a.everywhere, a.locations, a.assigned,
         ARRAY(SELECT unnest(b.locations) EXCEPT SELECT unnest(a.locations)) AS lost_locations
  FROM after a JOIN before b USING (tenant_user_id)
  WHERE a.held
)
SELECT n.tenant_user_id,
       n.permission,
       CASE WHEN n.was_everywhere THEN 'whole organisation'
            WHEN cardinality(n.was_at) > 0 THEN
              (SELECT string_agg(l.name, ', ' ORDER BY l.name) FROM location l
               WHERE l.id = ANY (n.was_at))
              || CASE WHEN n.was_assigned THEN ' and assigned people' ELSE '' END
            WHEN n.was_assigned THEN 'assigned people only'
            ELSE 'no one' END AS before,
       CASE WHEN n.everywhere THEN 'whole organisation'
            WHEN cardinality(n.locations) > 0 THEN
              (SELECT string_agg(l.name, ', ' ORDER BY l.name) FROM location l
               WHERE l.id = ANY (n.locations))
              || CASE WHEN n.assigned THEN ' and assigned people' ELSE '' END
            WHEN n.assigned THEN 'assigned people only'
            ELSE 'no one' END AS after,
       concat_ws('; ',
         CASE WHEN n.was_everywhere AND NOT n.everywhere THEN 'loses the whole organisation' END,
         CASE WHEN NOT n.everywhere AND cardinality(n.lost_locations) > 0 THEN
           'loses ' || (SELECT string_agg(l.name, ', ' ORDER BY l.name) FROM location l
                        WHERE l.id = ANY (n.lost_locations)) END,
         CASE WHEN n.was_assigned AND NOT n.assigned AND NOT n.everywhere THEN
           'loses assigned people' END) AS narrows
FROM named n
WHERE (n.was_everywhere AND NOT n.everywhere)
   OR (NOT n.everywhere AND cardinality(n.lost_locations) > 0)
   OR (n.was_assigned AND NOT n.assigned AND NOT n.everywhere)
ORDER BY n.tenant_user_id, n.permission;

ROLLBACK;
