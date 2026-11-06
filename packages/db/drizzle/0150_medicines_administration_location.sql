-- Medicines administrations carry the person's home (Phase 2 slice 68; ADR-0130; migration 0150).
-- The phone's location medicines streams sync administrations per home and UTC day, not per person
-- and day: one bucket per person per day went far past PowerSync's buckets per connection (about
-- 2,100 for one phone at a 60-bed home). The database sets the home from the person when the record
-- is stored; whatever the client sends is replaced.
ALTER TABLE "medication_administration" ADD COLUMN "location_id" uuid;--> statement-breakpoint
UPDATE "medication_administration" a SET "location_id" = p."location_id"
  FROM "person" p WHERE p."tenant_id" = a."tenant_id" AND p."id" = a."person_id";--> statement-breakpoint
ALTER TABLE "medication_administration" ALTER COLUMN "location_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "medication_administration" ADD CONSTRAINT "medication_administration_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "medication_administration_location_idx" ON "medication_administration" USING btree ("tenant_id","location_id","recorded_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.medication_administration_location() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  SELECT p.location_id INTO NEW.location_id FROM public.person p
   WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.person_id;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER medication_administration_location BEFORE INSERT ON public.medication_administration
  FOR EACH ROW EXECUTE FUNCTION app.medication_administration_location();
