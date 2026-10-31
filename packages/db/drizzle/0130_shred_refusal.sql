-- A shred request can be refused (PLAT-012 part 2; platform.md, Crypto-shredding screens rule 9).
-- A different member from the requester refuses a pending request within 7 days, with a reason
-- of at least 10 characters; a refusal is final. Expand only: a new nullable column and a wider
-- status list, so the previous release (which never refuses) keeps working.

ALTER TABLE "tenant_shred_request" ADD COLUMN "decision_reason" text;--> statement-breakpoint
ALTER TABLE "tenant_shred_request" DROP CONSTRAINT "tenant_shred_request_status";--> statement-breakpoint
ALTER TABLE "tenant_shred_request" ADD CONSTRAINT "tenant_shred_request_status"
  CHECK (status IN ('pending', 'shredding', 'approved', 'cancelled', 'refused'));--> statement-breakpoint
-- A refusal is another person's, decided, with its reason; nothing else carries a reason.
ALTER TABLE "tenant_shred_request" ADD CONSTRAINT "tenant_shred_request_refusal"
  CHECK ((status = 'refused') = (decision_reason IS NOT NULL)
    AND (status <> 'refused' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL
      AND decided_by <> requested_by AND char_length(btrim(decision_reason)) BETWEEN 10 AND 500)));
--> statement-breakpoint
DROP POLICY tenant_shred_request_decide ON public.tenant_shred_request;
--> statement-breakpoint
-- As migration 0117, plus: a refusal is never the requester's and only within 7 days.
CREATE POLICY tenant_shred_request_decide ON public.tenant_shred_request AS RESTRICTIVE FOR UPDATE
  TO harbour_app, harbour_owner
  USING (status IN ('pending', 'shredding'))
  WITH CHECK (decided_by = app.current_user_id()
    AND (status <> 'shredding' OR requested_at > now() - interval '7 days')
    AND (status <> 'cancelled' OR decided_by = requested_by OR requested_at <= now() - interval '7 days')
    AND (status <> 'refused' OR (decided_by <> requested_by AND requested_at > now() - interval '7 days')));
--> statement-breakpoint
GRANT UPDATE (decision_reason) ON public.tenant_shred_request TO harbour_app;
--> statement-breakpoint
-- The guard of migration 0117, plus: pending may move to refused (with its reason); a reason is
-- never given to any other decision, and never changes.
CREATE OR REPLACE FUNCTION app.tenant_shred_request_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.tenant_id, NEW.reason, NEW.export_id, NEW.requested_by, NEW.requested_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.reason, OLD.export_id, OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'A shred request''s requester and reason never change'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'pending' AND NEW.status = 'refused' THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'pending' AND NEW.status IN ('shredding', 'cancelled')
     AND NEW.decision_reason IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'shredding' AND NEW.status = 'approved'
     AND (NEW.decided_by, NEW.decided_at, NEW.decision_reason)
       IS NOT DISTINCT FROM (OLD.decided_by, OLD.decided_at, OLD.decision_reason) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A decided shred request never changes' USING ERRCODE = 'insufficient_privilege';
END
$$;
