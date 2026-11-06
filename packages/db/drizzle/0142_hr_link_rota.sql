-- Slice 88 (INTG-014, SCHED-002, SCHED-004, SCHED-010; integrations.md section 11.3; ADR-0126):
-- absences from the provider's Thapsus-HR tenant become read-only copies in `absence` (source
-- thapsus_hr, dates and type only), written by the link's sync alone; their cover needs are raised
-- by the sync; and the HR delivery log keeps a digest of what each shift last sent. Expand-only.
ALTER TABLE "absence" ADD COLUMN "source" text DEFAULT 'harbour' NOT NULL;
--> statement-breakpoint
ALTER TABLE "absence" ADD COLUMN "hr_id" text;
--> statement-breakpoint
ALTER TABLE "absence" ADD CONSTRAINT "absence_source" CHECK (source IN ('harbour', 'thapsus_hr') AND (source = 'thapsus_hr') = (hr_id IS NOT NULL)
        AND (hr_id IS NULL OR hr_id ~ '^[A-Za-z0-9_-]{1,64}$')
        AND (source = 'harbour' OR (kind IN ('annual_leave', 'sickness', 'other')
          AND state IN ('recorded', 'cancelled') AND decided_by IS NULL AND self_certified_at IS NULL
          AND bradford_excluded_reason IS NULL)));
--> statement-breakpoint
CREATE UNIQUE INDEX "absence_hr_key" ON "absence" USING btree ("tenant_id","hr_id") WHERE hr_id IS NOT NULL AND state <> 'cancelled';
--> statement-breakpoint
ALTER TABLE "hr_delivery" ADD COLUMN "payload_sha256" text;
--> statement-breakpoint
ALTER TABLE "hr_delivery" ADD CONSTRAINT "hr_delivery_payload" CHECK (payload_sha256 IS NULL OR payload_sha256 ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
-- Who writes an absence: a member or a rota manager as before, for this product's own absences
-- only; the link's sync (the organisation's system context, no member) for Thapsus-HR's, recorded
-- with no decider. A person never changes a Thapsus-HR copy: it is corrected in Thapsus-HR (rule 2).
DROP POLICY absence_insert ON public.absence;
--> statement-breakpoint
CREATE POLICY absence_insert ON public.absence AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (
    (source = 'harbour' AND app.current_user_id() IS NOT NULL
      AND decided_by IS NULL AND created_by = app.current_user_id()
      AND ((state = 'requested' AND member_id = app.current_user_id()
            AND app.holds_self_permission('scheduling.timesheet.self'))
        OR (state = 'recorded' AND member_id <> app.current_user_id()
            AND app.holds_permission_at('scheduling.rota.manage', location_id))))
    OR (source = 'thapsus_hr' AND app.is_system() AND state = 'recorded' AND created_by IS NULL));
--> statement-breakpoint
DROP POLICY absence_update ON public.absence;
--> statement-breakpoint
CREATE POLICY absence_update ON public.absence AS RESTRICTIVE FOR UPDATE
  TO harbour_app, harbour_owner
  USING (
    (source = 'harbour' AND app.current_user_id() IS NOT NULL AND (
      (member_id = app.current_user_id() AND app.holds_self_permission('scheduling.timesheet.self'))
      OR app.holds_permission_at('scheduling.rota.manage', location_id)
      OR app.holds_permission_at('scheduling.rota.approve', location_id)))
    OR (source = 'thapsus_hr' AND app.is_system()))
  WITH CHECK (
    (source = 'harbour' AND app.current_user_id() IS NOT NULL)
    OR (source = 'thapsus_hr' AND app.is_system()));
--> statement-breakpoint
-- Where an absence came from never changes.
CREATE OR REPLACE FUNCTION app.absence_source_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.source IS DISTINCT FROM OLD.source OR NEW.hr_id IS DISTINCT FROM OLD.hr_id THEN
    RAISE EXCEPTION 'absence_source_fixed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER absence_source_guard BEFORE UPDATE ON public.absence
  FOR EACH ROW EXECUTE FUNCTION app.absence_source_guard();
