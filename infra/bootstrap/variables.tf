variable "environment" {
  type = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging or prod."
  }
}

variable "project_id" {
  description = "The environment's project."
  type        = string
}

variable "folder_id" {
  description = "Folder that holds the Harbour projects. When set, its log storage location is London and new projects get no _Default sink (set it before the projects are created)."
  type        = string
  default     = null
}

variable "enforce_resource_locations" {
  description = "Set gcp.resourceLocations to europe-west2 locations on the project."
  type        = bool
  default     = true
}

variable "block_service_account_keys" {
  description = "Set iam.disableServiceAccountKeyCreation on the project."
  type        = bool
  default     = true
}

variable "allowed_locations" {
  type    = list(string)
  default = ["in:europe-west2-locations"]
}

variable "github_repository" {
  type    = string
  default = "Bmwarari2/ROCHE"
}

variable "github_repository_id" {
  description = "gh api repos/Bmwarari2/ROCHE --jq .id"
  type        = string
}

variable "github_repository_owner_id" {
  description = "gh api repos/Bmwarari2/ROCHE --jq .owner.id"
  type        = string
}

variable "state_bucket_name" {
  description = "The state bucket, in the separate state project."
  type        = string
}
