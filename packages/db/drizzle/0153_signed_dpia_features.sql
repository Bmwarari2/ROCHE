-- Employee monitoring only under a signed DPIA (H-1555; H-527, H-1033). Location or NFC clock-in
-- evidence and lone-worker location are used only when the organisation's signed DPIA lists them
-- among its features. The check runs in the request of whoever clocks in or checks in, and the
-- dpia_read policy shows the DPIA only to holders of a DPIA permission, so this narrow question is
-- answered by a definer: the signed version's id and the features its basis lists, nothing else
-- (no answers, no prefill, no signer). Owned by harbour_platform_definer (ADR-0133), which reads
-- only the four columns it needs; the organisation's own rows only (tenant_isolation).
CREATE FUNCTION app.signed_dpia_features()
RETURNS TABLE (dpia_id uuid, features text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT d.id,
         COALESCE(ARRAY(SELECT jsonb_array_elements_text(
                          CASE WHEN jsonb_typeof(d.basis -> 'features') = 'array'
                               THEN d.basis -> 'features' ELSE '[]'::jsonb END)),
                  ARRAY[]::text[])
    FROM public.dpia d
   WHERE d.tenant_id = app.current_tenant_id() AND d.status = 'signed'
   ORDER BY d.dpia_version DESC
   LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.signed_dpia_features() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.signed_dpia_features() TO harbour_app;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, dpia_version, status, basis) ON public.dpia TO harbour_platform_definer;
--> statement-breakpoint
-- A new owner needs CREATE on the schema for the change only (ADR-0002), as 0151 does.
GRANT CREATE ON SCHEMA app TO harbour_platform_definer;
--> statement-breakpoint
ALTER FUNCTION app.signed_dpia_features() OWNER TO harbour_platform_definer;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM harbour_platform_definer;
