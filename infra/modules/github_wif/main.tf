# Workload Identity Federation for GitHub Actions in one environment's project: no JSON keys.
# Applied by a person (infra/bootstrap), never by CI, so CI cannot change what admits it.
#
# - The provider accepts tokens only from this repository, by its numeric repository and owner
#   ids (a name can be re-registered after a rename), and only from the Terraform workflow.
# - Each account trusts one GitHub environment of this environment only: <env>-plan for the read
#   plan, <env> for the apply, <env>-release for releases. Protect those environments in GitHub
#   (required reviewers for prod; deployment branches main or signed tags), so a pull request or
#   a job in another environment cannot reach this project.
# - A deny policy stops all three accounts reading secret values, objects, logs and database
#   exports, creating keys or changing this federation, whatever roles they hold.

locals {
  pool_id = "harbour-${var.environment}-github"
  attribute_condition = join(" && ", [
    "assertion.repository_id == \"${var.github_repository_id}\"",
    "assertion.repository_owner_id == \"${var.github_repository_owner_id}\"",
    "assertion.job_workflow_ref.startsWith(\"${var.github_repository}/${var.workflow_path}@\")",
  ])

  # GitHub's token subject for a job that names a GitHub environment.
  subjects = {
    plan    = "repo:${var.github_repository}:environment:${var.environment}-plan"
    deploy  = "repo:${var.github_repository}:environment:${var.environment}"
    release = "repo:${var.github_repository}:environment:${var.environment}-release"
  }
}

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = local.pool_id
  display_name              = "GitHub Actions (${var.environment})"
  description               = "GitHub Actions for ${var.github_repository}, ${var.environment} environments only"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"                = "assertion.sub"
    "attribute.repository"          = "assertion.repository"
    "attribute.repository_id"       = "assertion.repository_id"
    "attribute.repository_owner_id" = "assertion.repository_owner_id"
    "attribute.environment"         = "assertion.environment"
    "attribute.job_workflow_ref"    = "assertion.job_workflow_ref"
  }

  # Tokens from any other repository or workflow are refused before any account is reached.
  attribute_condition = local.attribute_condition

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "ci" {
  for_each = local.subjects

  project      = var.project_id
  account_id   = substr("harbour-${var.environment}-gh-${each.key}", 0, 30)
  display_name = "GitHub Actions ${each.key} (${var.environment})"
}

resource "google_service_account_iam_member" "federated" {
  for_each = local.subjects

  service_account_id = google_service_account.ci[each.key].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principal://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/subject/${each.value}"
}

resource "google_project_iam_member" "plan" {
  for_each = var.plan_roles

  project = var.project_id
  role    = each.key
  member  = google_service_account.ci["plan"].member
}

# The apply account holds the admin role of each service the stack manages (never owner, editor,
# project IAM, organisation policy, federation or deny policies; the variable refuses them). The deny policy
# below takes data and secret reads away from it.
#trivy:ignore:AVD-GCP-0007
resource "google_project_iam_member" "deploy" {
  for_each = var.deploy_roles

  project = var.project_id
  role    = each.key
  member  = google_service_account.ci["deploy"].member
}

resource "google_project_iam_member" "release" {
  for_each = var.release_roles

  project = var.project_id
  role    = each.key
  member  = google_service_account.ci["release"].member
}

resource "google_iam_deny_policy" "ci" {
  parent       = urlencode("cloudresourcemanager.googleapis.com/projects/${var.project_id}")
  name         = "harbour-${var.environment}-ci-guard"
  display_name = "CI accounts never read data, secrets or logs"

  rules {
    description = "GitHub Actions accounts: no secret values, objects, logs or exports; no keys; no changes to their own federation."

    deny_rule {
      denied_principals  = [for k, sa in google_service_account.ci : "principal://iam.googleapis.com/projects/-/serviceAccounts/${sa.email}"]
      denied_permissions = var.denied_permissions
    }
  }
}

# State lives in the separate state project: the plan account reads it (plans run with
# -lock=false), the apply account writes it.
resource "google_storage_bucket_iam_member" "state_read" {
  bucket = var.state_bucket_name
  role   = "roles/storage.objectViewer"
  member = google_service_account.ci["plan"].member
}

resource "google_storage_bucket_iam_member" "state_write" {
  bucket = var.state_bucket_name
  role   = "roles/storage.objectUser"
  member = google_service_account.ci["deploy"].member
}
