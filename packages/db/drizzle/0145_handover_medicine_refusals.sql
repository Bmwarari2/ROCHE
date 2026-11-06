-- A refused dose reaches the shift handover as a refusal (Phase 2 slice 49; HZ-003). Expand only:
-- the previous app version never writes the new source type.
ALTER TABLE "handover_item" DROP CONSTRAINT "handover_item_source_type";--> statement-breakpoint
ALTER TABLE "handover_item" ADD CONSTRAINT "handover_item_source_type" CHECK (source_type IN ('task', 'observation', 'incident', 'body_map_mark', 'care_note', 'notification', 'medication_administration'));--> statement-breakpoint
-- A downtime pack may also hold the snapshot it was built from (slice 49 review: commit order, not
-- transaction start times, decides whether a write is newer than the pack).
CREATE OR REPLACE FUNCTION app.downtime_pack_people() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF jsonb_typeof(NEW.content -> 'pages') IS DISTINCT FROM 'array'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(NEW.content) AS k
                WHERE k NOT IN ('packId', 'locationId', 'locationName', 'generatedAt', 'asAt',
                                'validUntil', 'pages', 'excluded', 'warnings', 'buildSnapshot'))
     -- The build's database snapshot, so a write committed after it makes the pack stale (slice 49).
     OR (NEW.content ? 'buildSnapshot'
         AND COALESCE(NEW.content ->> 'buildSnapshot', '') !~ '^[0-9]+:[0-9]+:[0-9,]*$')
     OR COALESCE(NEW.content -> 'excluded', '[]'::jsonb) <> '[]'::jsonb
     OR jsonb_typeof(COALESCE(NEW.content -> 'warnings', '[]'::jsonb)) <> 'array'
     OR EXISTS (SELECT 1 FROM jsonb_each(NEW.warnings) AS w WHERE jsonb_typeof(w.value) <> 'number') THEN
    RAISE EXCEPTION 'A downtime pack holds its own keys, its pages and no one left out, and counts of warnings only'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.person_ids := ARRAY(
    SELECT DISTINCT (e ->> 'personId')::uuid
    FROM jsonb_array_elements(NEW.content -> 'pages') AS e
    ORDER BY 1);
  IF array_position(NEW.person_ids, NULL) IS NOT NULL
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(NEW.content -> 'warnings', '[]'::jsonb)) AS w
                WHERE (w ->> 'personId') IS NOT NULL
                  AND NOT (w ->> 'personId')::uuid = ANY (NEW.person_ids)) THEN
    RAISE EXCEPTION 'Every page of a downtime pack names its person, and its warnings are about them'
      USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(NEW.person_ids) = 0 AND EXISTS (
       SELECT 1 FROM public.person p
       WHERE p.location_id = NEW.location_id AND p.deleted_at IS NULL
         AND p.status IN ('active', 'on_leave', 'in_hospital')) THEN
    RAISE EXCEPTION 'A downtime pack has a page for everyone receiving care at the location'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
