variable "project_id" {
  type = string
}

variable "name_prefix" {
  type = string
}

variable "github_repository" {
  description = "owner/name of the only repository that may sign in."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$", var.github_repository))
    error_message = "github_repository must be owner/name."
  }
}

variable "state_bucket_name" {
  description = "The Terraform state bucket (created by the bootstrap step)."
  type        = string
}

variable "deploy_roles" {
  description = "Project roles for the apply and deploy account. Least privilege: no basic roles (owner, editor)."
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
    "roles/iam.workloadIdentityPoolAdmin",
    "roles/logging.configWriter",
    "roles/monitoring.alertPolicyEditor",
    "roles/monitoring.notificationChannelEditor",
    "roles/orgpolicy.policyAdmin",
    "roles/resourcemanager.projectIamAdmin",
    "roles/run.admin",
    "roles/secretmanager.admin",
    "roles/serviceusage.serviceUsageAdmin",
    "roles/servicenetworking.networksAdmin",
    "roles/storage.admin",
  ]

  validation {
    condition     = length(setintersection(var.deploy_roles, ["roles/owner", "roles/editor"])) == 0
    error_message = "The deploy account never gets a basic role."
  }
}

variable "plan_roles" {
  description = "Project roles for the read-only plan account (pull requests). It cannot read secret values or data."
  type        = set(string)
  default = [
    "roles/viewer",
    "roles/iam.securityReviewer",
  ]
}
