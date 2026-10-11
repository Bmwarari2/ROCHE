variable "environment" {
  description = "Environment name; fixed for this directory."
  type        = string
  default     = "prod"

  validation {
    condition     = var.environment == "prod"
    error_message = "This directory deploys the prod environment only."
  }
}

variable "region" {
  description = "AWS region. Fixed to London: personal data must stay in the UK (section 6)."
  type        = string
  default     = "eu-west-2"

  validation {
    condition     = var.region == "eu-west-2"
    error_message = "Harbour runs only in eu-west-2 (London)."
  }
}

variable "aws_account_id" {
  description = "The only AWS account this configuration may touch (the prod account)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "The AWS account ID must be 12 digits."
  }
}

variable "data_classification" {
  description = "DataClassification tag: internal (synthetic data only), confidential (anonymised production-like data) or special-category (live health and social care data, UK GDPR Article 9)."
  type        = string
  default     = "special-category"

  validation {
    condition     = contains(["internal", "confidential", "special-category"], var.data_classification)
    error_message = "The data classification must be internal, confidential or special-category."
  }
}

variable "extra_tags" {
  description = "Additional default tags. Project, Environment, Owner and DataClassification are always set and cannot be overridden here."
  type        = map(string)
  default     = {}
}

variable "domain_name" {
  description = "Base domain for this environment; hosts are app., api., sync. and flags. under it."
  type        = string
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone for domain_name, or null to create DNS records by hand from the manual_dns_records output."
  type        = string
  default     = null
}

variable "image_tags" {
  description = "Optional image tag overrides for api, worker and web. Normally empty: tags come from the SSM release pointers the deploy workflow updates."
  type        = map(string)
  default     = {}
}

variable "enable_flagsmith" {
  description = "Run self-hosted Flagsmith behind flags.<domain>."
  type        = bool
  default     = false
}

variable "github_repository" {
  description = "GitHub repository trusted by the OIDC roles."
  type        = string
  default     = "Bmwarari2/ROCHE"
}

variable "create_github_oidc_provider" {
  description = "Create the GitHub OIDC provider (false if the account already has one)."
  type        = bool
  default     = true
}

variable "state_bucket_name" {
  description = "Terraform state bucket (the same value as bucket in backend.hcl)."
  type        = string
}

variable "state_kms_key_arn" {
  description = "KMS key ARN of the state bucket (the same key as kms_key_id in backend.hcl)."
  type        = string
  default     = null
}

variable "state_lock_table_name" {
  description = "DynamoDB lock table, only if backend.hcl uses dynamodb_table instead of use_lockfile."
  type        = string
  default     = null
}

variable "alert_email_addresses" {
  description = "Team mailboxes subscribed to alarms."
  type        = list(string)
  default     = []
}

variable "budget_monthly_limit" {
  description = "Monthly cost budget for the prod account, in the account's billing currency."
  type        = number
  default     = 4000
}

variable "budget_email_addresses" {
  description = "Mailboxes notified when budget thresholds are crossed."
  type        = list(string)
  default     = []
}
