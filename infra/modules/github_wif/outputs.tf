output "workload_identity_provider" {
  description = "For google-github-actions/auth: workload_identity_provider."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "plan_service_account" {
  value = google_service_account.plan.email
}

output "deploy_service_account" {
  value = google_service_account.deploy.email
}

output "attribute_condition" {
  value = local.attribute_condition
}

output "subjects" {
  description = "The GitHub token subject each account trusts."
  value       = local.subjects
}
