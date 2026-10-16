-- Slice 11 part 3 (operations.md section 12): the system rebuilds a location's downtime pack after
-- someone moves in, out or away, as `server_rebuild`, with no member, like the nightly pack; and a
-- pack never names a stored document, as its PDF is drawn per request (#45 review round 1).
-- Numbered 0055 after #48's 0054. Runs as harbour_owner.
ALTER TABLE "downtime_pack" DROP CONSTRAINT "downtime_pack_source";--> statement-breakpoint
ALTER TABLE "downtime_pack" DROP CONSTRAINT "downtime_pack_generated_by";--> statement-breakpoint
ALTER TABLE "downtime_pack" ADD CONSTRAINT "downtime_pack_no_document" CHECK (document_id IS NULL);--> statement-breakpoint
ALTER TABLE "downtime_pack" ADD CONSTRAINT "downtime_pack_source" CHECK (source IN ('server_nightly', 'server_rebuild', 'server_on_demand', 'kiosk_cache'));--> statement-breakpoint
ALTER TABLE "downtime_pack" ADD CONSTRAINT "downtime_pack_generated_by" CHECK ((source IN ('server_nightly', 'server_rebuild')) = (generated_by IS NULL));