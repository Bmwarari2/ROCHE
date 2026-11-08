CREATE INDEX "feed_item_staff_shown_idx" ON "feed_item" USING gin ("staff_shown");--> statement-breakpoint
CREATE INDEX "letter_template_version_contributor_ids_idx" ON "letter_template_version" USING gin ("contributor_ids");--> statement-breakpoint
CREATE INDEX "dependency_scale_version_contributor_ids_idx" ON "dependency_scale_version" USING gin ("contributor_ids");--> statement-breakpoint
CREATE INDEX "downtime_pack_person_ids_idx" ON "downtime_pack" USING gin ("person_ids");--> statement-breakpoint
CREATE INDEX "evidence_pack_person_ids_idx" ON "evidence_pack" USING gin ("person_ids");--> statement-breakpoint
CREATE INDEX "evidence_pack_editor_ids_idx" ON "evidence_pack" USING gin ("editor_ids");--> statement-breakpoint
CREATE INDEX "evidence_pack_item_redacted_by_idx" ON "evidence_pack_item" USING gin ("redacted_by");--> statement-breakpoint
CREATE INDEX "statement_of_purpose_version_contributor_ids_idx" ON "statement_of_purpose_version" USING gin ("contributor_ids");--> statement-breakpoint
CREATE INDEX "interview_panel_idx" ON "interview" USING gin ("panel");--> statement-breakpoint
CREATE INDEX "compliment_staff_ids_idx" ON "compliment" USING gin ("staff_ids");