variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "europe-west2"
}

variable "name_prefix" {
  type = string
}

variable "alert_email_addresses" {
  type    = list(string)
  default = []
}

variable "security_log_retention_days" {
  description = "Audit and Cloud Armor logs (section 5.3 sets at least six months; Harbour keeps 400 days)."
  type        = number
  default     = 400

  validation {
    condition     = var.security_log_retention_days >= 400
    error_message = "Security logs are kept for at least 400 days."
  }
}

variable "app_log_retention_days" {
  type    = number
  default = 30
}

variable "kms_key_id" {
  description = "Key that encrypts both log buckets (CMEK)."
  type        = string
}

variable "lock_security_logs" {
  description = "Lock the security log bucket's retention. Irreversible."
  type        = bool
  default     = false
}

variable "worker_service_name" {
  description = "Cloud Run service whose structured logs carry the worker's events."
  type        = string
}

variable "api_service_name" {
  type = string
}

variable "sql_instances" {
  description = "Cloud SQL instance names, by purpose."
  type        = map(string)
}

variable "always_on_services" {
  description = "Cloud Run services that must keep at least one instance (worker, PowerSync)."
  type        = list(string)
  default     = []
}
