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

variable "rate_limit_retry_after_seconds" {
  description = "Retry-After sent with the rate limit's 429: how long a client waits before trying again."
  type        = number
  default     = 300

  validation {
    condition     = var.rate_limit_retry_after_seconds >= 60 && var.rate_limit_retry_after_seconds <= 900
    error_message = "Retry-After must be from 60 to 900 seconds."
  }
}

variable "managed_rule_group_versions" {
  description = "Static versions to pin AWS managed rule groups to, by group name (for example AWSManagedRulesCommonRuleSet = \"Version_1.15\"), read from `aws wafv2 list-available-managed-rule-group-versions` before each change. A group not listed follows AWS's default version. Pin each group once its version is confirmed in the account, and review managed_rule_blocks when a pin moves."
  type        = map(string)
  default     = {}

  validation {
    condition     = alltrue([for v in values(var.managed_rule_group_versions) : can(regex("^Version_[0-9]+\\.[0-9]+$", v))])
    error_message = "Managed rule group versions look like Version_1.15."
  }
}

variable "managed_rule_blocks" {
  description = "Per AWS managed rule group, the rules that block with the edge_blocked JSON body (AWS WAF Developer Guide, baseline, IP reputation and use-case rule groups). A rule not listed keeps its own action. Rules that only count are left out."
  type        = map(list(string))
  default = {
    AWSManagedRulesAmazonIpReputationList = [
      "AWSManagedIPReputationList",
      "AWSManagedReconnaissanceList",
    ]
    AWSManagedRulesCommonRuleSet = [
      "NoUserAgent_HEADER",
      "UserAgent_BadBots_HEADER",
      "SizeRestrictions_QUERYSTRING",
      "SizeRestrictions_Cookie_HEADER",
      "SizeRestrictions_BODY",
      "SizeRestrictions_URIPATH",
      "EC2MetaDataSSRF_BODY",
      "EC2MetaDataSSRF_COOKIE",
      "EC2MetaDataSSRF_URIPATH",
      "EC2MetaDataSSRF_QUERYARGUMENTS",
      "GenericLFI_QUERYARGUMENTS",
      "GenericLFI_URIPATH",
      "GenericLFI_BODY",
      "RestrictedExtensions_URIPATH",
      "RestrictedExtensions_QUERYARGUMENTS",
      "GenericRFI_QUERYARGUMENTS",
      "GenericRFI_BODY",
      "GenericRFI_URIPATH",
      "CrossSiteScripting_COOKIE",
      "CrossSiteScripting_QUERYARGUMENTS",
      "CrossSiteScripting_BODY",
      "CrossSiteScripting_URIPATH",
    ]
    AWSManagedRulesKnownBadInputsRuleSet = [
      "JavaDeserializationRCE_HEADER",
      "JavaDeserializationRCE_BODY",
      "JavaDeserializationRCE_URIPATH",
      "JavaDeserializationRCE_QUERYSTRING",
      "Host_localhost_HEADER",
      "PROPFIND_METHOD",
      "ExploitablePaths_URIPATH",
      "Log4JRCE_HEADER",
      "Log4JRCE_QUERYSTRING",
      "Log4JRCE_BODY",
      "Log4JRCE_URIPATH",
      "ReactJSRCE_BODY",
    ]
    AWSManagedRulesSQLiRuleSet = [
      "SQLi_QUERYARGUMENTS",
      "SQLiExtendedPatterns_QUERYARGUMENTS",
      "SQLi_BODY",
      "SQLiExtendedPatterns_BODY",
      "SQLiExtendedPatterns_HEADER",
      "SQLiExtendedPatterns_URIPATH",
      "SQLi_COOKIE",
      "SQLi_URIPATH",
    ]
  }
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
