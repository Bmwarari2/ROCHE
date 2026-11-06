-- Own shifts and clock events on the phone (Phase 2 slice 71; scheduling.md section 18; hazards
-- HZ-010, HZ-124, HZ-125): the tables the `my_shifts` and `my_clock_events` sync streams read join
-- the powersync publication, the ADR-0002 pattern of migrations 0012, 0017 and 0052. Runs as
-- harbour_owner. The sync role reads them for replication only (SELECT, no other grant); which
-- rows reach a device is decided by the streams in packages/sync (a member's own published,
-- uncancelled shifts and their own clock events, in the token's shift days), proven per member
-- and tenant in packages/sync/test/shift-streams.test.ts, because logical replication bypasses
-- row-level security and the initial snapshot is this plain SELECT. Every other policy on these
-- tables targets harbour_app and harbour_owner, so the API's reads are unchanged. No lone-worker
-- table syncs: the phone reads its session through the API, which never shows a duress press.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shift', 'shift_assignment', 'clock_event'] LOOP
    EXECUTE format(
      'CREATE POLICY sync_replication_read ON public.%I AS PERMISSIVE FOR SELECT TO harbour_sync '
      'USING (true)', t);
  END LOOP;
END
$$;
--> statement-breakpoint
GRANT SELECT ON public.shift, public.shift_assignment, public.clock_event TO harbour_sync;
--> statement-breakpoint
ALTER PUBLICATION powersync ADD TABLE public.shift, public.shift_assignment, public.clock_event;
