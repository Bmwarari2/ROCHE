CREATE TABLE "medicine_disposal" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"item_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"quantity" numeric(12, 3) NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"witness_id" uuid,
	"witnessed_at" timestamp with time zone,
	"no_witness_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "medicine_disposal_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "medicine_disposal_quantity" CHECK (quantity > 0),
	CONSTRAINT "medicine_disposal_reason" CHECK (reason IN ('refused_dose', 'dropped_or_spoilt', 'out_of_date', 'discontinued', 'person_left', 'other')),
	CONSTRAINT "medicine_disposal_note" CHECK ((note IS NULL OR length(note) <= 500) AND (reason <> 'other' OR length(btrim(coalesce(note, ''))) >= 3)),
	CONSTRAINT "medicine_disposal_witness" CHECK ((witness_id IS NULL) <> (no_witness_reason IS NULL)
        AND (witnessed_at IS NULL OR witness_id IS NOT NULL)
        AND (witness_id IS NULL OR witness_id <> recorded_by)
        AND (no_witness_reason IS NULL OR length(btrim(no_witness_reason)) BETWEEN 10 AND 500))
);
--> statement-breakpoint
CREATE TABLE "medicine_order" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid NOT NULL,
	"cycle_starts_on" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"sent_via" text,
	"pharmacy_reference" text,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "medicine_order_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "medicine_order_status" CHECK (status IN ('draft', 'submitted', 'part_received', 'received', 'cancelled')),
	CONSTRAINT "medicine_order_submitted" CHECK ((sent_via IS NULL OR sent_via IN ('manual', 'pharmacy_port'))
        AND (status IN ('draft', 'cancelled') OR (sent_via IS NOT NULL AND submitted_at IS NOT NULL AND submitted_by IS NOT NULL))
        AND (pharmacy_reference IS NULL OR (sent_via = 'pharmacy_port' AND pharmacy_reference ~ '^[A-Za-z0-9-]{1,64}$')))
);
--> statement-breakpoint
CREATE TABLE "medicine_order_cycle" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid NOT NULL,
	"anchor_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "medicine_order_cycle_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "medicine_order_cycle_location_key" UNIQUE("tenant_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "medicine_order_line" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"order_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"medication_id" uuid NOT NULL,
	"vmp_id" text NOT NULL,
	"product_name" text NOT NULL,
	"quantity" numeric(12, 3) NOT NULL,
	"unit_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "medicine_order_line_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "medicine_order_line_quantity" CHECK (quantity > 0),
	CONSTRAINT "medicine_order_line_vmp" CHECK (vmp_id ~ '^[0-9]{6,18}$')
);
--> statement-breakpoint
CREATE TABLE "medicine_stock_item" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"medication_id" uuid NOT NULL,
	"vmp_id" text NOT NULL,
	"product_name" text NOT NULL,
	"unit_code" text NOT NULL,
	"unit_name" text NOT NULL,
	"opened_by" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "medicine_stock_item_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "medicine_stock_item_person_vmp_key" UNIQUE("tenant_id","person_id","vmp_id"),
	CONSTRAINT "medicine_stock_item_vmp" CHECK (vmp_id ~ '^[0-9]{6,18}$'),
	CONSTRAINT "medicine_stock_item_names" CHECK (length(btrim(product_name)) > 0 AND length(btrim(unit_code)) > 0 AND length(btrim(unit_name)) > 0)
);
--> statement-breakpoint
CREATE TABLE "medicine_stock_movement" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"item_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"movement" text NOT NULL,
	"change" numeric(12, 3) NOT NULL,
	"balance_after" numeric(12, 3) NOT NULL,
	"administration_id" uuid,
	"order_line_id" uuid,
	"disposal_id" uuid,
	"reason" text,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "medicine_stock_movement_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "medicine_stock_movement_seq_key" UNIQUE("tenant_id","item_id","seq"),
	CONSTRAINT "medicine_stock_movement_kind" CHECK (movement IN ('receipt', 'carried_forward', 'administration', 'returned', 'disposal', 'administration_correction', 'count_adjustment')),
	CONSTRAINT "medicine_stock_movement_seq" CHECK (seq >= 1),
	CONSTRAINT "medicine_stock_movement_sign" CHECK (change <> 0 AND CASE movement
        WHEN 'receipt' THEN change > 0 WHEN 'carried_forward' THEN change > 0
        WHEN 'administration' THEN change < 0 WHEN 'returned' THEN change < 0
        WHEN 'disposal' THEN change < 0 ELSE true END),
	CONSTRAINT "medicine_stock_movement_refs" CHECK ((movement IN ('administration', 'administration_correction')) = (administration_id IS NOT NULL)
        AND (movement = 'disposal') = (disposal_id IS NOT NULL)
        AND (order_line_id IS NULL OR movement = 'receipt')
        AND (movement <> 'count_adjustment' OR length(btrim(coalesce(reason, ''))) >= 3)
        AND (reason IS NULL OR length(reason) <= 500))
);
--> statement-breakpoint
CREATE TABLE "medicine_storage" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "medicine_storage_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "medicine_storage_kind" CHECK (kind IN ('fridge', 'room')),
	CONSTRAINT "medicine_storage_name" CHECK (length(btrim(name)) BETWEEN 2 AND 80)
);
--> statement-breakpoint
CREATE TABLE "medicine_temperature_reading" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"storage_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"reading_tenths" integer NOT NULL,
	"min_tenths" integer,
	"max_tenths" integer,
	"low_tenths" integer,
	"high_tenths" integer DEFAULT 0 NOT NULL,
	"out_of_range" boolean DEFAULT false NOT NULL,
	"task_id" uuid,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "medicine_temperature_reading_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "medicine_temperature_reading_values" CHECK (reading_tenths BETWEEN -500 AND 600
        AND (min_tenths IS NULL OR (min_tenths BETWEEN -500 AND 600 AND min_tenths <= reading_tenths))
        AND (max_tenths IS NULL OR (max_tenths BETWEEN -500 AND 600 AND max_tenths >= reading_tenths)))
);
--> statement-breakpoint
ALTER TABLE "medicine_disposal" ADD CONSTRAINT "medicine_disposal_item_fk" FOREIGN KEY ("tenant_id","item_id") REFERENCES "public"."medicine_stock_item"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicine_disposal" ADD CONSTRAINT "medicine_disposal_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicine_disposal" ADD CONSTRAINT "medicine_disposal_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicine_disposal" ADD CONSTRAINT "medicine_disposal_recorded_by_fk" FOREIGN KEY ("tenant_id","recorded_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicine_disposal" ADD CONSTRAINT "medicine_disposal_witness_fk" FOREIGN KEY ("tenant_id","witness_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicine_order" ADD CONSTRAINT "medicine_order_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicine_order" ADD CONSTRAINT "medicine_order_submitted_by_fk" FOREIGN KEY ("tenant_id","submitted_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicine_order_cycle" ADD CONSTRAINT "medicine_order_cycle_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicine_order_line" ADD CONSTRAINT "medicine_order_line_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."medicine_order"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicine_order_line" ADD CONSTRAINT "medicine_order_line_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicine_order_line" ADD CONSTRAINT "medicine_order_line_medication_fk" FOREIGN KEY ("tenant_id","person_id","medication_id") REFERENCES "public"."medication"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicine_stock_item" ADD CONSTRAINT "medicine_stock_item_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicine_stock_item" ADD CONSTRAINT "medicine_stock_item_medication_fk" FOREIGN KEY ("tenant_id","person_id","medication_id") REFERENCES "public"."medication"("tenant_id","person_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicine_stock_item" ADD CONSTRAINT "medicine_stock_item_opened_by_fk" FOREIGN KEY ("tenant_id","opened_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicine_stock_movement" ADD CONSTRAINT "medicine_stock_movement_item_fk" FOREIGN KEY ("tenant_id","item_id") REFERENCES "public"."medicine_stock_item"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicine_stock_movement" ADD CONSTRAINT "medicine_stock_movement_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicine_stock_movement" ADD CONSTRAINT "medicine_stock_movement_administration_fk" FOREIGN KEY ("tenant_id","administration_id") REFERENCES "public"."medication_administration"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicine_stock_movement" ADD CONSTRAINT "medicine_stock_movement_recorded_by_fk" FOREIGN KEY ("tenant_id","recorded_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicine_storage" ADD CONSTRAINT "medicine_storage_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicine_temperature_reading" ADD CONSTRAINT "medicine_temperature_reading_storage_fk" FOREIGN KEY ("tenant_id","storage_id") REFERENCES "public"."medicine_storage"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicine_temperature_reading" ADD CONSTRAINT "medicine_temperature_reading_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicine_temperature_reading" ADD CONSTRAINT "medicine_temperature_reading_recorded_by_fk" FOREIGN KEY ("tenant_id","recorded_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "medicine_order_cycle_key" ON "medicine_order" USING btree ("tenant_id","location_id","cycle_starts_on") WHERE status <> 'cancelled';--> statement-breakpoint
CREATE UNIQUE INDEX "medicine_stock_movement_administration_key" ON "medicine_stock_movement" USING btree ("tenant_id","administration_id") WHERE movement = 'administration';--> statement-breakpoint
CREATE INDEX "medicine_stock_movement_item_idx" ON "medicine_stock_movement" USING btree ("tenant_id","item_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "medicine_storage_name_key" ON "medicine_storage" USING btree ("tenant_id","location_id",lower(name)) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "medicine_temperature_reading_storage_idx" ON "medicine_temperature_reading" USING btree ("tenant_id","storage_id","recorded_at");
--> statement-breakpoint

-- Medicines stock, ordering, disposal and storage temperatures (medicines.md section 15;
-- MEDS-008; slice 42; ADR-0103). Runs as harbour_owner. Person tables follow the person's scope,
-- location tables the location's. Movements, items and readings are append-only; a movement
-- follows the item's last balance; a controlled drug has no item (its register is section 14); a
-- disposal's witness confirms it themselves, once; a reading's range comes from the rate table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['medicine_stock_item', 'medicine_stock_movement', 'medicine_disposal',
      'medicine_order_cycle', 'medicine_order', 'medicine_order_line', 'medicine_storage',
      'medicine_temperature_reading'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC '
      'USING (tenant_id = app.current_tenant_id()) '
      'WITH CHECK (tenant_id = app.current_tenant_id())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['medicine_stock_item', 'medicine_stock_movement', 'medicine_disposal',
      'medicine_order_line'] LOOP
    EXECUTE format(
      'CREATE POLICY person_child_scope ON public.%I AS RESTRICTIVE FOR ALL TO harbour_app, harbour_owner '
      'USING (app.person_visible(person_id)) WITH CHECK (app.person_visible(person_id))', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['medicine_disposal', 'medicine_order_cycle', 'medicine_order',
      'medicine_storage', 'medicine_temperature_reading'] LOOP
    EXECUTE format(
      'CREATE POLICY location_scope ON public.%I AS RESTRICTIVE FOR ALL TO harbour_app, harbour_owner '
      'USING (app.handover_location_visible(location_id)) '
      'WITH CHECK (app.handover_location_visible(location_id))', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- Rule 1: an item is opened from the person's MAR entry for that product, never for a controlled
-- drug, at the database's time.
CREATE OR REPLACE FUNCTION app.medicine_stock_item_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE m public.medication;
BEGIN
  SELECT * INTO m FROM public.medication
   WHERE tenant_id = NEW.tenant_id AND id = NEW.medication_id AND person_id = NEW.person_id;
  IF m.id IS NULL OR m.vmp_id <> NEW.vmp_id THEN
    RAISE EXCEPTION 'medicine_stock_item_entry' USING ERRCODE = 'check_violation';
  END IF;
  IF m.cd_schedule IS NOT NULL THEN
    RAISE EXCEPTION 'medicine_stock_item_controlled_drug' USING ERRCODE = 'check_violation';
  END IF;
  NEW.opened_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER medicine_stock_item_insert BEFORE INSERT ON public.medicine_stock_item
  FOR EACH ROW EXECUTE FUNCTION app.medicine_stock_item_insert();
--> statement-breakpoint

-- Rules 2 to 5: movements follow one another on the item, each with the balance that follows from
-- the last; what a movement names belongs to the same person and product.
CREATE OR REPLACE FUNCTION app.medicine_stock_movement_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE item public.medicine_stock_item;
DECLARE prev public.medicine_stock_movement;
BEGIN
  SELECT * INTO item FROM public.medicine_stock_item
   WHERE tenant_id = NEW.tenant_id AND id = NEW.item_id;
  IF item.id IS NULL OR item.person_id <> NEW.person_id THEN
    RAISE EXCEPTION 'medicine_stock_movement_item' USING ERRCODE = 'check_violation';
  END IF;
  -- One movement of an item at a time.
  PERFORM pg_advisory_xact_lock(hashtextextended('medicine_stock:' || NEW.item_id::text, 0));
  SELECT * INTO prev FROM public.medicine_stock_movement
   WHERE tenant_id = NEW.tenant_id AND item_id = NEW.item_id ORDER BY seq DESC LIMIT 1;
  IF NEW.seq <> COALESCE(prev.seq, 0) + 1 THEN
    RAISE EXCEPTION 'medicine_stock_movement_seq' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.balance_after <> COALESCE(prev.balance_after, 0) + NEW.change THEN
    RAISE EXCEPTION 'medicine_stock_movement_balance' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.administration_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.medication_administration a
      JOIN public.medication m ON m.tenant_id = a.tenant_id AND m.id = a.medication_id
      WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.administration_id
        AND a.person_id = NEW.person_id AND m.vmp_id = item.vmp_id
        AND (NEW.movement <> 'administration' OR a.outcome = 'given')) THEN
    RAISE EXCEPTION 'medicine_stock_movement_administration' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.disposal_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.medicine_disposal d
      WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.disposal_id AND d.item_id = NEW.item_id
        AND d.quantity = -NEW.change) THEN
    RAISE EXCEPTION 'medicine_stock_movement_disposal' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.order_line_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.medicine_order_line l
      JOIN public.medicine_order o ON o.tenant_id = l.tenant_id AND o.id = l.order_id
      WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.order_line_id
        AND l.person_id = NEW.person_id AND l.vmp_id = item.vmp_id
        AND o.status IN ('submitted', 'part_received')) THEN
    RAISE EXCEPTION 'medicine_stock_movement_order_line' USING ERRCODE = 'check_violation';
  END IF;
  NEW.recorded_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER medicine_stock_movement_insert BEFORE INSERT ON public.medicine_stock_movement
  FOR EACH ROW EXECUTE FUNCTION app.medicine_stock_movement_insert();
--> statement-breakpoint

-- Rule 5: a disposal is recorded at the database's time; without a witness only where the
-- organisation's policy allows; its witness confirms it themselves, once, and nothing else changes.
CREATE OR REPLACE FUNCTION app.medicine_disposal_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.recorded_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'medicine_disposal_recorder' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.no_witness_reason IS NOT NULL
     AND COALESCE(app.location_rate(NEW.location_id, 'medicines.disposal.witness_required', now()), 1) <> 0 THEN
    RAISE EXCEPTION 'medicine_disposal_witness_required' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.medicine_stock_item i
                 WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.item_id
                   AND i.person_id = NEW.person_id) THEN
    RAISE EXCEPTION 'medicine_disposal_item' USING ERRCODE = 'check_violation';
  END IF;
  NEW.recorded_at := now();
  NEW.witnessed_at := NULL;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER medicine_disposal_insert BEFORE INSERT ON public.medicine_disposal
  FOR EACH ROW EXECUTE FUNCTION app.medicine_disposal_insert();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.medicine_disposal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.item_id IS DISTINCT FROM OLD.item_id OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id OR NEW.quantity IS DISTINCT FROM OLD.quantity
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
     OR NEW.witness_id IS DISTINCT FROM OLD.witness_id
     OR NEW.no_witness_reason IS DISTINCT FROM OLD.no_witness_reason
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'medicine_disposal_fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.witnessed_at IS NOT NULL OR OLD.witness_id IS NULL
     OR OLD.witness_id IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'medicine_disposal_witness' USING ERRCODE = 'check_violation';
  END IF;
  NEW.witnessed_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER medicine_disposal_guard BEFORE UPDATE ON public.medicine_disposal
  FOR EACH ROW EXECUTE FUNCTION app.medicine_disposal_guard();
--> statement-breakpoint

-- Rule 7: an order moves only by its steps; its lines change only while it is a draft.
CREATE OR REPLACE FUNCTION app.medicine_order_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.cycle_starts_on IS DISTINCT FROM OLD.cycle_starts_on THEN
    RAISE EXCEPTION 'medicine_order_fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
      (OLD.status = 'draft' AND NEW.status IN ('submitted', 'cancelled'))
      OR (OLD.status IN ('submitted', 'part_received')
          AND NEW.status IN ('part_received', 'received', 'cancelled'))) THEN
    RAISE EXCEPTION 'medicine_order_step' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'draft' AND (NEW.sent_via IS DISTINCT FROM OLD.sent_via
      OR NEW.pharmacy_reference IS DISTINCT FROM OLD.pharmacy_reference
      OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
      OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at) THEN
    RAISE EXCEPTION 'medicine_order_fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'submitted' THEN
    NEW.submitted_by := app.current_user_id();
    NEW.submitted_at := now();
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER medicine_order_guard BEFORE UPDATE ON public.medicine_order
  FOR EACH ROW EXECUTE FUNCTION app.medicine_order_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.medicine_order_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.status := 'draft';
  NEW.sent_via := NULL;
  NEW.pharmacy_reference := NULL;
  NEW.submitted_by := NULL;
  NEW.submitted_at := NULL;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER medicine_order_insert BEFORE INSERT ON public.medicine_order
  FOR EACH ROW EXECUTE FUNCTION app.medicine_order_insert();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.medicine_order_line_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE o public.medicine_order;
BEGIN
  SELECT * INTO o FROM public.medicine_order
   WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id;
  IF o.status IS DISTINCT FROM 'draft'
     OR (TG_OP = 'UPDATE' AND NEW.order_id IS DISTINCT FROM OLD.order_id) THEN
    RAISE EXCEPTION 'medicine_order_line_fixed' USING ERRCODE = 'check_violation';
  END IF;
  -- A line is for someone at the order's location, from their own MAR entry for the product.
  IF NOT EXISTS (
      SELECT 1 FROM public.medication m JOIN public.person p
        ON p.tenant_id = m.tenant_id AND p.id = m.person_id
      WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.medication_id
        AND m.person_id = NEW.person_id AND m.vmp_id = NEW.vmp_id
        AND m.cd_schedule IS NULL AND p.location_id = o.location_id) THEN
    RAISE EXCEPTION 'medicine_order_line_entry' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER medicine_order_line_guard BEFORE INSERT OR UPDATE ON public.medicine_order_line
  FOR EACH ROW EXECUTE FUNCTION app.medicine_order_line_guard();
--> statement-breakpoint

-- Rule 8: a reading takes its storage's location and the range that applies from the rate table,
-- the database decides whether it is out of range, and one out of range names the task it raised.
CREATE OR REPLACE FUNCTION app.medicine_temperature_reading_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE s public.medicine_storage;
DECLARE lo numeric;
DECLARE hi numeric;
BEGIN
  SELECT * INTO s FROM public.medicine_storage
   WHERE tenant_id = NEW.tenant_id AND id = NEW.storage_id AND deleted_at IS NULL;
  IF s.id IS NULL THEN
    RAISE EXCEPTION 'medicine_temperature_reading_storage' USING ERRCODE = 'check_violation';
  END IF;
  NEW.location_id := s.location_id;
  NEW.recorded_at := now();
  IF NEW.recorded_by IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'medicine_temperature_reading_recorder' USING ERRCODE = 'check_violation';
  END IF;
  IF s.kind = 'fridge' THEN
    lo := app.location_rate(s.location_id, 'medicines.fridge_min_celsius', NEW.recorded_at);
    hi := app.location_rate(s.location_id, 'medicines.fridge_max_celsius', NEW.recorded_at);
  ELSE
    lo := NULL;
    hi := app.location_rate(s.location_id, 'medicines.room_max_celsius', NEW.recorded_at);
  END IF;
  IF hi IS NULL OR (s.kind = 'fridge' AND lo IS NULL) THEN
    RAISE EXCEPTION 'medicine_temperature_reading_rate_missing' USING ERRCODE = 'check_violation';
  END IF;
  NEW.low_tenths := CASE WHEN lo IS NULL THEN NULL ELSE round(lo * 10)::integer END;
  NEW.high_tenths := round(hi * 10)::integer;
  NEW.out_of_range := GREATEST(NEW.reading_tenths, COALESCE(NEW.max_tenths, NEW.reading_tenths)) > NEW.high_tenths
    OR (NEW.low_tenths IS NOT NULL
        AND LEAST(NEW.reading_tenths, COALESCE(NEW.min_tenths, NEW.reading_tenths)) < NEW.low_tenths);
  IF NEW.out_of_range AND (NEW.task_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.task t
      WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.task_id
        AND t.kind = 'medicines.temperature.out_of_range' AND t.location_id = s.location_id)) THEN
    RAISE EXCEPTION 'medicine_temperature_reading_task' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT NEW.out_of_range AND NEW.task_id IS NOT NULL THEN
    RAISE EXCEPTION 'medicine_temperature_reading_task' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER medicine_temperature_reading_insert BEFORE INSERT ON public.medicine_temperature_reading
  FOR EACH ROW EXECUTE FUNCTION app.medicine_temperature_reading_insert();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.medicine_storage_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.location_id IS DISTINCT FROM OLD.location_id OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'medicine_storage_fixed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER medicine_storage_guard BEFORE UPDATE ON public.medicine_storage
  FOR EACH ROW EXECUTE FUNCTION app.medicine_storage_guard();
