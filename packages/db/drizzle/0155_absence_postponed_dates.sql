ALTER TABLE "absence" ADD COLUMN "postponed_from_id" uuid;--> statement-breakpoint
ALTER TABLE "absence" ADD CONSTRAINT "absence_postponed_from_fk" FOREIGN KEY ("tenant_id","postponed_from_id") REFERENCES "public"."absence"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "absence_postponed_from_key" ON "absence" USING btree ("tenant_id","postponed_from_id") WHERE postponed_from_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "absence" ADD CONSTRAINT "absence_postponed_from" CHECK (postponed_from_id IS NULL OR (kind IN ('carers_leave', 'parental_leave') AND source = 'harbour'));--> statement-breakpoint

-- Postponing carer's leave and unpaid parental leave to new dates (H-970; scheduling.md section 17
-- rule 1a; Carer's Leave Regulations 2024 reg 8; Maternity and Parental Leave etc. Regulations 1999
-- Sch 2 para 6). The request moves to `postponed` with the reason; the leave on the new dates is a
-- new absence, approved by the same approver in the same transaction and pointing back at the
-- request, so the rota, cover needs and timesheets treat it as any approved leave. The statutory
-- limits are the domain's (packages/domain/src/scheduling/absence.ts) from the rate table.
--
-- The statutory date limits on the replacement row (the same length, after the first day asked
-- for, no later than the rate table's months after it, notice within its days of the request) are
-- enforced by the domain and the API, not here: the database holds the link, its kinds, one per
-- request and who may write it. The postponing approver is accountable on both rows: `decided_by`
-- and `decided_at` on the postponed request and on the approved replacement are theirs, and each
-- row has its own audit event.
--
-- Who writes an absence: as migration 0142, plus the approver writing the leave on the new dates of
-- a request they have just postponed: the same member, home and kind, approved in their own name,
-- never the member's own. The roles are those 0151 gave every restrictive policy (ADR-0133).
DROP POLICY absence_insert ON public.absence;
--> statement-breakpoint
CREATE POLICY absence_insert ON public.absence AS RESTRICTIVE FOR INSERT
  TO harbour_app, harbour_owner, harbour_platform_definer, harbour_care_definer,
    harbour_workforce_definer, harbour_scheduling_definer, harbour_finance_definer
  WITH CHECK (
    (source = 'harbour' AND app.current_user_id() IS NOT NULL
      AND created_by = app.current_user_id()
      AND ((decided_by IS NULL AND postponed_from_id IS NULL
            AND ((state = 'requested' AND member_id = app.current_user_id()
                  AND app.holds_self_permission('scheduling.timesheet.self'))
              OR (state = 'recorded' AND member_id <> app.current_user_id()
                  AND app.holds_permission_at('scheduling.rota.manage', location_id))))
        OR (state = 'approved' AND postponed_from_id IS NOT NULL
            AND decided_by = app.current_user_id() AND member_id <> app.current_user_id()
            AND app.holds_permission_at('scheduling.rota.approve', location_id)
            AND EXISTS (SELECT 1 FROM public.absence o
              WHERE o.tenant_id = absence.tenant_id AND o.id = absence.postponed_from_id
                AND o.state = 'postponed' AND o.decided_by = app.current_user_id()
                AND o.member_id = absence.member_id AND o.location_id = absence.location_id
                AND o.kind = absence.kind))))
    OR (source = 'thapsus_hr' AND app.is_system() AND state = 'recorded' AND created_by IS NULL
      AND postponed_from_id IS NULL));
--> statement-breakpoint
-- The request a postponed leave replaces never changes.
CREATE OR REPLACE FUNCTION app.absence_postponed_from_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.postponed_from_id IS DISTINCT FROM OLD.postponed_from_id THEN
    RAISE EXCEPTION 'absence_postponed_from_fixed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER absence_postponed_from_guard BEFORE UPDATE ON public.absence
  FOR EACH ROW EXECUTE FUNCTION app.absence_postponed_from_guard();
