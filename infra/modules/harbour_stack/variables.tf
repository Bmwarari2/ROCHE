# ---------------------------------------------------------------------------------------------
# Environment and naming
# ---------------------------------------------------------------------------------------------

variable "environment" {
  description = "Environment name."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "The environment must be dev, staging or prod."
  }
}

variable "safety_case_version" {
  description = "Harbour's clinical safety case the release runs under (a report in docs/clinical-safety/safety-case/, for example v0.0). The API refuses to start without it; organisations' DCB0160 assessments must cover it."
  type        = string
}

variable "domain_name" {
  description = "Base domain for this environment, for example dev.harbour.example. Hosts are app., api., sync. and flags. under it."
  type        = string
}

variable "elearning_domain_name" {
  description = "Registrable domain for the e-learning content origin (ADR-0093), for example harbour-learning.example: never domain_name or a domain under it, so package script is another site from the app and cannot set its cookies (security review H1). The content host is learn. under it. Null means no content origin: courses do not launch."
  type        = string
  default     = null
}

variable "elearning_route53_zone_id" {
  description = "Route 53 hosted zone for elearning_domain_name. Null means its DNS records are created by hand from the outputs."
  type        = string
  default     = null
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone for domain_name. Null means DNS records (certificate validation, aliases, SES) are created by hand from the outputs."
  type        = string
  default     = null
}

# ---------------------------------------------------------------------------------------------
# CI and state
# ---------------------------------------------------------------------------------------------

variable "github_repository" {
  description = "GitHub repository (owner/name) trusted by the OIDC roles."
  type        = string
  default     = "Bmwarari2/ROCHE"
}

variable "create_github_oidc_provider" {
  description = "Create the GitHub OIDC provider in this account (one per account)."
  type        = bool
  default     = true
}

variable "state_bucket_name" {
  description = "Terraform state bucket (from backend.hcl), so the CI roles can read and lock state."
  type        = string
}

variable "state_kms_key_arn" {
  description = "KMS key encrypting the state bucket."
  type        = string
  default     = null
}

variable "state_lock_table_name" {
  description = "DynamoDB lock table, if used instead of S3-native lock files."
  type        = string
  default     = null
}

# ---------------------------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------------------------

variable "vpc_cidr_block" {
  description = "VPC CIDR block."
  type        = string
  default     = "10.40.0.0/16"
}

variable "nat_gateway_per_az" {
  description = "One NAT gateway per availability zone (prod) instead of a single shared one (dev)."
  type        = bool
  default     = false
}

variable "interface_endpoint_az_count" {
  description = "Availability zones hosting interface endpoints."
  type        = number
  default     = 3
}

# ---------------------------------------------------------------------------------------------
# Databases
# ---------------------------------------------------------------------------------------------

variable "main_db_instance_class" {
  description = "Instance class of the main Harbour database."
  type        = string
  default     = "db.t4g.medium"
}

variable "main_db_allocated_storage" {
  description = "Initial storage of the main database in GiB."
  type        = number
  default     = 50
}

variable "main_db_max_allocated_storage" {
  description = "Storage autoscaling ceiling of the main database in GiB."
  type        = number
  default     = 200
}

variable "main_db_multi_az" {
  description = "Multi-AZ for the main database."
  type        = bool
  default     = true
}

variable "sync_storage_db_instance_class" {
  description = "Instance class of the PowerSync bucket-storage database."
  type        = string
  default     = "db.t4g.medium"
}

variable "sync_storage_db_allocated_storage" {
  description = "Initial storage of the PowerSync bucket-storage database in GiB."
  type        = number
  default     = 20
}

variable "sync_storage_db_multi_az" {
  description = "Multi-AZ for the bucket-storage database. It can be rebuilt from the main database, so single-AZ is acceptable outside prod."
  type        = bool
  default     = true
}

variable "db_deletion_protection" {
  description = "Deletion protection on both databases."
  type        = bool
  default     = true
}

variable "db_skip_final_snapshot" {
  description = "Skip final snapshots when a database is deleted."
  type        = bool
  default     = false
}

variable "db_performance_insights_retention_days" {
  description = "Performance Insights retention (7 days is free)."
  type        = number
  default     = 7
}

# ---------------------------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------------------------

variable "image_tags" {
  description = "Image tag overrides for api (also used by the worker and migration task) and web. When a service has no override, the tag comes from the SSM release pointer /harbour/<env>/release/<service>, which the deploy workflow updates."
  type        = map(string)
  default     = {}

  validation {
    condition     = alltrue([for k in keys(var.image_tags) : contains(["api", "web"], k)])
    error_message = "image_tags keys must be api or web."
  }
}

variable "initial_image_tag" {
  description = "Value given to a release pointer when it is first created, before any image has been pushed."
  type        = string
  default     = "bootstrap"
}

variable "powersync_version" {
  description = "journeyapps/powersync-service version, mirrored into ECR."
  type        = string
  default     = "1.26.1"
}

variable "powersync_image" {
  description = "Full PowerSync image reference. Null uses the ECR mirror (harbour/powersync-service:<powersync_version>)."
  type        = string
  default     = null
}

