ALTER TABLE "sponsored_worker" DROP CONSTRAINT "sponsored_worker_english";--> statement-breakpoint
ALTER TABLE "tenant" ADD COLUMN "staff_privacy_notice_document_id" uuid;--> statement-breakpoint
ALTER TABLE "sponsored_worker" ADD CONSTRAINT "sponsored_worker_english" CHECK (english_evidence IN ('not_recorded', 'majority_english_speaking_country', 'degree_taught_in_english', 'secure_english_language_test', 'previous_grant', 'uk_school_qualification', 'professional_body_assessment'));--> statement-breakpoint
-- H-905 (recommended answer applied 31/10/2026, review at testing): the staff a family photo shows.
ALTER TABLE "feed_item" ADD COLUMN "staff_shown" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "feed_item" ADD CONSTRAINT "feed_item_staff_shown" CHECK (cardinality(staff_shown) = 0 OR kind = 'photo');
--> statement-breakpoint
-- H-940 (recommended answer applied 31/10/2026, review at testing): the staff privacy notice in
-- force is an organisation document of this organisation, never another's, and never a document
-- of another kind. document refers to tenant, so this key is added here, not in the schema.
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_staff_privacy_notice_document_fk"
  FOREIGN KEY ("id", "staff_privacy_notice_document_id") REFERENCES "document" ("tenant_id", "id");--> statement-breakpoint
CREATE FUNCTION app.tenant_notice_document_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.staff_privacy_notice_document_id IS NOT NULL
     AND NEW.staff_privacy_notice_document_id IS DISTINCT FROM OLD.staff_privacy_notice_document_id
     AND NOT EXISTS (
       SELECT 1 FROM document d
        WHERE d.tenant_id = NEW.id AND d.id = NEW.staff_privacy_notice_document_id
          AND d.category = 'organisation_document' AND d.status = 'available'
          AND d.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'the staff privacy notice must be an available organisation document'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER tenant_notice_document_guard BEFORE UPDATE OF staff_privacy_notice_document_id ON "tenant"
  FOR EACH ROW EXECUTE FUNCTION app.tenant_notice_document_guard();
