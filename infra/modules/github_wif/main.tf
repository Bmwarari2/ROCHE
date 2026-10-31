# Workload Identity Federation for GitHub Actions: no JSON keys. Only this repository's tokens are
# accepted (the provider's condition), and two accounts are impersonated by subject: pull requests
# get the read-only plan account, pushes to main get the deploy account.

locals {
  owner               = split("/", var.github_repository)[0]
  attribute_condition = "assertion.repository == \"${var.github_repository}\" && assertion.repository_owner == \"${local.owner}\""
}

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "${var.name_prefix}-github"
  display_name              = "GitHub Actions"
  description               = "GitHub Actions for ${var.github_repository}"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"             = "assertion.sub"
    "attribute.repository"       = "assertion.repository"
    "attribute.repository_owner" = "assertion.repository_owner"
    "attribute.ref"              = "assertion.ref"
    "attribute.event_name"       = "assertion.event_name"
  }

  # Tokens from any other repository are refused before any account can be impersonated.
  attribute_condition = local.attribute_condition

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "plan" {
  project      = var.project_id
  account_id   = substr("${var.name_prefix}-gh-plan", 0, 30)
  display_name = "GitHub Actions plan (read only)"
}

resource "google_service_account" "deploy" {
  project      = var.project_id
  account_id   = substr("${var.name_prefix}-gh-deploy", 0, 30)
  display_name = "GitHub Actions apply and deploy"
}

locals {
  pool = google_iam_workload_identity_pool.github.name
  # GitHub's token subject for each kind of run this project trusts.
  subjects = {
    plan   = "repo:${var.github_repository}:pull_request"
    deploy = "repo:${var.github_repository}:ref:refs/heads/main"
  }
  plan_sub  = "principal://iam.googleapis.com/${local.pool}/subject/${local.subjects.plan}"
  apply_sub = "principal://iam.googleapis.com/${local.pool}/subject/${local.subjects.deploy}"
}

resource "google_service_account_iam_member" "plan" {
  service_account_id = google_service_account.plan.name
  role               = "roles/iam.workloadIdentityUser"
  member             = local.plan_sub
}

resource "google_service_account_iam_member" "deploy" {
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = local.apply_sub
}

resource "google_project_iam_member" "plan" {
  for_each = var.plan_roles

  project = var.project_id
  role    = each.key
  member  = "serviceAccount:${google_service_account.plan.email}"
}

# The deploy account applies this stack, so it holds the admin role of each service the stack
# manages (never owner or editor; the variable refuses them). It is reachable only from pushes to
# main of this repository, through the provider's condition and its subject binding above.
#trivy:ignore:AVD-GCP-0007
resource "google_project_iam_member" "deploy" {
  for_each = var.deploy_roles

  project = var.project_id
  role    = each.key
  member  = "serviceAccount:${google_service_account.deploy.email}"
}

# State: the plan account reads it (plans run with -lock=false), the deploy account writes it.
resource "google_storage_bucket_iam_member" "state_read" {
  bucket = var.state_bucket_name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.plan.email}"
}

resource "google_storage_bucket_iam_member" "state_write" {
  bucket = var.state_bucket_name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.deploy.email}"
}
