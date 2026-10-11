variable "identifier" {
  description = "RDS instance identifier, for example harbour-dev-main."
  type        = string
}

variable "engine_version" {
  description = "Postgres engine version. A major version alone lets RDS pick the current minor and apply minor upgrades in the maintenance window."
  type        = string
  default     = "17"

  validation {
    condition     = startswith(var.engine_version, "17")
    error_message = "Harbour runs Postgres 17 (ADR-0001); a major upgrade needs a new ADR and a new parameter group family."
  }
}

variable "instance_class" {
  description = "Instance class. Performance Insights is not available on t-class micro or small sizes."
  type        = string
  default     = "db.t4g.medium"
}

variable "allocated_storage" {
  description = "Initial gp3 storage in GiB."
  type        = number
  default     = 50
}

variable "max_allocated_storage" {
  description = "Upper bound for storage autoscaling in GiB."
  type        = number
  default     = 200
}

variable "multi_az" {
  description = "Run a synchronous standby in a second availability zone. This is the disaster-recovery stance (section 6), so it defaults to true."
  type        = bool
  default     = true
}

variable "db_name" {
  description = "Name of the initial database."
  type        = string
}

variable "master_username" {
  description = "Master user name. Its password is generated, stored and rotated by RDS in Secrets Manager."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID."
  type        = string
}

variable "subnet_ids" {
  description = "Isolated data subnet IDs for the DB subnet group."
  type        = list(string)
}

variable "allowed_security_group_ids" {
  description = "Security groups allowed to connect on 5432, keyed by a static name (for example api, worker, powersync)."
  type        = map(string)
  default     = {}
}

variable "kms_key_arn" {
  description = "KMS key ARN (rds purpose) for storage, snapshots and Performance Insights."
  type        = string
}

variable "secrets_kms_key_arn" {
  description = "KMS key ARN (secrets purpose) for the RDS-managed master user secret."
  type        = string
}

variable "logs_kms_key_arn" {
  description = "KMS key ARN (logs purpose) for the exported Postgres log groups."
  type        = string
}

variable "log_retention_days" {
  description = "Retention for exported Postgres logs, which carry pgAudit records. Security logs are kept at least 6 months."
  type        = number
  default     = 365

  validation {
    condition     = var.log_retention_days >= 180
    error_message = "Security logs must be retained for at least 180 days."
  }
}

variable "backup_retention_days" {
  description = "Automated backup and point-in-time recovery window. Section 7 sets 35 days."
  type        = number
  default     = 35

  validation {
    condition     = var.backup_retention_days >= 7 && var.backup_retention_days <= 35
    error_message = "Backup retention must be between 7 and 35 days."
  }
}

variable "backup_window" {
  description = "Daily backup window in UTC."
  type        = string
  default     = "01:00-02:00"
}

variable "maintenance_window" {
  description = "Weekly maintenance window in UTC; must not overlap the backup window."
  type        = string
  default     = "sun:03:00-sun:04:00"
}

variable "deletion_protection" {
  description = "Block deletion of the instance."
  type        = bool
  default     = true
}

variable "skip_final_snapshot" {
  description = "Skip the final snapshot on deletion. Only ever true for throwaway environments."
  type        = bool
  default     = false
}

variable "performance_insights_retention_days" {
  description = "Performance Insights retention: 7 days is free; 31 days or more is chargeable."
  type        = number
  default     = 7
}

variable "monitoring_interval" {
  description = "Enhanced monitoring interval in seconds (1, 5, 10, 15, 30 or 60)."
  type        = number
  default     = 60

  validation {
    condition     = contains([1, 5, 10, 15, 30, 60], var.monitoring_interval)
    error_message = "Enhanced monitoring must be enabled with an interval of 1, 5, 10, 15, 30 or 60 seconds."
  }
}

variable "logical_replication" {
  description = "Enable logical replication (rds.logical_replication) so that PowerSync can stream changes. Only the main database needs it."
  type        = bool
  default     = false
}

variable "max_slot_wal_keep_size_mb" {
  description = "Upper bound on WAL kept for a lagging replication slot (MB). Stops a stalled PowerSync slot filling the disk; PowerSync re-snapshots if its slot is invalidated."
  type        = number
  default     = 20480
}

variable "extra_parameters" {
  description = "Additional parameter group settings, keyed by parameter name."
  type = map(object({
    value        = string
    apply_method = optional(string, "immediate")
  }))
  default = {}
}

variable "apply_immediately" {
  description = "Apply modifications immediately instead of in the next maintenance window."
  type        = bool
  default     = false
}
