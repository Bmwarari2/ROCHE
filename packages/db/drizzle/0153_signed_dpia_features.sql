-- Employee monitoring only under a signed DPIA (H-1555; H-527, H-1033). Location or NFC clock-in
-- evidence and lone-worker location are used only when the organisation's signed DPIA lists them
-- among its features. The check runs in the request of whoever clocks in or checks in, and the
-- dpia_read policy shows the DPIA only to holders of a DPIA permission, so this narrow question is
-- answered by a definer: given one feature, the signed version's id when its basis lists that
-- feature, else NULL. Callers never read the basis, its other features, the answers, the prefill
-- or the signer. Owned by harbour_platform_definer (ADR-0133), which reads only the five columns
-- it needs; the organisation's own rows only (tenant_isolation).
CREATE FUNCTION app.signed_dpia_covers(p_flag text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT s.id
    FROM (SELECT d.id, d.basis
            FROM public.dpia d
           WHERE d.tenant_id = app.current_tenant_id() AND d.status = 'signed'
           ORDER BY d.dpia_version DESC
           LIMIT 1) s
   WHERE jsonb_typeof(s.basis -> 'features') = 'array'
     AND (s.basis -> 'features') ? p_flag
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.signed_dpia_covers(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.signed_dpia_covers(text) TO harbour_app;
--> statement-breakpoint
GRANT SELECT (tenant_id, id, dpia_version, status, basis) ON public.dpia TO harbour_platform_definer;
--> statement-breakpoint
-- A new owner needs CREATE on the schema for the change only (ADR-0002), as 0151 does.
GRANT CREATE ON SCHEMA app TO harbour_platform_definer;
--> statement-breakpoint
ALTER FUNCTION app.signed_dpia_covers(text) OWNER TO harbour_platform_definer;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM harbour_platform_definer;
