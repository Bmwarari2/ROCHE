CREATE TABLE "ldss_claim" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"tenant_user_id" uuid NOT NULL,
	"course_title" text NOT NULL,
	"completed_on" date,
	"claimed_amount" numeric(10, 2),
	"status" text DEFAULT 'planned' NOT NULL,
	"reference" text,
	"submitted_on" date,
	"paid_on" date,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "ldss_claim_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "ldss_claim_status" CHECK (status IN ('planned', 'submitted', 'paid', 'rejected', 'withdrawn')),
	CONSTRAINT "ldss_claim_amount" CHECK (claimed_amount IS NULL OR claimed_amount >= 0),
	CONSTRAINT "ldss_claim_states" CHECK ((status <> 'submitted' OR (reference IS NOT NULL AND submitted_on IS NOT NULL))
        AND (status <> 'paid' OR paid_on IS NOT NULL)
        AND (status NOT IN ('rejected', 'withdrawn') OR reason IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "sponsor_absence" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"sponsored_worker_id" uuid NOT NULL,
	"from_on" date NOT NULL,
	"to_on" date NOT NULL,
	"authorised" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "sponsor_absence_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "sponsor_absence_dates" CHECK (to_on >= from_on)
);
--> statement-breakpoint
CREATE TABLE "sponsor_report" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"sponsored_worker_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"happened_on" date NOT NULL,
	"reported_on" date,
	"sms_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "sponsor_report_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "sponsor_report_kind" CHECK (kind IN ('did_not_start', 'unauthorised_absence', 'employment_ended', 'change_of_job', 'change_of_salary', 'change_of_work_location', 'change_of_hours', 'other')),
	CONSTRAINT "sponsor_report_reported" CHECK ((reported_on IS NULL) = (sms_reference IS NULL) AND (reported_on IS NULL OR reported_on >= happened_on))
);
--> statement-breakpoint
CREATE TABLE "sponsored_worker" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"tenant_user_id" uuid NOT NULL,
	"cos_reference" text NOT NULL,
	"cos_assigned_on" date NOT NULL,
	"soc_code" text NOT NULL,
	"route" text NOT NULL,
	"visa_expires_on" date NOT NULL,
	"contracted_weekly_hours" numeric(5, 2) NOT NULL,
	"guaranteed_yearly_pay" numeric(10, 2) NOT NULL,
	"english_evidence" text DEFAULT 'not_recorded' NOT NULL,
	"switching_evidence_on" date,
	"appendix_d_held" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"ended_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "sponsored_worker_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "sponsored_worker_route" CHECK (route IN ('skilled_worker', 'health_and_care_worker', 'other')),
	CONSTRAINT "sponsored_worker_english" CHECK (english_evidence IN ('not_recorded', 'majority_english_speaking_country', 'degree_taught_in_english', 'secure_english_language_test', 'previous_grant')),
	CONSTRAINT "sponsored_worker_soc" CHECK (soc_code ~ '^[0-9]{4}$'),
	CONSTRAINT "sponsored_worker_hours" CHECK (contracted_weekly_hours > 0),
	CONSTRAINT "sponsored_worker_pay" CHECK (guaranteed_yearly_pay >= 0),
	CONSTRAINT "sponsored_worker_status" CHECK ((status = 'active' AND ended_on IS NULL) OR (status = 'ended' AND ended_on IS NOT NULL)),
	CONSTRAINT "sponsored_worker_appendix_d" CHECK (appendix_d_held <@ ARRAY['passport_or_travel_document', 'right_to_work_check', 'contact_details', 'certificate_of_sponsorship', 'recruitment_evidence', 'english_language_evidence', 'registration_or_qualification', 'absence_records']::text[])
);
--> statement-breakpoint
CREATE TABLE "staff_image_consent" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"tenant_user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"decision" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "staff_image_consent_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "staff_image_consent_purpose" CHECK (purpose IN ('newsletter', 'website', 'social_media', 'family_feed')),
	CONSTRAINT "staff_image_consent_decision" CHECK (decision IN ('given', 'refused', 'withdrawn'))
);
--> statement-breakpoint
CREATE TABLE "staff_privacy_acknowledgement" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"tenant_user_id" uuid NOT NULL,
	"notice_version" text NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "staff_privacy_acknowledgement_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "staff_privacy_acknowledgement_once_key" UNIQUE("tenant_id","tenant_user_id","notice_version"),
	CONSTRAINT "staff_privacy_acknowledgement_version" CHECK (length(btrim(notice_version)) BETWEEN 1 AND 40)
);
--> statement-breakpoint
ALTER TABLE "tenant" ADD COLUMN "staff_privacy_notice_version" text;--> statement-breakpoint
ALTER TABLE "ldss_claim" ADD CONSTRAINT "ldss_claim_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ldss_claim" ADD CONSTRAINT "ldss_claim_member_fk" FOREIGN KEY ("tenant_id","tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsor_absence" ADD CONSTRAINT "sponsor_absence_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsor_absence" ADD CONSTRAINT "sponsor_absence_worker_fk" FOREIGN KEY ("tenant_id","sponsored_worker_id") REFERENCES "public"."sponsored_worker"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsor_report" ADD CONSTRAINT "sponsor_report_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsor_report" ADD CONSTRAINT "sponsor_report_worker_fk" FOREIGN KEY ("tenant_id","sponsored_worker_id") REFERENCES "public"."sponsored_worker"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsored_worker" ADD CONSTRAINT "sponsored_worker_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsored_worker" ADD CONSTRAINT "sponsored_worker_member_fk" FOREIGN KEY ("tenant_id","tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_image_consent" ADD CONSTRAINT "staff_image_consent_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_image_consent" ADD CONSTRAINT "staff_image_consent_member_fk" FOREIGN KEY ("tenant_id","tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_privacy_acknowledgement" ADD CONSTRAINT "staff_privacy_acknowledgement_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_privacy_acknowledgement" ADD CONSTRAINT "staff_privacy_acknowledgement_member_fk" FOREIGN KEY ("tenant_id","tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ldss_claim_tenant_status_idx" ON "ldss_claim" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "sponsor_absence_worker_idx" ON "sponsor_absence" USING btree ("tenant_id","sponsored_worker_id");--> statement-breakpoint
CREATE INDEX "sponsor_report_worker_idx" ON "sponsor_report" USING btree ("tenant_id","sponsored_worker_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sponsored_worker_one_active_key" ON "sponsored_worker" USING btree ("tenant_id","tenant_user_id") WHERE status = 'active' AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "staff_image_consent_member_idx" ON "staff_image_consent" USING btree ("tenant_id","tenant_user_id");--> statement-breakpoint
-- Security (ADR-0002; workforce.md section 12; slice 35): forced RLS and the tenant policy on every
-- table. Sponsor licence records are HR only and never one's own (section 12.4); a member's privacy
-- notice acknowledgements and image consent decisions are their own to make; LDSS claims are kept by
-- holders of workforce.ldss.manage. The organisation's own system context (app.is_system) reads them
-- all, so the full export and the DSAR collector include them. No DELETE for harbour_app.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sponsored_worker', 'sponsor_absence', 'sponsor_report',
      'staff_privacy_acknowledgement', 'staff_image_consent', 'ldss_claim'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['sponsored_worker', 'sponsor_absence', 'sponsor_report', 'ldss_claim'] LOOP
    EXECUTE format('CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.touch_mutable()', t);
    EXECUTE format('CREATE TRIGGER capture_version AFTER UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.capture_version()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['staff_privacy_acknowledgement', 'staff_image_consent'] LOOP
    EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
    EXECUTE format('CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation()', t);
    EXECUTE format('REVOKE UPDATE ON public.%I FROM harbour_app', t);
  END LOOP;
END
$$;
--> statement-breakpoint
-- The member a sponsor record is about, read under the caller's own policies.
CREATE OR REPLACE FUNCTION app.sponsored_worker_member(p_worker uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT w.tenant_user_id FROM public.sponsored_worker w WHERE w.id = p_worker
$$;
--> statement-breakpoint
CREATE POLICY sponsored_worker_read ON public.sponsored_worker AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (app.is_system()
    OR (app.holds_staff_permission('workforce.immigration.read')
        AND tenant_user_id IS DISTINCT FROM app.current_user_id()));
--> statement-breakpoint
CREATE POLICY sponsored_worker_write ON public.sponsored_worker AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (app.holds_staff_permission('workforce.sponsor.manage')
    AND tenant_user_id IS DISTINCT FROM app.current_user_id());
--> statement-breakpoint
CREATE POLICY sponsored_worker_change ON public.sponsored_worker AS RESTRICTIVE FOR UPDATE TO harbour_app
  USING (app.holds_staff_permission('workforce.sponsor.manage')
    AND tenant_user_id IS DISTINCT FROM app.current_user_id())
  WITH CHECK (app.holds_staff_permission('workforce.sponsor.manage')
    AND tenant_user_id IS DISTINCT FROM app.current_user_id());
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sponsor_absence', 'sponsor_report'] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR SELECT TO harbour_app USING (app.is_system() '
      'OR (app.holds_staff_permission(''workforce.immigration.read'') '
      'AND app.sponsored_worker_member(sponsored_worker_id) IS DISTINCT FROM app.current_user_id()))',
      t || '_read', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR INSERT TO harbour_app WITH CHECK ('
      'app.holds_staff_permission(''workforce.sponsor.manage'') '
      'AND app.sponsored_worker_member(sponsored_worker_id) IS DISTINCT FROM app.current_user_id())',
      t || '_write', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR UPDATE TO harbour_app USING ('
      'app.holds_staff_permission(''workforce.sponsor.manage'') '
      'AND app.sponsored_worker_member(sponsored_worker_id) IS DISTINCT FROM app.current_user_id()) '
      'WITH CHECK (app.holds_staff_permission(''workforce.sponsor.manage'') '
      'AND app.sponsored_worker_member(sponsored_worker_id) IS DISTINCT FROM app.current_user_id())',
      t || '_change', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['staff_privacy_acknowledgement', 'staff_image_consent'] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR SELECT TO harbour_app USING (app.is_system() '
      'OR tenant_user_id = app.current_user_id() '
      'OR app.holds_staff_permission(''workforce.staff_file.read''))',
      t || '_read', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR INSERT TO harbour_app '
      'WITH CHECK (tenant_user_id = app.current_user_id())',
      t || '_own', t);
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE POLICY ldss_claim_read ON public.ldss_claim AS RESTRICTIVE FOR SELECT TO harbour_app
  USING (app.is_system() OR tenant_user_id = app.current_user_id()
    OR app.holds_staff_permission('workforce.ldss.manage'));
--> statement-breakpoint
CREATE POLICY ldss_claim_write ON public.ldss_claim AS RESTRICTIVE FOR INSERT TO harbour_app
  WITH CHECK (app.holds_staff_permission('workforce.ldss.manage'));
--> statement-breakpoint
CREATE POLICY ldss_claim_change ON public.ldss_claim AS RESTRICTIVE FOR UPDATE TO harbour_app
  USING (app.holds_staff_permission('workforce.ldss.manage'))
  WITH CHECK (app.holds_staff_permission('workforce.ldss.manage'));
--> statement-breakpoint
-- Earlier versions of sponsor records follow the same rule (as record_version_staff_file, 0073).
CREATE POLICY record_version_sponsor ON public.record_version AS RESTRICTIVE FOR SELECT
  TO harbour_app
  USING (table_name NOT IN ('sponsored_worker', 'sponsor_absence', 'sponsor_report')
    OR app.is_system() OR app.holds_staff_permission('workforce.immigration.read'));
