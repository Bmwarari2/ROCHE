CREATE SCHEMA "auth";
--> statement-breakpoint
CREATE TYPE "public"."allergy_status" AS ENUM('unknown', 'no_known_allergies', 'has_allergies');--> statement-breakpoint
CREATE TYPE "public"."audit_outcome" AS ENUM('success', 'denied', 'error');--> statement-breakpoint
CREATE TYPE "public"."contact_role" AS ENUM('next_of_kin', 'lpa_health_welfare', 'lpa_property_finance', 'deputy', 'imca', 'advocate', 'appointee', 'gp', 'social_worker', 'other');--> statement-breakpoint
CREATE TYPE "public"."legal_form" AS ENUM('limited_company', 'charity', 'community_interest_company', 'partnership', 'sole_trader', 'public_body', 'franchise');--> statement-breakpoint
CREATE TYPE "public"."nation" AS ENUM('england', 'wales', 'scotland', 'northern_ireland');--> statement-breakpoint
CREATE TYPE "public"."notification_severity" AS ENUM('info', 'warning', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."person_status" AS ENUM('enquiry', 'active', 'on_leave', 'in_hospital', 'discharged', 'deceased', 'archived');--> statement-breakpoint
CREATE TYPE "public"."placement_type" AS ENUM('permanent', 'respite', 'trial', 'package');--> statement-breakpoint
CREATE TYPE "public"."regulator" AS ENUM('cqc', 'ciw', 'care_inspectorate', 'rqia', 'ofsted');--> statement-breakpoint
CREATE TYPE "public"."scope_kind" AS ENUM('tenant', 'location', 'assigned', 'self', 'none');--> statement-breakpoint
CREATE TYPE "public"."service_type" AS ENUM('residential', 'nursing', 'supported_living', 'domiciliary', 'complex_care', 'live_in', 'respite', 'day_service', 'childrens_home');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('onboarding', 'active', 'suspended', 'closed');--> statement-breakpoint
CREATE TYPE "public"."tenant_user_status" AS ENUM('invited', 'active', 'suspended', 'left');--> statement-breakpoint
CREATE TYPE "public"."terminology" AS ENUM('resident', 'client', 'person_we_support');--> statement-breakpoint
CREATE TABLE "auth"."account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."passkey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp with time zone,
	"aaguid" text
);
--> statement-breakpoint
CREATE TABLE "auth"."session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth"."two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL,
	"verified" boolean,
	"failed_verification_count" integer,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth"."user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"two_factor_enabled" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "auth"."verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "about_me" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"sections" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"authored_by_person" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "about_me_person_key" UNIQUE("tenant_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "allergy" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"substance" text NOT NULL,
	"snomed_code" text,
	"category" text DEFAULT 'other' NOT NULL,
	"reaction" text,
	"severity" text DEFAULT 'unknown' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "break_glass_event" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"tenant_user_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"justification" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"review_outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "contact" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"role" "contact_role" NOT NULL,
	"given_name" text NOT NULL,
	"family_name" text NOT NULL,
	"relationship" text,
	"phone" text,
	"email" text,
	"address_line1" text,
	"town" text,
	"postcode" text,
	"is_next_of_kin" boolean DEFAULT false NOT NULL,
	"authority_reference" text,
	"authority_document_id" uuid,
	"valid_until" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "person" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid NOT NULL,
	"status" "person_status" DEFAULT 'enquiry' NOT NULL,
	"nhs_number" text,
	"local_identifier" text,
	"title" text,
	"given_name" text NOT NULL,
	"family_name" text NOT NULL,
	"preferred_name" text,
	"date_of_birth" date,
	"sex_code" text,
	"gender_identity" text,
	"ethnic_category_code" text,
	"religion" text,
	"first_language" text,
	"interpreter_required" boolean DEFAULT false NOT NULL,
	"address_line1" text,
	"address_line2" text,
	"town" text,
	"postcode" text,
	"gp_practice_ods_code" text,
	"legal_status" text,
	"photo_document_id" uuid,
	"room_label" text,
	"communication_needs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allergy_status" "allergy_status" DEFAULT 'unknown' NOT NULL,
	"national_data_opt_out" boolean DEFAULT false NOT NULL,
	"deceased_at" timestamp with time zone,
	"discharged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "person_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "person_tenant_nhs_number_key" UNIQUE("tenant_id","nhs_number")
);
--> statement-breakpoint
CREATE TABLE "person_assignment" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"tenant_user_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "placement" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"room_id" uuid,
	"type" "placement_type" NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"end_reason" text,
	"dependency_category" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "room" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid NOT NULL,
	"label" text NOT NULL,
	"unit_name" text,
	"floor" text,
	"beds" integer DEFAULT 1 NOT NULL,
	"ensuite" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "room_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "room_location_label_key" UNIQUE("tenant_id","location_id","label")
);
--> statement-breakpoint
CREATE TABLE "access_grant" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"tenant_user_id" uuid NOT NULL,
	"permissions" text[] NOT NULL,
	"location_id" uuid,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"granted_by" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "audit_event_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid,
	"chain_position" bigint,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_tenant_user_id" uuid,
	"actor_auth_user_id" text,
	"actor_role_keys" text[],
	"action" text NOT NULL,
	"outcome" "audit_outcome" DEFAULT 'success' NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"scope" jsonb,
	"ip" "inet",
	"device_id" text,
	"request_id" text,
	"reason" text,
	"before_hash" text,
	"after_hash" text,
	"prev_hash" text,
	"hash" text,
	CONSTRAINT "audit_event_chain_position_key" UNIQUE NULLS NOT DISTINCT("tenant_id","chain_position")
);
--> statement-breakpoint
CREATE TABLE "document" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"retention_class" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"document_version" integer DEFAULT 1 NOT NULL,
	"previous_version_id" uuid,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "document_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "escalation_chain" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"steps" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "escalation_chain_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "escalation_chain_tenant_key_key" UNIQUE("tenant_id","key")
);
--> statement-breakpoint
CREATE TABLE "feature_flag" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid,
	"flag_key" text NOT NULL,
	"enabled" boolean NOT NULL,
	"value" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "feature_flag_scope_key" UNIQUE NULLS NOT DISTINCT("tenant_id","location_id","flag_key")
);
--> statement-breakpoint
CREATE TABLE "form_submission" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"template_id" uuid NOT NULL,
	"template_key" text NOT NULL,
	"template_version" integer NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"answers" jsonb NOT NULL,
	"result" jsonb,
	"status" text DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "form_template" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid,
	"key" text NOT NULL,
	"template_version" integer NOT NULL,
	"title" text NOT NULL,
	"kind" text DEFAULT 'form' NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"definition" jsonb NOT NULL,
	"review_cadence_days" integer,
	"published_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "form_template_key_version_key" UNIQUE NULLS NOT DISTINCT("tenant_id","key","template_version")
);
--> statement-breakpoint
CREATE TABLE "location" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"name" text NOT NULL,
	"regulator" "regulator" DEFAULT 'cqc' NOT NULL,
	"regulator_location_id" text,
	"ods_code" text,
	"nation" "nation" DEFAULT 'england' NOT NULL,
	"address_line1" text,
	"address_line2" text,
	"town" text,
	"postcode" text,
	"timezone" text DEFAULT 'Europe/London' NOT NULL,
	"phone" text,
	"bed_capacity" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "location_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"recipient_tenant_user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"severity" "notification_severity" DEFAULT 'info' NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"link" text,
	"channels" text[] DEFAULT '{in_app}'::text[] NOT NULL,
	"source_type" text,
	"source_id" text,
	"dedupe_key" text,
	"escalation_chain_id" uuid,
	"escalation_step" integer DEFAULT 0 NOT NULL,
	"escalate_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "notification_dedupe_key" UNIQUE("tenant_id","recipient_tenant_user_id","dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "notification_preference" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"tenant_user_id" uuid NOT NULL,
	"quiet_hours_start" time,
	"quiet_hours_end" time,
	"channels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "notification_preference_user_key" UNIQUE("tenant_id","tenant_user_id")
);
--> statement-breakpoint
CREATE TABLE "outbox_event" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "rate_table" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid,
	"key" text NOT NULL,
	"value" numeric(14, 4) NOT NULL,
	"unit" text NOT NULL,
	"nation" text DEFAULT 'all' NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"source" text NOT NULL,
	"verification_status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id()
);
--> statement-breakpoint
CREATE TABLE "record_version" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid,
	"table_name" text NOT NULL,
	"record_id" uuid NOT NULL,
	"record_version" integer NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" uuid,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retention_class" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid,
	"record_class" text NOT NULL,
	"period" integer NOT NULL,
	"unit" text NOT NULL,
	"trigger" text NOT NULL,
	"source" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	CONSTRAINT "retention_class_key" UNIQUE NULLS NOT DISTINCT("tenant_id","record_class")
);
--> statement-breakpoint
CREATE TABLE "role" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"scope_kind" "scope_kind" NOT NULL,
	"is_builtin" boolean DEFAULT false NOT NULL,
	"based_on_key" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "role_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "role_tenant_key_key" UNIQUE("tenant_id","key")
);
--> statement-breakpoint
CREATE TABLE "role_assignment" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"tenant_user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"location_id" uuid,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "service" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"service_type" "service_type" NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"started_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "service_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "tenant" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"group_id" uuid,
	"name" text NOT NULL,
	"legal_name" text NOT NULL,
	"cqc_provider_id" text,
	"legal_form" "legal_form" NOT NULL,
	"vat_registered" boolean DEFAULT false NOT NULL,
	"nation" "nation" DEFAULT 'england' NOT NULL,
	"status" "tenant_status" DEFAULT 'onboarding' NOT NULL,
	"brand_name" text,
	"brand_accent" text,
	"logo_document_id" uuid,
	"terminology" "terminology" DEFAULT 'resident' NOT NULL,
	"dpo_name" text,
	"dpo_email" text,
	"caldicott_guardian" text,
	"siro" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "tenant_cqc_provider_id_key" UNIQUE("cqc_provider_id"),
	CONSTRAINT "tenant_brand_accent_hex" CHECK (brand_accent IS NULL OR brand_accent ~ '^#[0-9a-f]{6}$')
);
--> statement-breakpoint
CREATE TABLE "tenant_group" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tenant_user" (
	"id" uuid PRIMARY KEY DEFAULT app.uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT app.current_tenant_id() NOT NULL,
	"auth_user_id" text,
	"display_name" text NOT NULL,
	"email" text NOT NULL,
	"job_title" text,
	"status" "tenant_user_status" DEFAULT 'invited' NOT NULL,
	"is_agency" boolean DEFAULT false NOT NULL,
	"mfa_required" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id(),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid DEFAULT app.current_user_id(),
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "tenant_user_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "tenant_user_tenant_auth_user_key" UNIQUE("tenant_id","auth_user_id"),
	CONSTRAINT "tenant_user_tenant_email_key" UNIQUE("tenant_id","email")
);
--> statement-breakpoint
ALTER TABLE "auth"."account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "about_me" ADD CONSTRAINT "about_me_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allergy" ADD CONSTRAINT "allergy_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_event" ADD CONSTRAINT "break_glass_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_event" ADD CONSTRAINT "break_glass_user_fk" FOREIGN KEY ("tenant_id","tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_photo_fk" FOREIGN KEY ("tenant_id","photo_document_id") REFERENCES "public"."document"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_assignment" ADD CONSTRAINT "person_assignment_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_assignment" ADD CONSTRAINT "person_assignment_user_fk" FOREIGN KEY ("tenant_id","tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement" ADD CONSTRAINT "placement_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."person"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement" ADD CONSTRAINT "placement_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."service"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement" ADD CONSTRAINT "placement_room_fk" FOREIGN KEY ("tenant_id","room_id") REFERENCES "public"."room"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room" ADD CONSTRAINT "room_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room" ADD CONSTRAINT "room_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_user_fk" FOREIGN KEY ("tenant_id","tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_granted_by_fk" FOREIGN KEY ("tenant_id","granted_by") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation_chain" ADD CONSTRAINT "escalation_chain_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flag" ADD CONSTRAINT "feature_flag_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flag" ADD CONSTRAINT "feature_flag_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submission" ADD CONSTRAINT "form_submission_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submission" ADD CONSTRAINT "form_submission_template_id_form_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."form_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_template" ADD CONSTRAINT "form_template_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_recipient_fk" FOREIGN KEY ("tenant_id","recipient_tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_escalation_chain_fk" FOREIGN KEY ("tenant_id","escalation_chain_id") REFERENCES "public"."escalation_chain"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_user_fk" FOREIGN KEY ("tenant_id","tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_table" ADD CONSTRAINT "rate_table_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_class" ADD CONSTRAINT "retention_class_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role" ADD CONSTRAINT "role_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignment" ADD CONSTRAINT "role_assignment_user_fk" FOREIGN KEY ("tenant_id","tenant_user_id") REFERENCES "public"."tenant_user"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignment" ADD CONSTRAINT "role_assignment_role_fk" FOREIGN KEY ("tenant_id","role_id") REFERENCES "public"."role"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignment" ADD CONSTRAINT "role_assignment_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."location"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_group_id_tenant_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."tenant_group"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_user" ADD CONSTRAINT "tenant_user_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "auth"."account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_user_id_idx" ON "auth"."passkey" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_credential_id_idx" ON "auth"."passkey" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "auth"."session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "two_factor_user_id_idx" ON "auth"."two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "auth"."verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "allergy_person_idx" ON "allergy" USING btree ("tenant_id","person_id");--> statement-breakpoint
CREATE INDEX "break_glass_user_person_idx" ON "break_glass_event" USING btree ("tenant_id","tenant_user_id","person_id");--> statement-breakpoint
CREATE INDEX "contact_person_idx" ON "contact" USING btree ("tenant_id","person_id");--> statement-breakpoint
CREATE INDEX "person_tenant_location_idx" ON "person" USING btree ("tenant_id","location_id");--> statement-breakpoint
CREATE INDEX "person_family_name_idx" ON "person" USING btree ("tenant_id","family_name");--> statement-breakpoint
CREATE INDEX "person_assignment_user_idx" ON "person_assignment" USING btree ("tenant_id","tenant_user_id");--> statement-breakpoint
CREATE INDEX "placement_person_idx" ON "placement" USING btree ("tenant_id","person_id");--> statement-breakpoint
CREATE INDEX "access_grant_user_idx" ON "access_grant" USING btree ("tenant_id","tenant_user_id");--> statement-breakpoint
CREATE INDEX "audit_event_tenant_seq_idx" ON "audit_event" USING btree ("tenant_id","seq");--> statement-breakpoint
CREATE INDEX "audit_event_resource_idx" ON "audit_event" USING btree ("tenant_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "form_submission_subject_idx" ON "form_submission" USING btree ("tenant_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "location_tenant_id_idx" ON "location" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "notification_recipient_unread_idx" ON "notification" USING btree ("tenant_id","recipient_tenant_user_id","created_at") WHERE read_at IS NULL;--> statement-breakpoint
CREATE INDEX "notification_escalate_idx" ON "notification" USING btree ("escalate_at") WHERE acknowledged_at IS NULL AND escalate_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "outbox_event_pending_idx" ON "outbox_event" USING btree ("available_at") WHERE published_at IS NULL;--> statement-breakpoint
CREATE INDEX "rate_table_lookup_idx" ON "rate_table" USING btree ("key","nation","valid_from");--> statement-breakpoint
CREATE INDEX "record_version_record_idx" ON "record_version" USING btree ("tenant_id","table_name","record_id");--> statement-breakpoint
CREATE INDEX "role_assignment_user_idx" ON "role_assignment" USING btree ("tenant_id","tenant_user_id");--> statement-breakpoint
CREATE INDEX "service_tenant_location_idx" ON "service" USING btree ("tenant_id","location_id");--> statement-breakpoint
CREATE INDEX "tenant_user_auth_user_idx" ON "tenant_user" USING btree ("auth_user_id");