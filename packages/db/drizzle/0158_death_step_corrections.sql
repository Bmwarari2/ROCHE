ALTER TABLE "death_step" ADD COLUMN "supersedes_id" uuid;--> statement-breakpoint
ALTER TABLE "death_step" ADD COLUMN "correction_reason" text;--> statement-breakpoint
ALTER TABLE "death_step" ADD CONSTRAINT "death_step_supersedes_fk" FOREIGN KEY ("tenant_id","supersedes_id") REFERENCES "public"."death_step"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "death_step_superseded_once" ON "death_step" USING btree ("tenant_id","supersedes_id") WHERE supersedes_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "death_step" ADD CONSTRAINT "death_step_correction" CHECK ((supersedes_id IS NULL) = (correction_reason IS NULL)
        AND (correction_reason IS NULL OR char_length(btrim(correction_reason)) BETWEEN 10 AND 500));--> statement-breakpoint
-- A correction to a step of a death (master prompt section 5.5; HZ-013): the superseded entry is
-- never changed (append_only); the correction names an entry of the same death and step, and a
-- step already recorded takes a new entry only as a correction. Entries recorded before this
-- migration (the latest for a step counted) stand as they are. Steps are recorded only on an open
-- record, and the record is locked first so two first entries for a step cannot both stand.
CREATE OR REPLACE FUNCTION app.death_step_correction_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_status text;
BEGIN
  SELECT r.status INTO v_status FROM public.death_record r
   WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.death_record_id
   FOR UPDATE;
  IF v_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'death_record_finished' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.supersedes_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.death_step s
        WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.supersedes_id
          AND s.death_record_id = NEW.death_record_id AND s.step = NEW.step) THEN
      RAISE EXCEPTION 'death_step_supersedes_other' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM public.death_step s
      WHERE s.tenant_id = NEW.tenant_id AND s.death_record_id = NEW.death_record_id
        AND s.step = NEW.step) THEN
    RAISE EXCEPTION 'death_step_correction_needed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER death_step_correction_guard BEFORE INSERT ON public.death_step
  FOR EACH ROW EXECUTE FUNCTION app.death_step_correction_guard();
