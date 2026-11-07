ALTER TABLE "disclosure_request" ADD COLUMN "prevention_extended_to" date;--> statement-breakpoint
ALTER TABLE "disclosure_request" ADD CONSTRAINT "disclosure_request_prevention_extension" CHECK (prevention_extended_to IS NULL OR (prevention_report_on IS NOT NULL AND prevention_extended_to > prevention_report_on));--> statement-breakpoint
-- The guard on disclosure requests (migration 0124), with the coroner's extension of the
-- Regulation 28 response among the dates a released, refused or withdrawn request may still record.
CREATE OR REPLACE FUNCTION app.disclosure_request_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_me uuid := app.current_user_id();
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.legal_basis IS DISTINCT FROM OLD.legal_basis
     OR NEW.received_at IS DISTINCT FROM OLD.received_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'disclosure_fixed_fields' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state IN ('released', 'refused', 'withdrawn')
     AND (to_jsonb(NEW) - ARRAY['prevention_report_on', 'prevention_responded_on', 'prevention_extended_to',
            'updated_at',
            'updated_by', 'version', 'pack_downloaded_at', 'pack_downloaded_by', 'handed_over_at',
            'handed_over_by', 'handed_over_route', 'handed_over_reference'])
         IS DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['prevention_report_on', 'prevention_responded_on', 'prevention_extended_to',
            'updated_at',
            'updated_by', 'version', 'pack_downloaded_at', 'pack_downloaded_by', 'handed_over_at',
            'handed_over_by', 'handed_over_route', 'handed_over_reference']) THEN
    RAISE EXCEPTION 'disclosure_closed' USING ERRCODE = 'check_violation';
  END IF;
  -- The pack is downloaded once, and its hand-over recorded once, each in the member's own name
  -- (H-958): neither is changed or cleared afterwards.
  IF OLD.pack_downloaded_at IS NOT NULL AND (NEW.pack_downloaded_at IS DISTINCT FROM OLD.pack_downloaded_at
       OR NEW.pack_downloaded_by IS DISTINCT FROM OLD.pack_downloaded_by) THEN
    RAISE EXCEPTION 'disclosure_pack_already_downloaded' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.pack_downloaded_at IS NULL AND NEW.pack_downloaded_at IS NOT NULL
     AND NEW.pack_downloaded_by IS DISTINCT FROM v_me THEN
    RAISE EXCEPTION 'disclosure_downloader_not_you' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.handed_over_at IS NOT NULL AND (NEW.handed_over_at IS DISTINCT FROM OLD.handed_over_at
       OR NEW.handed_over_by IS DISTINCT FROM OLD.handed_over_by
       OR NEW.handed_over_route IS DISTINCT FROM OLD.handed_over_route
       OR NEW.handed_over_reference IS DISTINCT FROM OLD.handed_over_reference) THEN
    RAISE EXCEPTION 'disclosure_already_handed_over' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.handed_over_at IS NULL AND NEW.handed_over_at IS NOT NULL
     AND NEW.handed_over_by IS DISTINCT FROM v_me THEN
    RAISE EXCEPTION 'disclosure_hand_over_not_you' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.prepared_at IS DISTINCT FROM OLD.prepared_at AND NEW.prepared_by IS DISTINCT FROM v_me THEN
    RAISE EXCEPTION 'disclosure_preparer_not_you' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.decided_at IS DISTINCT FROM OLD.decided_at AND (NEW.decided_by IS DISTINCT FROM v_me
       OR NOT app.holds_role_permission_at('safety.disclosure.approve', NEW.location_id)) THEN
    RAISE EXCEPTION 'disclosure_approver_not_you' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.released_at IS DISTINCT FROM OLD.released_at AND NEW.released_by IS DISTINCT FROM v_me THEN
    RAISE EXCEPTION 'disclosure_releaser_not_you' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
