variable "name" {
  description = "Web ACL name."
  type        = string
}

variable "scope" {
  description = "REGIONAL for the ALB (created in eu-west-2) or CLOUDFRONT (must be created in us-east-1 through a provider alias)."
  type        = string

  validation {
    condition     = contains(["REGIONAL", "CLOUDFRONT"], var.scope)
    error_message = "The scope must be REGIONAL or CLOUDFRONT."
  }
}

variable "rate_limit_per_5_minutes" {
  description = "Requests allowed per client IP in any 5-minute window before it is blocked."
  type        = number
  default     = 2000

  validation {
    condition     = var.rate_limit_per_5_minutes >= 10
    error_message = "The rate limit must be at least 10 requests per 5 minutes."
  }
}

variable "common_rule_count_overrides" {
  description = "Rules in the common rule set switched to count-only. SizeRestrictions_BODY would block legitimate JSON bodies over 8 KB (care plans); uploads go straight to S3 by presigned URL."
  type        = list(string)
  default     = ["SizeRestrictions_BODY"]
}

variable "sampled_requests_enabled" {
  description = "Keep a sample of matching requests (with client IPs and headers) for 3 hours in the WAF console. Off for CLOUDFRONT scope because samples are held in us-east-1."
  type        = bool
  default     = true
}

variable "enable_logging" {
  description = "Write blocked and counted requests to a KMS-encrypted CloudWatch log group in the same region. Only enable for REGIONAL scope (eu-west-2) so request data stays in London."
  type        = bool
  default     = false
}

variable "log_kms_key_arn" {
  description = "KMS key ARN (logs purpose) for the WAF log group. Required when logging is enabled."
  type        = string
  default     = null
}

variable "log_retention_days" {
  description = "WAF log retention in days."
  type        = number
  default     = 365

  validation {
    condition     = var.log_retention_days >= 180
    error_message = "Security logs must be retained for at least 180 days."
  }
}
