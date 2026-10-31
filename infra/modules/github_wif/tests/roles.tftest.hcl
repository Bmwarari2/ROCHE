# The apply account can never be given a role that would let it undo its own guardrails.

mock_provider "google" {}

variables {
  project_id                 = "harbour-dev-test"
  environment                = "dev"
  github_repository          = "Bmwarari2/ROCHE"
  github_repository_id       = "123456789"
  github_repository_owner_id = "987654321"
  state_bucket_name          = "harbour-tfstate-test"
}

run "defaults_are_accepted" {
  command = plan
}

run "owner_is_refused" {
  command = plan

  variables {
    deploy_roles = ["roles/run.admin", "roles/owner"]
  }

  expect_failures = [var.deploy_roles]
}

run "workload_identity_admin_is_refused" {
  command = plan

  variables {
    deploy_roles = ["roles/iam.workloadIdentityPoolAdmin"]
  }

  expect_failures = [var.deploy_roles]
}

run "a_name_is_not_an_id" {
  command = plan

  variables {
    github_repository_id = "Bmwarari2/ROCHE"
  }

  expect_failures = [var.github_repository_id]
}
