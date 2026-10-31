-- H-958: the issued disclosure pack is downloaded once as a PDF and its hand-over to the recipient
-- recorded once, each in the member's own name. Moved out of migration 0103, which is on main.
ALTER TABLE "disclosure_request" ADD COLUMN "pack_downloaded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "disclosure_request" ADD COLUMN "pack_downloaded_by" uuid;--> statement-breakpoint
ALTER TABLE "disclosure_request" ADD COLUMN "handed_over_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "disclosure_request" ADD COLUMN "handed_over_by" uuid;--> statement-breakpoint
ALTER TABLE "disclosure_request" ADD COLUMN "handed_over_route" text;--> statement-breakpoint
ALTER TABLE "disclosure_request" ADD COLUMN "handed_over_reference" text;--> statement-breakpoint
ALTER TABLE "disclosure_request" ADD CONSTRAINT "disclosure_request_pack_downloaded_by_fk" FOREIGN KEY ("tenant_id","pack_downloaded_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disclosure_request" ADD CONSTRAINT "disclosure_request_handed_over_by_fk" FOREIGN KEY ("tenant_id","handed_over_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disclosure_request" ADD CONSTRAINT "disclosure_request_download" CHECK ((pack_downloaded_at IS NULL) = (pack_downloaded_by IS NULL)
        AND (pack_downloaded_at IS NULL OR state = 'released'));--> statement-breakpoint
ALTER TABLE "disclosure_request" ADD CONSTRAINT "disclosure_request_hand_over" CHECK ((handed_over_at IS NULL) = (handed_over_by IS NULL)
        AND (handed_over_at IS NULL) = (handed_over_route IS NULL)
        AND (handed_over_at IS NULL OR (state = 'released' AND handed_over_at >= released_at))
        AND (handed_over_route IS NULL OR handed_over_route IN ('secure_portal', 'secure_email', 'encrypted_media', 'in_person', 'recorded_delivery'))
        AND (handed_over_reference IS NULL OR char_length(btrim(handed_over_reference)) BETWEEN 1 AND 200));--> statement-breakpoint
-- Rules 38 to 43: who, where, what and when it was asked never change; each step is taken by the
-- person recording it, approval only with safety.disclosure.approve; once released, refused or
-- withdrawn only a coroner's Regulation 28 dates, the pack's one download and its one hand-over may
-- still be recorded (H-958).
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
     AND (to_jsonb(NEW) - ARRAY['prevention_report_on', 'prevention_responded_on', 'updated_at',
            'updated_by', 'version', 'pack_downloaded_at', 'pack_downloaded_by', 'handed_over_at',
            'handed_over_by', 'handed_over_route', 'handed_over_reference'])
         IS DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['prevention_report_on', 'prevention_responded_on', 'updated_at',
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
