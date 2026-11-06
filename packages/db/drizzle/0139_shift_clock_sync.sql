-- Own shifts and clock events on the phone (Phase 2 slice 71; scheduling.md section 18; hazards
-- HZ-010, HZ-124, HZ-125): the tables the `my_shifts` and `my_clock_events` sync streams read join
-- the powersync publication, the ADR-0002 pattern of migrations 0012, 0017 and 0052. Runs as
-- harbour_owner. The sync role reads them for replication only (SELECT, no other grant); which
-- rows reach a device is decided by the streams in packages/sync (a member's own published,
-- uncancelled shifts and their own clock events, in the token's shift days), proven per member
-- and tenant in packages/sync/test/shift-streams.test.ts, because logical replication bypasses
-- row-level security and the initial snapshot is this plain SELECT. Every other policy on these
-- tables targets harbour_app and harbour_owner, so the API's reads are unchanged. No lone-worker
-- table syncs: the phone reads its session through the API, which never shows a duress press.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shift', 'shift_assignment', 'clock_event'] LOOP
    EXECUTE format(
      'CREATE POLICY sync_replication_read ON public.%I AS PERMISSIVE FOR SELECT TO harbour_sync '
      'USING (true)', t);
  END LOOP;
END
$$;
--> statement-breakpoint
GRANT SELECT ON public.shift, public.shift_assignment, public.clock_event TO harbour_sync;
--> statement-breakpoint
ALTER PUBLICATION powersync ADD TABLE public.shift, public.shift_assignment, public.clock_event;

--> statement-breakpoint
-- Sample data mode (migration 0069, HZ-072), batch 3b: the highest migration states the union of
-- every list, children before the tables they reference, so a table one branch added is never
-- left out by another branch's redefinition (0123 to 0138 each redefined it).
CREATE OR REPLACE FUNCTION app.sample_removal_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT ARRAY[
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
