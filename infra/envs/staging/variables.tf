variable "environment" {
  type    = string
  default = "staging"

  validation {
    condition     = var.environment == "staging"
    error_message = "This directory is the staging environment."
  }
}

variable "project_id" {
  description = "The staging Google Cloud project."
  type        = string
}

variable "region" {
  type    = string
  default = "europe-west2"

  validation {
    condition     = var.region == "europe-west2"
    error_message = "Harbour runs in europe-west2 (London) only."
  }
}

variable "data_classification" {
  type    = string
  default = "personal-special-category"
}

variable "extra_labels" {
  type    = map(string)
  default = {}
}

variable "safety_case_version" {
  description = "The signed safety case report this release runs under."
  type        = string
}

variable "domain_name" {
  type = string
}

variable "dns_zone_name" {
  description = "Cloud DNS zone in this project for domain_name (null: list the records instead)."
  type        = string
  default     = null
}

variable "create_dns_zone" {
  type    = bool
  default = false
}

variable "armor_rule_versions" {
  description = "Pinned Cloud Armor preconfigured rule versions (required in prod, human action H-140)."
  type        = map(string)
  default     = {}
}

variable "enable_flagsmith" {
  type    = bool
  default = false
}

variable "smtp" {
  description = "SMTP relay for outgoing email (null until a provider is chosen). The user and password are the smtp-user and smtp-password secrets."
  type = object({
    host = string
    port = number
    tls  = bool
  })
  default = null
}

variable "release_service_account" {
  description = "The GitHub release account from infra/bootstrap (null until the bootstrap is applied)."
  type        = string
  default     = null
}

variable "alert_email_addresses" {
  type    = list(string)
  default = []
}

variable "billing_account_id" {
  description = "Billing account for the budget (null: no budget)."
  type        = string
  default     = null
}

variable "budget_monthly_limit" {
  description = "Monthly budget in pounds sterling."
  type        = number
  default     = 1500
}
