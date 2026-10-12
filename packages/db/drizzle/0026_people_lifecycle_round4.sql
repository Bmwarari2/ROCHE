ALTER TABLE "activity_record" DROP CONSTRAINT "activity_record_task_outcome";--> statement-breakpoint
ALTER TABLE "assessment" DROP CONSTRAINT "assessment_task_outcome";--> statement-breakpoint
ALTER TABLE "body_map_mark" DROP CONSTRAINT "body_map_mark_task_outcome";--> statement-breakpoint
ALTER TABLE "care_note" DROP CONSTRAINT "care_note_task_outcome";--> statement-breakpoint
ALTER TABLE "observation" DROP CONSTRAINT "observation_task_outcome";--> statement-breakpoint
ALTER TABLE "visit_log" DROP CONSTRAINT "visit_log_task_outcome";--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "image_printable" boolean;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "restore_code" text;--> statement-breakpoint
ALTER TABLE "activity_record" ADD CONSTRAINT "activity_record_task_outcome" CHECK ((task_id IS NULL) = (task_outcome IS NULL) AND (task_outcome IS NULL OR task_outcome IN ('completed', 'task_cancelled', 'task_already_closed', 'not_linked', 'medicines_conflict')));--> statement-breakpoint
ALTER TABLE "assessment" ADD CONSTRAINT "assessment_task_outcome" CHECK ((task_id IS NULL) = (task_outcome IS NULL) AND (task_outcome IS NULL OR task_outcome IN ('completed', 'task_cancelled', 'task_already_closed', 'not_linked', 'medicines_conflict')));--> statement-breakpoint
ALTER TABLE "body_map_mark" ADD CONSTRAINT "body_map_mark_task_outcome" CHECK ((task_id IS NULL) = (task_outcome IS NULL) AND (task_outcome IS NULL OR task_outcome IN ('completed', 'task_cancelled', 'task_already_closed', 'not_linked', 'medicines_conflict')));--> statement-breakpoint
ALTER TABLE "care_note" ADD CONSTRAINT "care_note_task_outcome" CHECK ((task_id IS NULL) = (task_outcome IS NULL) AND (task_outcome IS NULL OR task_outcome IN ('completed', 'task_cancelled', 'task_already_closed', 'not_linked', 'medicines_conflict')));--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_task_outcome" CHECK ((task_id IS NULL) = (task_outcome IS NULL) AND (task_outcome IS NULL OR task_outcome IN ('completed', 'task_cancelled', 'task_already_closed', 'not_linked', 'medicines_conflict')));--> statement-breakpoint
ALTER TABLE "visit_log" ADD CONSTRAINT "visit_log_task_outcome" CHECK ((task_id IS NULL) = (task_outcome IS NULL) AND (task_outcome IS NULL OR task_outcome IN ('completed', 'task_cancelled', 'task_already_closed', 'not_linked', 'medicines_conflict')));--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_restore_code" CHECK (restore_code IS NULL OR restore_code IN ('caught_up', 'answered_while_stopped'));