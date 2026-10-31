variable "bucket_name" {
  description = "Globally unique bucket name."
  type        = string
}

variable "kms_key_arn" {
  description = "KMS key ARN for SSE-KMS. Leave null only for log buckets: S3 server access logs and ALB access logs can be delivered only to buckets using SSE-S3 (AES-256)."
  type        = string
  default     = null
}

variable "versioning_enabled" {
  description = "Keep every version of every object so that overwrites and deletions can be recovered."
  type        = bool
  default     = true
}

variable "access_logging" {
  description = "Write S3 server access logs for this bucket to access_log_bucket. False only for the log bucket itself."
  type        = bool
  default     = true
}

variable "access_log_bucket" {
  description = "Name of the bucket that receives S3 server access logs for this bucket."
  type        = string
  default     = null
}

variable "access_log_prefix" {
  description = "Key prefix for access logs written about this bucket. Defaults to s3/<bucket name>/."
  type        = string
  default     = null
}

variable "noncurrent_version_expiration_days" {
  description = "Days after which noncurrent object versions are permanently deleted."
  type        = number
  default     = 90
}

variable "current_version_expiration_days" {
  description = "Days after which current objects expire. Null keeps them until the application deletes them (retention is enforced by the application's retention engine)."
  type        = number
  default     = null
}

variable "object_lock_enabled" {
  description = "Enable S3 Object Lock (write once, read many). Can only be set when the bucket is created."
  type        = bool
  default     = false
}

variable "object_lock_mode" {
  description = "Default Object Lock retention mode: GOVERNANCE (privileged users can override) or COMPLIANCE (nobody can, including the root user)."
  type        = string
  default     = "GOVERNANCE"

  validation {
    condition     = contains(["GOVERNANCE", "COMPLIANCE"], var.object_lock_mode)
    error_message = "The Object Lock mode must be GOVERNANCE or COMPLIANCE."
  }
}

variable "object_lock_days" {
  description = "Default Object Lock retention in days."
  type        = number
  default     = 30
}

variable "allow_alb_access_logs" {
  description = "Grant Elastic Load Balancing permission to deliver ALB access logs under alb/."
  type        = bool
  default     = false
}

variable "allow_s3_access_logs_from_account" {
  description = "Grant the S3 logging service permission to deliver server access logs for buckets in this account under s3/."
  type        = bool
  default     = false
}

variable "eventbridge_notifications" {
  description = "Send object-level events to Amazon EventBridge (used for the antivirus scan on ingest)."
  type        = bool
  default     = true
}

variable "cors_allowed_origins" {
  description = "Origins allowed to use presigned URLs from a browser (for example https://app.example.invalid). Empty disables CORS."
  type        = list(string)
  default     = []
}

variable "force_destroy" {
  description = "Allow Terraform to delete a non-empty bucket. Never true for buckets that hold personal data outside dev."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Extra tags for the bucket."
  type        = map(string)
  default     = {}
}

variable "current_version_expiration_prefix" {
  description = "Only objects under this key prefix expire after current_version_expiration_days (empty: every object)."
  type        = string
  default     = ""
}
