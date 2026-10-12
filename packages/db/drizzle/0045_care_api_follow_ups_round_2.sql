ALTER TABLE "entry_device_deletion_flag" DROP CONSTRAINT "entry_device_deletion_flag_entry_key";--> statement-breakpoint
ALTER TABLE "body_map_mark" ADD COLUMN "drawn_from_device_side" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "entry_device_deletion_flag" ADD CONSTRAINT "entry_device_deletion_flag_entry_key" UNIQUE("tenant_id","record_table","entry_id");--> statement-breakpoint
ALTER TABLE "body_map_mark" ADD CONSTRAINT "body_map_mark_drawn_from_device_side" CHECK (NOT drawn_from_device_side OR (drawn_zone IS NOT NULL AND drawn_x IS NULL));