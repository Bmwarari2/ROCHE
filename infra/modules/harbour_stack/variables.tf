# ---------------------------------------------------------------------------------------------
# Where and what
# ---------------------------------------------------------------------------------------------

variable "project_id" {
  description = "The Google Cloud project for this environment (one project per environment)."
  type        = string
}

variable "region" {
  description = "The only region. Personal data may not leave the UK."
  type        = string
  default     = "europe-west2"

  validation {
    condition     = var.region == "europe-west2"
    error_message = "The Harbour stack must be deployed to europe-west2 (London); personal data may not leave the UK."
  }
}

variable "environment" {
  type = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging or prod."
  }
}

variable "domain_name" {
  description = "The environment's domain; app., api., sync. and flags. are created under it."
  type        = string
}

variable "dns_zone_name" {
  description = "Cloud DNS zone in this project that holds domain_name (null: the records are listed for the domain's own DNS)."
  type        = string
  default     = null
}

variable "create_dns_zone" {
  description = "Create the Cloud DNS zone named dns_zone_name (false: it exists already)."
  type        = bool
  default     = false
}

variable "safety_case_version" {
  description = "The signed safety case report this release runs under (docs/clinical-safety/safety-case/)."
  type        = string
}

variable "enforce_resource_locations" {
  description = "Set the gcp.resourceLocations and no-key organisation policies on the project."
  type        = bool
  default     = true
}

variable "labels" {
  type    = map(string)
  default = {}
}

# ---------------------------------------------------------------------------------------------
# GitHub, state and cost
# ---------------------------------------------------------------------------------------------

variable "github_repository" {
  type    = string
  default = "Bmwarari2/ROCHE"
}

variable "state_bucket_name" {
  description = "The versioned GCS bucket holding Terraform state (created by the bootstrap step)."
  type        = string
}

variable "billing_account_id" {
  description = "Billing account for the budget (null: no budget)."
  type        = string
  default     = null
}

variable "budget_monthly_limit" {
  description = "Monthly budget in pounds sterling."
  type        = number
}

variable "alert_email_addresses" {
  type    = list(string)
  default = []
}

# ---------------------------------------------------------------------------------------------
# Images and services
# ---------------------------------------------------------------------------------------------

variable "initial_image_tag" {
  description = "Tag of the api and web images for the first apply. The deploy workflow changes images after that; Terraform ignores them."
  type        = string
  default     = "bootstrap"
}

variable "powersync_version" {
  type    = string
  default = "1.26.1"
}

variable "flagsmith_version" {
  type    = string
  default = "2.280.0"
}

variable "clamav_image" {
  description = "ClamAV image run beside the API, copied into Artifact Registry (null: <repository>/clamav:<clamav_version>)."
  type        = string
  default     = null
}

variable "clamav_version" {
  type    = string
  default = "1.4"
}

variable "enable_flagsmith" {
  description = "Run the optional Flagsmith service (off by default)."
  type        = bool
  default     = false
}

variable "service_sizes" {
  description = "Cloud Run sizes by service (cpu as a string, memory like 1Gi, min and max instances)."
  type = map(object({
    cpu    = string
    memory = string
    min    = number
    max    = number
  }))
  default = {}
}

variable "api_command" {
  type    = list(string)
  default = ["node", "apps/api/dist/server.js"]
}

variable "worker_command" {
  type    = list(string)
  default = ["node", "apps/api/dist/worker.js"]
}

variable "migrate_command" {
  type    = list(string)
  default = ["node", "apps/api/dist/migrate.js"]
}

variable "api_health_check_path" {
  type    = string
  default = "/health"
}

variable "web_health_check_path" {
  type    = string
  default = "/api/health"
}

variable "sync_jwt_audience" {
  type    = string
  default = "harbour-sync"
}

variable "sync_config_path" {
  description = "PowerSync sync streams file (null: packages/sync/src/streams/sync-config.yaml)."
  type        = string
  default     = null
}

variable "deletion_protection" {
  description = "Protect Cloud Run services and jobs from terraform destroy."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------------------------
# Network and databases
# ---------------------------------------------------------------------------------------------

variable "subnet_cidr" {
  type    = string
  default = "10.42.0.0/20"
}

variable "main_db_tier" {
  type    = string
  default = "db-custom-2-7680"
}

variable "sync_storage_db_tier" {
  type    = string
  default = "db-custom-1-3840"
}

variable "db_edition" {
  description = "ENTERPRISE (point-in-time recovery up to 7 days) or ENTERPRISE_PLUS (up to 35)."
  type        = string
  default     = "ENTERPRISE"
}

variable "db_pitr_days" {
  type    = number
  default = 7
}

variable "db_high_availability" {
  type    = bool
  default = true
}

variable "main_db_disk_gb" {
  type    = number
  default = 20
}

variable "sync_storage_db_disk_gb" {
  type    = number
  default = 20
}

variable "db_deletion_protection" {
  type    = bool
  default = true
}

# ---------------------------------------------------------------------------------------------
# Buckets and logs
# ---------------------------------------------------------------------------------------------

variable "force_destroy_buckets" {
  type    = bool
  default = false
}

variable "audit_archive_retention_days" {
  description = "Write-once retention of the audit archive (section 5.5)."
  type        = number
  default     = 365
}

variable "lock_audit_archive" {
  description = "Lock the audit archive's retention policy. Irreversible, so only prod may set it; null means true in prod and false elsewhere."
  type        = bool
  default     = null
}

variable "security_log_retention_days" {
  type    = number
  default = 400
}

variable "app_log_retention_days" {
  type    = number
  default = 30
}

variable "lock_security_logs" {
  description = "Lock the security log bucket. Irreversible; null means true in prod and false elsewhere."
  type        = bool
  default     = null
}

# ---------------------------------------------------------------------------------------------
# Edge
# ---------------------------------------------------------------------------------------------

variable "armor_rule_versions" {
  description = "Pinned Cloud Armor preconfigured rule versions, by rule (for example sqli = \"v33-stable\"). Every rule must be pinned in prod (human action)."
  type        = map(string)
  default     = {}
}

variable "armor_rate_limit_per_minute" {
  type    = number
  default = 600
}

# ---------------------------------------------------------------------------------------------
# Email (no Google Cloud service: an SMTP provider in the UK, on the sub-processor register)
# ---------------------------------------------------------------------------------------------

variable "smtp" {
  description = "SMTP relay for outgoing email (the password is the smtp-password secret)."
  type = object({
    host = string
    port = number
    user = string
  })
  default = null
}

variable "email_from_domain" {
  description = "Domain mail is sent from (null: domain_name)."
  type        = string
  default     = null
}