--> statement-breakpoint

ALTER TABLE public.medicine_stock_movement ADD CONSTRAINT medicine_stock_movement_disposal_fk
  FOREIGN KEY (tenant_id, disposal_id) REFERENCES public.medicine_disposal (tenant_id, id);
--> statement-breakpoint
ALTER TABLE public.medicine_stock_movement ADD CONSTRAINT medicine_stock_movement_order_line_fk
  FOREIGN KEY (tenant_id, order_line_id) REFERENCES public.medicine_order_line (tenant_id, id);
--> statement-breakpoint
ALTER TABLE public.medicine_temperature_reading ADD CONSTRAINT medicine_temperature_reading_task_fk
  FOREIGN KEY (tenant_id, task_id) REFERENCES public.task (tenant_id, id);
--> statement-breakpoint

-- Items, movements and readings are never edited; the mutable tables keep their history.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['medicine_stock_item', 'medicine_stock_movement',
      'medicine_temperature_reading'] LOOP
    EXECUTE format(
      'CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
    EXECUTE format(
      'CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation()', t);
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO harbour_app', t);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM harbour_app', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['medicine_disposal', 'medicine_order_cycle', 'medicine_order',
      'medicine_order_line', 'medicine_storage'] LOOP
    EXECUTE format(
      'CREATE TRIGGER touch_mutable BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.touch_mutable()', t);
    EXECUTE format(
      'CREATE TRIGGER capture_version AFTER UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.capture_version()', t);
    EXECUTE format(
      'CREATE TRIGGER no_delete BEFORE DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO harbour_app', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON public.%I FROM harbour_app', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- Sample data mode (migration 0069, HZ-072): a sample person's stock goes with them, before the
-- MAR entries and administrations it names. Every table migration 0128 listed is kept.
CREATE OR REPLACE FUNCTION app.sample_removal_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT ARRAY[
    'medicine_stock_movement', 'medicine_disposal', 'medicine_order_line', 'medicine_stock_item',
    'controlled_drug_stock_check', 'controlled_drug_entry', 'controlled_drug_witness_assertion',
    'controlled_drug_page',
    'medication_administration_witness', 'medication_administration', 'medication_dosing_record',
    'medication_reconciliation_decision', 'medication_reconciliation_item',
    'medication_reconciliation_source', 'medication_schedule', 'medication',
    'medication_reconciliation',
    'dependency_assessment',
    'about_me', 'about_me_share_link', 'activity_record', 'admission_condition',
    'advance_care_record', 'allergy', 'assessment', 'bed_occupancy', 'body_map_mark',
    'break_glass_event', 'candour_record', 'care_note', 'care_plan_action', 'care_plan_change',
    'consent_record', 'document_signature', 'dols_legal_change_review',
    'entry_device_deletion_flag', 'exit_checklist_item', 'family_portal_user',
    'feed_item_withdrawal', 'feed_view', 'handover_note', 'incident_person', 'key_issue',
    'legal_hold', 'letter', 'notification_delivery', 'observation', 'person_assignment',
    'person_care_profile', 'property_item', 'refused_entry', 'sharing_decision_suspension',
    'safeguarding_concern', 'statutory_notification', 'visit_log', 'welcome_checklist_item', 'workflow_transition',
    'care_plan_section', 'dols_authorisation', 'exit_record', 'feed_item', 'handover_item',
    'hospital_transfer', 'notification', 'placement', 'review_record', 'risk_assessment',
    'sharing_decision', 'task', 'admission_decision', 'best_interests_decision', 'care_plan',
    'document', 'task_series', 'workflow_instance', 'capacity_assessment', 'contact',
    'pre_admission_assessment'
  ]::text[]
$$;