variable "enable_flagsmith" {
  description = "Run a self-hosted Flagsmith (OpenFeature provider) behind flags.<domain>. Optional, off by default."
  type        = bool
  default     = false
}

variable "flagsmith_version" {
  description = "flagsmith/flagsmith version, mirrored into ECR."
  type        = string
  default     = "2.280.0"
}

variable "cpu_architecture" {
  description = "CPU architecture of the Harbour images (api and web)."
  type        = string
  default     = "X86_64"
}

variable "service_sizes" {
  description = "Per-service CPU, memory and autoscaling bounds. Missing services use the defaults in locals."
  type = map(object({
    cpu    = number
    memory = number
    min    = number
    max    = number
  }))
  default = {}
}

variable "use_fargate_spot" {
  description = "Run services on Fargate Spot (dev only)."
  type        = bool
  default     = false
}

variable "api_health_check_path" {
  description = "API health check path."
  type        = string
  default     = "/health"
}

variable "web_health_check_path" {
  description = "Web health check path."
  type        = string
  default     = "/api/health"
}

variable "web_writable_paths" {
  description = "Writable scratch paths for the Next.js container (read-only root filesystem)."
  type        = list(string)
  default     = ["/tmp", "/app/apps/web/.next/cache"]
}

variable "api_command" {
  description = "Command of the API service (api image)."
  type        = list(string)
  default     = ["node", "apps/api/dist/server.js"]
}

variable "worker_command" {
  description = "Command of the pg-boss worker service (api image)."
  type        = list(string)
  default     = ["node", "apps/api/dist/worker.js"]
}

variable "migrate_command" {
  description = "Command of the one-off bootstrap and migration task (api image): db:bootstrap as the RDS master user, then migrations as harbour_owner."
  type        = list(string)
  default     = ["node", "apps/api/dist/migrate.js"]
}

variable "rds_ca_bundle_path" {
  description = "Path, inside the api image, of the AWS RDS CA bundle (https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem). Set as NODE_EXTRA_CA_CERTS so sslmode=verify-full succeeds."
  type        = string
  default     = "/app/certs/rds-global-bundle.pem"
}

variable "sync_jwt_audience" {
  description = "Audience (aud) the API puts in PowerSync JWTs and PowerSync requires."
  type        = string
  default     = "harbour-powersync"
}

variable "sync_config_path" {
  description = "Path to the PowerSync sync config. Null uses packages/sync/src/streams/sync-config.yaml in this repository."
  type        = string
  default     = null
}

# ---------------------------------------------------------------------------------------------
# Edge, logging, alerting and cost
# ---------------------------------------------------------------------------------------------

variable "waf_rate_limit_per_5_minutes" {
  description = "Per-IP request limit in any 5-minute window. Generous because every device in a care home usually shares one public IP address."
  type        = number
  default     = 5000
}

variable "waf_managed_rule_group_versions" {
  description = "Static versions for the AWS managed rule groups in both web ACLs, by group name (for example AWSManagedRulesCommonRuleSet = \"Version_1.15\"). Required in prod for every group whose rules block with the edge_blocked body, so a new AWS default version cannot change what blocks without a review (security review round 5, S-L5). The values are read from the account with aws wafv2 list-available-managed-rule-group-versions (human action H-140)."
  type        = map(string)
  default     = {}
}

variable "waf_managed_rule_groups_unversioned" {
  description = "AWS managed rule groups that block but cannot take a static version, by group name, each with the reason (for example, AWS publishes no versions for it). They are left out of the prod pin check, and nothing else is. Used only when the account shows the group has no versions (human action H-140)."
  type        = map(string)
  default     = {}

  validation {
    condition     = alltrue([for reason in values(var.waf_managed_rule_groups_unversioned) : length(trimspace(reason)) >= 10])
    error_message = "Give each unversioned rule group a reason of at least 10 characters."
  }
}

variable "alb_deletion_protection" {
  description = "Deletion protection on the load balancer."
  type        = bool
  default     = true
}

variable "log_retention_days" {
  description = "Retention of application, audit and security logs (at least 180 days)."
  type        = number
  default     = 365
}

variable "protect_log_groups" {
  description = "Deletion protection on log groups."
  type        = bool
  default     = false
}

variable "audit_archive_lock_mode" {
  description = "Object Lock mode for the audit archive bucket: GOVERNANCE (dev, staging) or COMPLIANCE (prod)."
  type        = string
  default     = "GOVERNANCE"
}

variable "audit_archive_lock_days" {
  description = "Default Object Lock retention for audit archive objects."
  type        = number
  default     = 30
}

variable "force_destroy_buckets" {
  description = "Allow Terraform to delete non-empty buckets. Only for dev, which holds synthetic data only."
  type        = bool
  default     = false
}

variable "alert_email_addresses" {
  description = "Team mailboxes subscribed to alarms."
  type        = list(string)
  default     = []
}

variable "budget_monthly_limit" {
  description = "Monthly AWS cost budget for this account (USD unless the account bills in another currency)."
  type        = number
}

variable "budget_email_addresses" {
  description = "Mailboxes notified when the budget thresholds are crossed."
  type        = list(string)
  default     = []
}
