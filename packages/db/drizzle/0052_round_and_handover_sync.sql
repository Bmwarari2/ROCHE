-- The round and the shift handover on the phone (Phase 1 slice 10 part 2; care.md section 6;
-- hazards HZ-011, HZ-018, HZ-028): the tables the `*_open_tasks` and `*_handovers` sync streams
-- read join the powersync publication, the ADR-0002 pattern of migrations 0012 and 0017. Runs as
-- harbour_owner. The sync role reads them for replication only (SELECT, no other grant); which
-- rows reach a device is decided by the streams in packages/sync, proven per scope and tenant in
-- packages/sync/test/task-handover-streams.test.ts, because logical replication bypasses
-- row-level security and the initial snapshot is this plain SELECT. Every other policy on these
-- tables targets harbour_app and harbour_owner, so the API's reads are unchanged.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'task', 'handover', 'handover_item', 'handover_note', 'handover_acknowledgement'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY sync_replication_read ON public.%I AS PERMISSIVE FOR SELECT TO harbour_sync '
      'USING (true)', t);
  END LOOP;
END
$$;
--> statement-breakpoint
GRANT SELECT ON public.task, public.handover, public.handover_item, public.handover_note,
  public.handover_acknowledgement TO harbour_sync;
--> statement-breakpoint
ALTER PUBLICATION powersync ADD TABLE public.task, public.handover, public.handover_item,
  public.handover_note, public.handover_acknowledgement;
