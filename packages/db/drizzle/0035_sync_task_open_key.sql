-- One open sync task per source (care.md section 6, Device integrity part 4). Built inside the
-- migration's transaction, so not CONCURRENTLY: it locks task against writes while it builds. That
-- is accepted before go-live, when the table is small; a later rebuild on a live tenant would use
-- CREATE INDEX CONCURRENTLY outside a transaction (#25 review round 2, note).
CREATE UNIQUE INDEX "task_sync_open_source_key" ON "task" USING btree ("tenant_id","kind","source_type","source_id",coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid),coalesce(assignee_tenant_user_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status IN ('open', 'in_progress') AND deleted_at IS NULL AND kind IN ('sync.device_hold', 'sync.entry_reported_deleted', 'sync.entry_deleted_after_upload', 'care.refused_entry_review');
