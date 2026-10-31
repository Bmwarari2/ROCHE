variable "project_id" {
  type = string
}

variable "environment" {
  description = "dev, staging or prod: each environment trusts its own GitHub environments only."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging or prod."
  }
}

variable "github_repository" {
  description = "owner/name of the only repository that may sign in."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$", var.github_repository))
    error_message = "github_repository must be owner/name."
  }
}

variable "github_repository_id" {
  description = "The repository's numeric id (gh api repos/<owner>/<name> --jq .id): unlike the name, it cannot be taken over after a rename."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.github_repository_id))
    error_message = "github_repository_id is the repository's numeric id."
  }
}

variable "github_repository_owner_id" {
  description = "The owner's numeric id (gh api repos/<owner>/<name> --jq .owner.id)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.github_repository_owner_id))
    error_message = "github_repository_owner_id is the owner's numeric id."
  }
}

variable "workflow_path" {
  description = "The only workflow that may sign in."
  type        = string
  default     = ".github/workflows/terraform.yml"
}

variable "state_bucket_name" {
  description = "The Terraform state bucket (in the separate state project, so the deny policy below never blocks reading state)."
  type        = string
}

variable "deploy_roles" {
  description = "Project roles for the apply account. No basic roles and no project IAM: the stack grants only on resources (keys, buckets, secrets, accounts, the registry), and project IAM, organisation policy and Workload Identity Federation are applied by a person in infra/bootstrap."
  type        = set(string)
  default = [
    "roles/artifactregistry.admin",
    "roles/certificatemanager.owner",
    "roles/cloudkms.admin",
    "roles/cloudsql.admin",
    "roles/compute.admin",
    "roles/dns.admin",
    "roles/iam.serviceAccountAdmin",
    "roles/iam.serviceAccountUser",
    "roles/logging.configWriter",
    "roles/monitoring.alertPolicyEditor",
    "roles/monitoring.notificationChannelEditor",
    "roles/run.admin",
    "roles/secretmanager.admin",
    "roles/serviceusage.serviceUsageAdmin",
    "roles/servicenetworking.networksAdmin",
    "roles/storage.admin",
  ]

  validation {
    condition = length(setintersection(var.deploy_roles, [
      "roles/owner", "roles/editor", "roles/orgpolicy.policyAdmin", "roles/iam.workloadIdentityPoolAdmin", "roles/iam.denyAdmin",
      "roles/resourcemanager.projectIamAdmin", "roles/iam.securityAdmin",
    ])) == 0
    error_message = "The apply account never gets a basic role, and never manages project IAM, organisation policy, Workload Identity Federation or deny policies."
  }
}

variable "release_roles" {
  description = "Project roles for the release account (new revisions and the migration job). It acts as the runtime accounts only through grants on each of them."
  type        = set(string)
  default     = ["roles/run.developer"]
}

variable "plan_roles" {
  description = "Project roles for the read-only plan account (pull requests). The deny policy stops it reading secret values, objects and logs."
  type        = set(string)
  default     = ["roles/viewer", "roles/iam.securityReviewer"]
}

variable "denied_permissions" {
  description = "What no CI account may do, whatever roles it holds: read secret values, objects (care documents, exports, the audit archive), logs or database exports, create keys, or change the federation that admits it."
  type        = list(string)
  default = [
    "secretmanager.googleapis.com/secrets.versions.access",
    "storage.googleapis.com/objects.get",
    "cloudsql.googleapis.com/instances.export",
    "logging.googleapis.com/logEntries.list",
    "logging.googleapis.com/views.access",
    "iam.googleapis.com/serviceAccountKeys.create",
    "iam.googleapis.com/workloadIdentityPools.update",
    "iam.googleapis.com/workloadIdentityPools.delete",
    "iam.googleapis.com/workloadIdentityPoolProviders.create",
    "iam.googleapis.com/workloadIdentityPoolProviders.update",
    "iam.googleapis.com/workloadIdentityPoolProviders.delete",
  ]
}
