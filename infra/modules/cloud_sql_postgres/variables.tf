variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "europe-west2"

  validation {
    condition     = var.region == "europe-west2"
    error_message = "Cloud SQL runs in europe-west2 only."
  }
}

variable "name" {
  type = string
}

variable "database_name" {
  type = string
}

variable "tier" {
  description = "Machine type, for example db-custom-2-8192."
  type        = string
}

variable "edition" {
  description = "ENTERPRISE (point-in-time recovery up to 7 days) or ENTERPRISE_PLUS (up to 35 days)."
  type        = string
  default     = "ENTERPRISE"

  validation {
    condition     = contains(["ENTERPRISE", "ENTERPRISE_PLUS"], var.edition)
    error_message = "edition must be ENTERPRISE or ENTERPRISE_PLUS."
  }
}

variable "high_availability" {
  description = "Regional availability: a standby in a second zone with synchronous replication."
  type        = bool
  default     = true
}

variable "disk_size_gb" {
  type    = number
  default = 20
}

variable "disk_autoresize_limit_gb" {
  type    = number
  default = 0
}

variable "network_id" {
  description = "VPC the instance gets its private IP on."
  type        = string
}

variable "private_services_connection" {
  description = "The private services access connection, so the instance waits for it."
  type        = string
}

variable "kms_key_id" {
  description = "Key for the data disk and backups (CMEK)."
  type        = string
}

variable "backup_retained_count" {
  type    = number
  default = 14
}

variable "transaction_log_retention_days" {
  description = "Point-in-time recovery window (at most 7 on ENTERPRISE, 35 on ENTERPRISE_PLUS)."
  type        = number
  default     = 7
}

variable "logical_decoding" {
  description = "Turn on logical decoding (PowerSync replicates from this instance)."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "query_insights" {
  type    = bool
  default = true
}

variable "labels" {
  type    = map(string)
  default = {}
}
