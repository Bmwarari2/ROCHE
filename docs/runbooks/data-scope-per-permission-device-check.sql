-- Pre-deployment device check for data scope per permission (ADR-0071; HZ-011, HZ-073).
--
-- Read-only: it runs in a READ ONLY transaction and ends with ROLLBACK, and filters every table by
-- the organisation as well as through row-level security. Opaque ids and times only.
--
-- Run it as harbour_owner after the announced cut-off, once per organisation:
--   psql "$OWNER_DATABASE_URL" -v tenant_id=<organisation uuid> \
--     -v cutoff='2026-10-20 18:00' \
--     -f docs/runbooks/data-scope-per-permission-device-check.sql
-- The cut-off is a time in the UK (Europe/London, so British Summer Time is applied when it is in
-- force); the output shows times in UTC.

BEGIN READ ONLY;
SELECT set_config('app.tenant_id', :'tenant_id', true), set_config('app.scope', 'tenant', true),
       set_config('TimeZone', 'UTC', true);

-- 1. Devices the server has not seen since the cut-off: find each and sync it, or revoke it once
--    any entries it reported waiting are resolved.
SELECT b.device_id, max(b.last_seen_at) AS last_seen_utc
FROM device_binding b
WHERE b.tenant_id = current_setting('app.tenant_id')::uuid
  AND b.revoked_at IS NULL
GROUP BY b.device_id
HAVING max(b.last_seen_at) < (:'cutoff'::timestamp AT TIME ZONE 'Europe/London')
ORDER BY last_seen_utc;

-- 2. Staff who may use Care mode (a role in force carrying people.person.read) whose phone the
--    server has never seen: ask each whether they use a phone in Care mode; if they do, it must
--    sync before the deployment.
SELECT u.id AS tenant_user_id
FROM tenant_user u
WHERE u.tenant_id = current_setting('app.tenant_id')::uuid
  AND u.deleted_at IS NULL
  AND u.status IN ('invited', 'active')
  AND EXISTS (
    SELECT 1 FROM role_assignment ra
    JOIN role r ON r.id = ra.role_id AND r.tenant_id = ra.tenant_id
    WHERE ra.tenant_id = u.tenant_id AND ra.tenant_user_id = u.id
      AND ra.deleted_at IS NULL AND r.archived_at IS NULL
      AND ra.valid_from <= now() AND (ra.valid_to IS NULL OR ra.valid_to > now())
      AND 'people.person.read' = ANY (r.permissions))
  AND NOT EXISTS (
    SELECT 1 FROM device_binding b
    WHERE b.tenant_id = u.tenant_id AND b.tenant_user_id = u.id)
ORDER BY u.id;

ROLLBACK;
