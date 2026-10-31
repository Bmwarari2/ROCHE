# The federation and guardrails CI must never change, planned against a mocked provider.

mock_provider "google" {}

variables {
  environment                = "dev"
  project_id                 = "harbour-dev-test"
  github_repository_id       = "123456789"
  github_repository_owner_id = "987654321"
  state_bucket_name          = "harbour-tfstate-test"
}

run "dev_trusts_its_own_environments_only" {
  command = plan

  assert {
    condition = (
      module.github_wif.subjects.plan == "repo:Bmwarari2/ROCHE:environment:dev-plan" &&
      module.github_wif.subjects.deploy == "repo:Bmwarari2/ROCHE:environment:dev" &&
      module.github_wif.subjects.release == "repo:Bmwarari2/ROCHE:environment:dev-release"
    )
    error_message = "Each dev account must trust one dev GitHub environment only."
  }

  assert {
    condition = alltrue([
      strcontains(module.github_wif.attribute_condition, "assertion.repository_id == \"123456789\""),
      strcontains(module.github_wif.attribute_condition, "assertion.repository_owner_id == \"987654321\""),
      strcontains(module.github_wif.attribute_condition, "Bmwarari2/ROCHE/.github/workflows/terraform.yml@"),
    ])
    error_message = "The provider must admit this repository's Terraform workflow only, by numeric ids."
  }

  assert {
    condition = alltrue([
      for p in [
        "secretmanager.googleapis.com/secrets.versions.access",
        "storage.googleapis.com/objects.get",
        "logging.googleapis.com/logEntries.list",
        "iam.googleapis.com/serviceAccountKeys.create",
        "iam.googleapis.com/workloadIdentityPoolProviders.update",
      ] : contains(module.github_wif.denied_permissions, p)
    ])
    error_message = "The deny policy must keep CI away from secrets, objects and logs, keys and its own federation."
  }

  assert {
    condition     = length(google_org_policy_policy.resource_locations) == 1 && length(google_org_policy_policy.no_service_account_keys) == 1
    error_message = "Both organisation policies must be set by default."
  }

  assert {
    condition     = jsonencode(sort([for c in google_project_iam_audit_config.all_services.audit_log_config : c.log_type])) == jsonencode(["ADMIN_READ", "DATA_READ", "DATA_WRITE"])
    error_message = "Data Access audit logs must be on for every service."
  }

  assert {
    condition     = jsonencode(google_org_policy_policy.resource_locations[0].spec[0].rules[0].values[0].allowed_values) == jsonencode(["in:europe-west2-locations"])
    error_message = "The gcp.resourceLocations policy must allow europe-west2 locations only."
  }
}

run "prod_subjects_differ_from_dev" {
  command = plan

  variables {
    environment = "prod"
    project_id  = "harbour-prod-test"
  }

  assert {
    condition = (
      module.github_wif.subjects.deploy == "repo:Bmwarari2/ROCHE:environment:prod" &&
      module.github_wif.subjects.plan == "repo:Bmwarari2/ROCHE:environment:prod-plan"
    )
    error_message = "Prod must trust only the prod GitHub environments."
  }
}
