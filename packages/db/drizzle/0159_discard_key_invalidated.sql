-- H-1531 (HZ-006): a phone records when its key stopped opening its database and its unsent
-- entries were lost. A new discard kind, key_invalidated, written only by the server's key-lost
-- route: no staff reason (reason_code null for that kind alone) and a system cause instead. Its
-- review task joins the open sync-task index, so a replay never raises a second. Expand only:
-- every existing row has a reason and an older kind. Both tables are small at this phase, so
-- the checks and the index are built in the migration's own transaction.
-- One lost-key record per lost database (its device id), so a retry under another id finds it.
-- Numbered 0159 after main's 0158 (first written as a provisional 0154).
ALTER TABLE "device_discard_record" DROP CONSTRAINT "device_discard_record_kind";--> statement-breakpoint
ALTER TABLE "device_discard_record" ALTER COLUMN "reason_code" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "device_discard_record" ADD COLUMN "cause" text;--> statement-breakpoint
ALTER TABLE "device_discard_record" ADD CONSTRAINT "device_discard_record_kind" CHECK (kind IN ('held_deleted', 'signed_out_with_unsent', 'refused_removed', 'key_invalidated'));--> statement-breakpoint
ALTER TABLE "device_discard_record" ADD CONSTRAINT "device_discard_record_reason" CHECK ((reason_code IS NULL) = (kind = 'key_invalidated'));--> statement-breakpoint
ALTER TABLE "device_discard_record" ADD CONSTRAINT "device_discard_record_cause" CHECK ((cause IS NOT NULL) = (kind = 'key_invalidated') AND (cause IS NULL OR cause IN ('device_key_lost')));--> statement-breakpoint
DROP INDEX "task_sync_open_source_key";--> statement-breakpoint
CREATE UNIQUE INDEX "task_sync_open_source_key" ON "task" USING btree ("tenant_id","kind","source_type","source_id",coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid),coalesce(assignee_tenant_user_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status IN ('open', 'in_progress') AND deleted_at IS NULL AND kind IN ('sync.device_hold', 'sync.entry_reported_deleted', 'sync.entry_deleted_after_upload', 'care.refused_entry_review', 'sync.device_key_lost');--> statement-breakpoint
CREATE UNIQUE INDEX "device_discard_record_key_lost_key" ON "device_discard_record" USING btree ("tenant_id","device_id") WHERE kind = 'key_invalidated';
