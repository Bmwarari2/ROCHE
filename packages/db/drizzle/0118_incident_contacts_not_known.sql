-- Whether the emergency services were called and whether the GP was contacted may be recorded as
-- "Not known yet" (null) on an incident (recommended answer to H-264, 31/10/2026; HZ-090): the
-- question stays open, with a task for the person in charge, and the reporter is never pushed to
-- guess yes or no. Expand only: the default stays false, so an earlier API or app that sends a yes
-- or no keeps working, and nothing already stored changes.
ALTER TABLE "incident" ALTER COLUMN "emergency_services_called" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "incident" ALTER COLUMN "gp_contacted" DROP NOT NULL;

--> statement-breakpoint
-- Batch 3a's highest migration states the sample removal list once more, as the union of every
-- branch's list (migration 0111's, which keeps 0099's death, missing person and outbreak tables
-- and adds the medicines record), so the batch ends on one definition.
CREATE OR REPLACE FUNCTION app.sample_removal_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT ARRAY[
    'death_step', 'missing_event', 'death_record', 'missing_episode', 'herbert_profile',
    'outbreak_case',
    'medication_reconciliation_decision', 'medication_reconciliation_item',
    'medication_reconciliation_source', 'medication_schedule', 'medication',
    'medication_reconciliation',
    'dependency_assessment',
    'about_me', 'about_me_share_link', 'activity_record', 'admission_condition',
    'advance_care_record', 'allergy', 'assessment', 'bed_occupancy', 'body_map_mark',
    'break_glass_event', 'candour_record', 'care_note', 'care_plan_action', 'care_plan_change',
    'consent_record', 'document_signature', 'dols_legal_change_review',
    'entry_device_deletion_flag', 'exit_checklist_item', 'family_portal_user',
    'feed_item_withdrawal', 'feed_view', 'handover_note', 'incident_person', 'key_issue',
    'legal_hold', 'letter', 'notification_delivery', 'observation', 'person_assignment',
    'person_care_profile', 'property_item', 'refused_entry', 'sharing_decision_suspension',
    'safeguarding_concern', 'statutory_notification', 'visit_log', 'welcome_checklist_item', 'workflow_transition',
    'care_plan_section', 'dols_authorisation', 'exit_record', 'feed_item', 'handover_item',
    'hospital_transfer', 'notification', 'placement', 'review_record', 'risk_assessment',
    'sharing_decision', 'task', 'admission_decision', 'best_interests_decision', 'care_plan',
    'document', 'task_series', 'workflow_instance', 'capacity_assessment', 'contact',
    'pre_admission_assessment'
  ]::text[]
$$;
--> statement-breakpoint
-- The agency access window (ADR-0088, migration 0104) also binds the definer owners that read
-- role rows to decide a permission (batch 3a security review): an agency worker's role stops
-- counting inside a definer function once their window closes, as it does for the API.
GRANT EXECUTE ON FUNCTION app.member_is_agency(uuid), app.agency_access_open(uuid, uuid)
  TO harbour_sample_owner, harbour_silo_owner, harbour_import_owner, harbour_wellbeing_owner,
     harbour_quality_reader, harbour_invitation_owner;
--> statement-breakpoint
ALTER POLICY agency_window ON public.role_assignment
  TO harbour_app, harbour_owner, harbour_sample_owner, harbour_silo_owner, harbour_import_owner,
     harbour_wellbeing_owner, harbour_quality_reader, harbour_invitation_owner;
--> statement-breakpoint
ALTER POLICY agency_window ON public.access_grant
  TO harbour_app, harbour_owner, harbour_sample_owner, harbour_silo_owner, harbour_import_owner,
     harbour_wellbeing_owner, harbour_quality_reader, harbour_invitation_owner;
