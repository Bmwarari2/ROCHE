-- One-off check for data scope per permission, review round 3 (ADR-0071): organisation documents
-- attached to anything but the organisation's own records.
--
-- Read-only: it runs in a READ ONLY transaction and ends with ROLLBACK, and filters by the
-- organisation as well as through row-level security. Opaque ids, kinds and dates only, never a
-- title or a file.
--
-- An organisation's document is read by every member of staff, so since review round 3 the API
-- attaches one only to the organisation's own records (no subject, or a `location`,
-- `escalation_policy`, `statement_of_purpose_version` or `letter_template_version`), never to a
-- person, and refuses a subject id without its type. Rows written before then are listed here.
-- Run it once per environment, for every organisation, as harbour_owner:
--   for t in $(psql "$OWNER_DATABASE_URL" -Atc "SELECT id FROM tenant"); do
--     psql "$OWNER_DATABASE_URL" -v tenant_id="$t" \
--       -f docs/runbooks/data-scope-per-permission-document-subjects.sql
--   done

BEGIN READ ONLY;
SELECT set_config('app.tenant_id', :'tenant_id', true), set_config('app.scope', 'tenant', true);

SELECT current_setting('app.tenant_id') AS tenant_id,
       d.id AS document_id,
       d.subject_type,
       d.subject_id IS NOT NULL AS has_subject_id,
       d.person_id IS NOT NULL AS names_a_person,
       d.created_at
FROM document d
WHERE d.tenant_id = current_setting('app.tenant_id')::uuid
  AND d.deleted_at IS NULL
  AND d.category = 'organisation_document'
  AND (d.person_id IS NOT NULL
    OR (d.subject_id IS NOT NULL AND d.subject_type IS NULL)
    OR (d.subject_type IS NOT NULL AND d.subject_type NOT IN (
      'location', 'escalation_policy', 'statement_of_purpose_version', 'letter_template_version')))
ORDER BY d.created_at;

ROLLBACK;
