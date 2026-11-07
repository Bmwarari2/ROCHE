-- The product name in stored rows (ADR-0127): words people read that earlier migrations or the
-- reference-data seed stored with the codename. Only the whole capitalised word changes, as in
-- scripts/rename-product.mjs; none of these columns holds a host name, an identifier or a demo
-- place name ("Harbour House" and the rest stay, and are not in these tables).
--
-- - audit_starter_template.source: the seven starter templates from 0081 ("Harbour starter
--   template ..."), shown when a manager adopts one. A tenant's own adopted copies keep the
--   tenant's words.
-- - rate_table.source and retention_class.source and .notes, global rows only (tenant_id IS NULL):
--   the seed replaces them from docs/specs/rates.md and retention.md, which the rename changed, so a
--   re-seed gives the same result; this keeps an environment that is not re-seeded in step. A
--   tenant's own rows keep the tenant's words.
--
-- Reference data, not care records: no audit event, as the seed writes none. The owner maintains
-- these global rows under the global_maintenance and owner_maintenance policies; forced RLS stays.
UPDATE public.audit_starter_template
   SET source = regexp_replace(source, '\mHarbour\M', 'Thapsus Care', 'g')
 WHERE source ~ '\mHarbour\M';
--> statement-breakpoint
UPDATE public.rate_table
   SET source = regexp_replace(source, '\mHarbour\M', 'Thapsus Care', 'g')
 WHERE tenant_id IS NULL AND source ~ '\mHarbour\M';
--> statement-breakpoint
UPDATE public.retention_class
   SET source = regexp_replace(source, '\mHarbour\M', 'Thapsus Care', 'g'),
       notes = regexp_replace(notes, '\mHarbour\M', 'Thapsus Care', 'g')
 WHERE tenant_id IS NULL AND (source ~ '\mHarbour\M' OR notes ~ '\mHarbour\M');
