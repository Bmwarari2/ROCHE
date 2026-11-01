variable "project_id" {
  type = string
}

variable "name" {
  description = "Globally unique bucket name."
  type        = string
}

variable "location" {
  description = "Bucket location: a single region, never a multi-region."
  type        = string
  default     = "EUROPE-WEST2"

  validation {
    condition     = upper(var.location) == "EUROPE-WEST2"
    error_message = "Buckets are created in europe-west2 only: personal data may not leave the UK."
  }
}

variable "kms_key_id" {
  description = "Default key for objects (CMEK)."
  type        = string
}

variable "versioning" {
  type    = bool
  default = true
}

variable "delete_after_days" {
  description = "Delete live objects this many days after they are written (null keeps them)."
  type        = number
  default     = null
}

variable "delete_after_days_prefix" {
  description = "Only objects under these prefixes are deleted by delete_after_days (empty: all)."
  type        = list(string)
  default     = []
}

variable "noncurrent_delete_after_days" {
  description = "Delete noncurrent versions this many days after they become noncurrent (null keeps them)."
  type        = number
  default     = 30
}

variable "retention_days" {
  description = "Retention policy: objects cannot be deleted or replaced for this many days (null: none)."
  type        = number
  default     = null
}

variable "lock_retention_policy" {
  description = "Lock the retention policy. Irreversible: the policy can then never be shortened or removed, and the bucket cannot be deleted while objects are retained."
  type        = bool
  default     = false
}

variable "cors_origins" {
  description = "Origins allowed to upload with signed URLs (CORS)."
  type        = list(string)
  default     = []
}

variable "access_log_bucket" {
  description = "Bucket for usage logs (null: none)."
  type        = string
  default     = null
}

variable "soft_delete_days" {
  description = "Deleted objects stay restorable for this many days (0 turns soft delete off)."
  type        = number
  default     = 7
}

variable "force_destroy" {
  description = "Allow terraform destroy to remove a bucket that still holds objects (dev only)."
  type        = bool
  default     = false
}

variable "labels" {
  type    = map(string)
  default = {}
}
