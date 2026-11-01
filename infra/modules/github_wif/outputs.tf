output "workload_identity_provider" {
  description = "For google-github-actions/auth: workload_identity_provider."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "service_accounts" {
  description = "Account emails, by purpose (plan, deploy, release)."
  value       = { for k, sa in google_service_account.ci : k => sa.email }
}

output "attribute_condition" {
  value = local.attribute_condition
}

output "subjects" {
  description = "The GitHub token subject each account trusts."
  value       = local.subjects
}

output "denied_permissions" {
  value = var.denied_permissions
}
