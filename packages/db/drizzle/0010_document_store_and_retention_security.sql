-- Document store and retention security (ADR-0002 patterns). Runs as harbour_owner.

-- Documents about a person follow the person's scope. Existing documents have no person and stay
-- visible to the tenant as before; new person documents carry person_id (composite key below).
ALTER TABLE public.document
  ADD CONSTRAINT document_person_fk FOREIGN KEY (tenant_id, person_id)
  REFERENCES public.person (tenant_id, id);
--> statement-breakpoint
CREATE POLICY person_child_scope ON public.document AS RESTRICTIVE FOR ALL TO harbour_app, harbour_owner
  USING (person_id IS NULL OR app.person_visible(person_id))
  WITH CHECK (person_id IS NULL OR app.person_visible(person_id));
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['document_signature', 'legal_hold', 'destruction_certificate'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', t);
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE POLICY person_child_scope ON public.document_signature AS RESTRICTIVE FOR ALL
  TO harbour_app, harbour_owner
  USING (person_id IS NULL OR app.person_visible(person_id))
  WITH CHECK (person_id IS NULL OR app.person_visible(person_id));
--> statement-breakpoint

-- Legal holds and destruction certificates are records-management decisions: tenant-wide roles only.
CREATE POLICY tenant_wide_only ON public.legal_hold AS RESTRICTIVE FOR ALL TO harbour_app, harbour_owner
  USING (app.current_scope() = 'tenant') WITH CHECK (app.current_scope() = 'tenant');
--> statement-breakpoint
CREATE POLICY tenant_wide_only ON public.destruction_certificate AS RESTRICTIVE FOR ALL
  TO harbour_app, harbour_owner
  USING (app.current_scope() = 'tenant') WITH CHECK (app.current_scope() = 'tenant');
--> statement-breakpoint

CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.legal_hold
  FOR EACH ROW EXECUTE FUNCTION app.touch_mutable();
--> statement-breakpoint
CREATE TRIGGER capture_version AFTER UPDATE ON public.legal_hold
  FOR EACH ROW EXECUTE FUNCTION app.capture_version();
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['document_signature', 'destruction_certificate'] LOOP
    EXECUTE format(
      'CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
    EXECUTE format(
      'CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation()', t);
  END LOOP;
END
$$;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON public.legal_hold TO harbour_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.document_signature, public.destruction_certificate TO harbour_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON public.document_signature, public.destruction_certificate
  FROM harbour_app;
