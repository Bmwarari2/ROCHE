-- Break-glass search records (platform-completions.md rule 9 and section 6; HZ-011). Numbered
-- after 0067 to 0069 (other lanes), which merge first. Expand only: a `kind` for each break-glass
-- record, and no person for a search, whose people shown are in its audit event. A search's
-- `expires_at` is when it ran, so it can never widen anyone's access through the break-glass scope.
-- Small table, metadata-only changes and a CHECK scan: no maintenance window needed.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "break_glass_event" ALTER COLUMN "person_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "break_glass_event" ADD COLUMN "kind" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "break_glass_event" ADD CONSTRAINT "break_glass_kind" CHECK (kind IN ('open', 'search') AND (kind = 'open') = (person_id IS NOT NULL)
        AND (kind = 'open' OR expires_at = opened_at));