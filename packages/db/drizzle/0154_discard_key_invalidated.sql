-- H-1531 (HZ-006): a device records when its key stopped opening its database and its unsent
-- entries were lost. A new discard kind, key_invalidated, which nobody chose and so has no coded
-- reason. Expand only: the reason becomes nullable for that kind alone; existing rows all have one.
-- Provisional number: the lead confirms it at merge.
ALTER TABLE "device_discard_record" DROP CONSTRAINT "device_discard_record_kind";--> statement-breakpoint
ALTER TABLE "device_discard_record" ALTER COLUMN "reason_code" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "device_discard_record" ADD CONSTRAINT "device_discard_record_reason" CHECK ((reason_code IS NULL) = (kind = 'key_invalidated'));--> statement-breakpoint
ALTER TABLE "device_discard_record" ADD CONSTRAINT "device_discard_record_kind" CHECK (kind IN ('held_deleted', 'signed_out_with_unsent', 'refused_removed', 'key_invalidated'));