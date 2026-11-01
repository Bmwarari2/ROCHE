variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "europe-west2"
}

variable "repository_id" {
  type = string
}

variable "kms_key_id" {
  type = string
}

variable "untagged_retention_days" {
  description = "Untagged images older than this are deleted."
  type        = number
  default     = 30
}