--> statement-breakpoint
-- HZ-123: a cover need for a Thapsus-HR absence, raised by the link's sync (no member), as
-- app.raise_cover_need is for a person: only for a recorded Thapsus-HR absence and the absent
-- member's own live assignment. Returns the new need's id, or null when one is already open.
CREATE OR REPLACE FUNCTION app.raise_hr_cover_need(p_assignment_id uuid, p_absence_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  a public.absence%ROWTYPE;
  sa public.shift_assignment%ROWTYPE;
  made uuid;
  raised integer;
BEGIN
  IF NOT app.is_system() THEN
    RAISE EXCEPTION 'cover_need_not_allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO a FROM public.absence
    WHERE tenant_id = app.current_tenant_id() AND id = p_absence_id;
  IF NOT FOUND OR a.source <> 'thapsus_hr' OR a.state <> 'recorded' THEN
    RAISE EXCEPTION 'cover_need_not_allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO sa FROM public.shift_assignment
    WHERE tenant_id = a.tenant_id AND id = p_assignment_id AND deleted_at IS NULL;
  IF NOT FOUND OR sa.worker_id <> a.member_id THEN
    RAISE EXCEPTION 'cover_need_not_allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  made := app.uuid_v7();
  INSERT INTO public.shift_cover_need (id, tenant_id, shift_id, assignment_id, absence_id, location_id, created_by)
    VALUES (made, a.tenant_id, sa.shift_id, sa.id, a.id, sa.location_id, NULL)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS raised = ROW_COUNT;
  IF raised = 0 THEN
    made := NULL;
  END IF;
  UPDATE public.shift SET changed_after_publish_at = now()
    WHERE tenant_id = a.tenant_id AND id = sa.shift_id AND published_at IS NOT NULL;
  RETURN made;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.raise_hr_cover_need(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.raise_hr_cover_need(uuid, uuid) TO harbour_app;
--> statement-breakpoint
-- Cover needs (HZ-123): as migration 0107 for a person; and, for a Thapsus-HR absence only, the
-- link's sync raises them (through app.raise_hr_cover_need) and resolves them when the absence is
-- cut short, cancelled or no longer listed.
DROP POLICY cover_insert ON public.shift_cover_need;
--> statement-breakpoint
CREATE POLICY cover_insert ON public.shift_cover_need AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner
  WITH CHECK (resolved_at IS NULL
    AND EXISTS (SELECT 1 FROM public.absence a
      JOIN public.shift_assignment sa ON sa.tenant_id = a.tenant_id AND sa.id = shift_cover_need.assignment_id
      WHERE a.tenant_id = shift_cover_need.tenant_id AND a.id = shift_cover_need.absence_id
        AND sa.worker_id = a.member_id AND sa.shift_id = shift_cover_need.shift_id
        AND sa.location_id = shift_cover_need.location_id
        AND a.state IN ('approved', 'recorded')
        AND ((app.current_user_id() IS NOT NULL
              AND (app.holds_permission_at('scheduling.rota.approve', a.location_id)
                OR app.holds_permission_at('scheduling.rota.manage', a.location_id)))
          OR (app.is_system() AND a.source = 'thapsus_hr'))));
--> statement-breakpoint
DROP POLICY cover_update ON public.shift_cover_need;
--> statement-breakpoint
CREATE POLICY cover_update ON public.shift_cover_need AS RESTRICTIVE FOR UPDATE
  TO harbour_app, harbour_owner
  USING ((app.current_user_id() IS NOT NULL AND (app.manages_rota(location_id)
    OR app.holds_permission_at('scheduling.rota.approve', location_id)
    OR EXISTS (SELECT 1 FROM public.absence a WHERE a.tenant_id = shift_cover_need.tenant_id
      AND a.id = shift_cover_need.absence_id
      AND (app.holds_permission_at('scheduling.rota.manage', a.location_id)
        OR app.holds_permission_at('scheduling.rota.approve', a.location_id)))))
    OR (app.is_system() AND EXISTS (SELECT 1 FROM public.absence a
      WHERE a.tenant_id = shift_cover_need.tenant_id AND a.id = shift_cover_need.absence_id
        AND a.source = 'thapsus_hr')))
  WITH CHECK (app.current_user_id() IS NOT NULL OR app.is_system());
