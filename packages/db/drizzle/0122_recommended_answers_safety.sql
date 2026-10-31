-- Recommended answers applied 31/10/2026 (review at testing), integration batch 2 safety items.
-- Runs as harbour_owner.

-- H-782: agency and bank workers who are not in Harbour go on an outbreak's line list as unnamed
-- staff cases: no person and no member id, nothing identifying, counted once each, so the UKHSA
-- report's staff figures are not understated.
ALTER TABLE "outbreak_case" DROP CONSTRAINT "outbreak_case_type";--> statement-breakpoint
ALTER TABLE "outbreak_case" ADD CONSTRAINT "outbreak_case_type" CHECK (case_type IN ('resident', 'staff', 'staff_unnamed'));--> statement-breakpoint
ALTER TABLE "outbreak_case" DROP CONSTRAINT "outbreak_case_subject";--> statement-breakpoint
ALTER TABLE "outbreak_case" ADD CONSTRAINT "outbreak_case_subject" CHECK ((case_type = 'resident' AND person_id IS NOT NULL AND tenant_user_id IS NULL)
        OR (case_type = 'staff' AND tenant_user_id IS NOT NULL AND person_id IS NULL)
        OR (case_type = 'staff_unnamed' AND tenant_user_id IS NULL AND person_id IS NULL));--> statement-breakpoint

-- The add guard as in migration 0093, with unnamed staff cases: they join an open outbreak like
-- any case, are never matched to another row (each is its own person), and an update supersedes
-- the same unnamed case.
CREATE OR REPLACE FUNCTION app.outbreak_case_add() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o public.outbreak;
  prior public.outbreak_case;
  today date := (now() AT TIME ZONE 'Europe/London')::date;
BEGIN
  SELECT * INTO o FROM public.outbreak WHERE id = NEW.outbreak_id;
  IF o.id IS NULL OR o.state <> 'declared' THEN
    RAISE EXCEPTION 'A case joins an open outbreak' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF greatest(NEW.onset_on, NEW.tested_on, NEW.outcome_on) > today THEN
    RAISE EXCEPTION 'A case is not dated in the future' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT * INTO prior FROM public.outbreak_case WHERE id = NEW.supersedes_id;
    IF prior.id IS NULL OR (prior.outbreak_id, prior.case_type, prior.person_id, prior.tenant_user_id)
       IS DISTINCT FROM (NEW.outbreak_id, NEW.case_type, NEW.person_id, NEW.tenant_user_id) THEN
      RAISE EXCEPTION 'An update supersedes the same person''s case on the same outbreak'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW.case_type = 'staff_unnamed' THEN
    NULL;
  ELSIF NEW.case_type = 'resident' AND NOT EXISTS (
       SELECT 1 FROM public.person p WHERE p.id = NEW.person_id AND p.location_id = o.location_id) THEN
    RAISE EXCEPTION 'A resident case is someone living at the outbreak''s location'
      USING ERRCODE = 'integrity_constraint_violation';
  ELSIF NEW.case_type = 'staff' AND NOT EXISTS (
       SELECT 1 FROM public.role_assignment ra
        WHERE ra.tenant_user_id = NEW.tenant_user_id
          AND (ra.location_id = o.location_id OR ra.location_id IS NULL)
          AND ra.valid_from <= now() AND (ra.valid_to IS NULL OR ra.valid_to > now())) THEN
    RAISE EXCEPTION 'A staff case is someone working at the outbreak''s location'
      USING ERRCODE = 'integrity_constraint_violation';
  ELSIF EXISTS (SELECT 1 FROM public.outbreak_case c
                 WHERE c.outbreak_id = NEW.outbreak_id
                   AND c.person_id IS NOT DISTINCT FROM NEW.person_id
                   AND c.tenant_user_id IS NOT DISTINCT FROM NEW.tenant_user_id) THEN
    RAISE EXCEPTION 'This person is already on the line list: update their case instead'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- HZ-127 (clinical review of the recommended answers, finding 2): one episode still searching per
-- person. A found episode waiting for its welfare check and debrief no longer stops a new episode
-- if the person goes missing again, so the police call task and the on-site alert are never lost.
DROP INDEX "missing_episode_one_open";--> statement-breakpoint
CREATE UNIQUE INDEX "missing_episode_one_open" ON "missing_episode" USING btree ("tenant_id","person_id") WHERE status = 'open' AND deleted_at IS NULL;--> statement-breakpoint

-- H-721: speak-up concerns get their own retention class, 6 years after the concern closes, rather
-- than the 10 years borrowed from complaints. Existing rows move to it: row-level security is lifted
-- for the owner and the versioning trigger paused for this one statement (as migrations 0021 to
-- 0023), because reclassifying is not a change a reader holding the current version should see.
ALTER TABLE "speak_up_concern" DROP CONSTRAINT "speak_up_concern_retention_class";--> statement-breakpoint
ALTER TABLE "speak_up_concern" ALTER COLUMN "retention_class" SET DEFAULT 'speak_up_concern';--> statement-breakpoint
ALTER TABLE public.speak_up_concern NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.speak_up_concern DISABLE TRIGGER touch_mutable;--> statement-breakpoint
UPDATE public.speak_up_concern SET retention_class = 'speak_up_concern' WHERE retention_class = 'complaint';--> statement-breakpoint
ALTER TABLE public.speak_up_concern ENABLE TRIGGER touch_mutable;--> statement-breakpoint
ALTER TABLE public.speak_up_concern FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "speak_up_concern" ADD CONSTRAINT "speak_up_concern_retention_class" CHECK (retention_class = 'speak_up_concern');
