variable "name_prefix" {
  description = "Prefix for key aliases, for example harbour-dev."
  type        = string
}

variable "purposes" {
  description = "One customer-managed key is created per purpose. rds, s3, logs and secrets are mandatory; ecr and alerts are used by the stack for container images and the SNS alert topic."
  type        = set(string)
  default     = ["rds", "s3", "logs", "secrets", "ecr", "alerts"]

  validation {
    condition     = length(setsubtract(["rds", "s3", "logs", "secrets"], var.purposes)) == 0
    error_message = "The purposes set must include rds, s3, logs and secrets."
  }
}

variable "deletion_window_in_days" {
  description = "Waiting period before a scheduled key deletion completes. 30 days gives the most time to notice a mistake."
  type        = number
  default     = 30

  validation {
    condition     = var.deletion_window_in_days >= 7 && var.deletion_window_in_days <= 30
    error_message = "The deletion window must be between 7 and 30 days."
  }
}

variable "rotation_period_in_days" {
  description = "Automatic rotation period. Section 5.3 requires keys to be rotated at least yearly."
  type        = number
  default     = 365

  validation {
    condition     = var.rotation_period_in_days >= 90 && var.rotation_period_in_days <= 365
    error_message = "The rotation period must be between 90 and 365 days."
  }
}
