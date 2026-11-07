-- Medicines on the phone (Phase 2 slice 68; medicines.md section 13.8; hazards HZ-002, HZ-003,
-- HZ-113): the tables the medicines sync streams read join the powersync publication, the ADR-0002
-- pattern of migrations 0012, 0017, 0052 and 0139. Runs as harbour_owner. The sync role reads them
-- for replication only (SELECT, no other grant); which rows reach a device is decided by the
-- streams in packages/sync (the people in the member's `medicines.emar.administer` scope: assigned
-- people, or every live person at the locations it reaches; administrations in the last days only;
-- the member's own medicines competence), proven per person, location, member and tenant in
-- packages/sync/test/medicines-streams.test.ts, because logical replication bypasses row-level
-- security and the initial snapshot is this plain SELECT. Every other policy on these tables
-- targets harbour_app and harbour_owner, so the API's reads are unchanged. The dm+d reference
-- tables are already published (migration 0072, ADR-0080); the device's subset of them comes from
-- the API (ADR-0130). No document, reconciliation, error, review, stock or controlled drug table
-- is published.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['medication', 'medication_schedule', 'medication_dosing_record',
    'medication_administration', 'covert_medication_record', 'competence_sign_off',
    'competence_withdrawal'] LOOP
    EXECUTE format(
      'CREATE POLICY sync_replication_read ON public.%I AS PERMISSIVE FOR SELECT TO harbour_sync '
      'USING (true)', t);
  END LOOP;
END
$$;
--> statement-breakpoint
GRANT SELECT ON public.medication, public.medication_schedule, public.medication_dosing_record,
  public.medication_administration, public.covert_medication_record, public.competence_sign_off,
  public.competence_withdrawal TO harbour_sync;
--> statement-breakpoint
ALTER PUBLICATION powersync ADD TABLE public.medication, public.medication_schedule,
  public.medication_dosing_record, public.medication_administration,
  public.covert_medication_record, public.competence_sign_off, public.competence_withdrawal;
