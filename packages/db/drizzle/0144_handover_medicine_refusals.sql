-- A refused dose reaches the shift handover as a refusal (Phase 2 slice 49; HZ-003). Expand only:
-- the previous app version never writes the new source type.
ALTER TABLE "handover_item" DROP CONSTRAINT "handover_item_source_type";--> statement-breakpoint
ALTER TABLE "handover_item" ADD CONSTRAINT "handover_item_source_type" CHECK (source_type IN ('task', 'observation', 'incident', 'body_map_mark', 'care_note', 'notification', 'medication_administration'));--> statement-breakpoint
-- A downtime pack may also hold the snapshot it was built from (slice 49 review: commit order, not
-- transaction start times, decides whether a write is newer than the pack).
CREATE OR REPLACE FUNCTION app.downtime_pack_people() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF jsonb_typeof(NEW.content -> 'pages') IS DISTINCT FROM 'array'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(NEW.content) AS k
                WHERE k NOT IN ('packId', 'locationId', 'locationName', 'generatedAt', 'asAt',
                                'validUntil', 'pages', 'excluded', 'warnings', 'buildSnapshot'))
     -- The build's database snapshot, so a write committed after it makes the pack stale (slice 49).
     OR (NEW.content ? 'buildSnapshot'
         AND COALESCE(NEW.content ->> 'buildSnapshot', '') !~ '^[0-9]+:[0-9]+:[0-9,]*$')
     OR COALESCE(NEW.content -> 'excluded', '[]'::jsonb) <> '[]'::jsonb
     OR jsonb_typeof(COALESCE(NEW.content -> 'warnings', '[]'::jsonb)) <> 'array'
     OR EXISTS (SELECT 1 FROM jsonb_each(NEW.warnings) AS w WHERE jsonb_typeof(w.value) <> 'number') THEN
    RAISE EXCEPTION 'A downtime pack holds its own keys, its pages and no one left out, and counts of warnings only'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.person_ids := ARRAY(
    SELECT DISTINCT (e ->> 'personId')::uuid
    FROM jsonb_array_elements(NEW.content -> 'pages') AS e
    ORDER BY 1);
  IF array_position(NEW.person_ids, NULL) IS NOT NULL
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(NEW.content -> 'warnings', '[]'::jsonb)) AS w
                WHERE (w ->> 'personId') IS NOT NULL
                  AND NOT (w ->> 'personId')::uuid = ANY (NEW.person_ids)) THEN
    RAISE EXCEPTION 'Every page of a downtime pack names its person, and its warnings are about them'
      USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(NEW.person_ids) = 0 AND EXISTS (
       SELECT 1 FROM public.person p
       WHERE p.location_id = NEW.location_id AND p.deleted_at IS NULL
         AND p.status IN ('active', 'on_leave', 'in_hospital')) THEN
    RAISE EXCEPTION 'A downtime pack has a page for everyone receiving care at the location'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
-- Sample data mode (migration 0069, HZ-072): as the highest migration of batch 3c this states the
-- union of every list (0069 to 0143): 0140's, with 0143's PRN outcomes and protocols first, as
-- children of the medicines they reference.
CREATE OR REPLACE FUNCTION app.sample_removal_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT ARRAY[
    'prn_outcome', 'prn_protocol',
    'covert_medication_record', 'self_administration_assessment', 'homely_remedy_administration',
    'outbreak_case', 'missing_event', 'missing_episode', 'medication_review',
    'medicine_stock_movement', 'medicine_disposal', 'medicine_order_line', 'medicine_stock_item',
    'controlled_drug_stock_check', 'controlled_drug_entry', 'controlled_drug_witness_assertion',
    'controlled_drug_page', 'medication_administration_witness',
    'medication_administration_conflict', 'medication_error', 'medication_administration',
    'medication_dosing_record', 'medication_reconciliation_decision',
    'medication_reconciliation_item', 'medication_reconciliation_source', 'medication_schedule',
    'medication', 'medication_reconciliation', 'dependency_assessment', 'about_me',
    'about_me_share_link', 'activity_record', 'admission_condition', 'advance_care_record',
    'allergy', 'assessment', 'bed_occupancy', 'body_map_mark', 'break_glass_event',
    'candour_record', 'care_note', 'care_plan_action', 'care_plan_change', 'consent_record',
    'document_signature', 'dols_legal_change_review', 'entry_device_deletion_flag',
    'exit_checklist_item', 'family_portal_user', 'feed_item_withdrawal', 'feed_view',
    'handover_note', 'incident_person', 'key_issue', 'legal_hold', 'letter',
    'notification_delivery', 'observation', 'person_assignment', 'person_care_profile',
    'property_item', 'refused_entry', 'sharing_decision_suspension', 'safeguarding_concern',
    'statutory_notification', 'visit_log', 'welcome_checklist_item', 'workflow_transition',
    'care_plan_section', 'dols_authorisation', 'death_step', 'death_record', 'exit_record',
    'feed_item', 'handover_item', 'hospital_transfer', 'notification', 'placement',
    'review_record', 'risk_assessment', 'sharing_decision', 'task', 'admission_decision',
    'best_interests_decision', 'care_plan', 'herbert_profile', 'ocr_field', 'ocr_extraction',
    'document', 'task_series', 'workflow_instance', 'capacity_assessment', 'contact',
    'pre_admission_assessment'
  ]::text[]
$$;
--> statement-breakpoint
-- The HR link (batch 3c security review): a withdrawal is refused once access has ended (migration
-- 0129 makes leaving final), so no reinstated leaver remains for 0142's relink path. The app may no
-- longer run it, and the leaver sweep does not call it. Both 0142 definer functions take pg_temp
-- last, as 0129's do.
REVOKE EXECUTE ON FUNCTION app.end_relinked_leaver_access(uuid) FROM harbour_app;
--> statement-breakpoint
ALTER FUNCTION app.end_relinked_leaver_access(uuid) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app.raise_hr_cover_need(uuid, uuid) SET search_path = pg_catalog, public, pg_temp;
