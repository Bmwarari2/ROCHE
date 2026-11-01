output "workload_identity_provider" {
  description = "Repository variable GCP_WORKLOAD_IDENTITY_PROVIDER_<ENV>."
  value       = module.github_wif.workload_identity_provider
}

output "service_accounts" {
  description = "Repository variables GCP_PLAN_SERVICE_ACCOUNT_<ENV>, GCP_DEPLOY_SERVICE_ACCOUNT_<ENV> and GCP_RELEASE_SERVICE_ACCOUNT_<ENV>."
  value       = module.github_wif.service_accounts
}

output "subjects" {
  description = "The GitHub environments to create and protect, by account."
  value       = module.github_wif.subjects
}
