variable "name_prefix" {
  description = "Prefix for role and policy names, for example harbour-dev. Must start with harbour- because the deploy role may only manage IAM resources named harbour-*."
  type        = string

  validation {
    condition     = startswith(var.name_prefix, "harbour-")
    error_message = "The name prefix must start with harbour-."
  }
}

variable "github_repository" {
  description = "The only GitHub repository (owner/name) allowed to assume the roles."
  type        = string
  default     = "Bmwarari2/ROCHE"
}

variable "deploy_branch" {
  description = "The only branch whose workflows may assume the deploy (apply) role."
  type        = string
  default     = "main"
}

variable "create_oidc_provider" {
  description = "Create the GitHub OIDC identity provider. Set false if the account already has one and pass its ARN."
  type        = bool
  default     = true
}

variable "existing_oidc_provider_arn" {
  description = "ARN of an existing GitHub OIDC provider when create_oidc_provider is false."
  type        = string
  default     = null
}

variable "state_bucket_name" {
  description = "S3 bucket holding Terraform state (created by the bootstrap step, not by this configuration)."
  type        = string
}

variable "state_kms_key_arn" {
  description = "KMS key ARN encrypting the state bucket. Null when the state bucket uses SSE-S3."
  type        = string
  default     = null
}

variable "state_lock_table_name" {
  description = "DynamoDB lock table name, if DynamoDB locking is used instead of S3-native lock files."
  type        = string
  default     = null
}

variable "region" {
  description = "Home region. Regional services may only be changed here; us-east-1 is allowed only for the CloudFront certificate and WAF."
  type        = string
  default     = "eu-west-2"
}

variable "max_session_duration" {
  description = "Maximum session length in seconds for both roles."
  type        = number
  default     = 3600
}
