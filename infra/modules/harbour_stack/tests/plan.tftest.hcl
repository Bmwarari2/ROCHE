# Plans the whole stack against mocked providers, so CI can catch count and for_each values
# that are unknown until apply, broken cross-module references and wrong conditional wiring
# without any AWS credentials. Run from this directory:
#   terraform init -backend=false && terraform test

mock_provider "aws" {
  mock_data "aws_region" {
    defaults = { region = "eu-west-2" }
  }

  mock_data "aws_caller_identity" {
    defaults = { account_id = "000000000000" }
  }

  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }

  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
}

mock_provider "aws" {
  alias = "us_east_1"

  mock_data "aws_region" {
    defaults = { region = "us-east-1" }
  }

  mock_data "aws_caller_identity" {
    defaults = { account_id = "000000000000" }
  }
}

mock_provider "random" {}

variables {
  environment          = "dev"
  domain_name          = "dev.harbour.example.invalid"
  state_bucket_name    = "harbour-tfstate-000000000000"
  budget_monthly_limit = 600
}

run "dev_defaults" {
  command = plan

  assert {
    condition     = length(module.network.nat_public_ips) == 1
    error_message = "dev should share a single NAT gateway."
  }

  assert {
    condition     = length(module.svc_flagsmith) == 0
    error_message = "Flagsmith must be off by default."
  }

  assert {
    condition     = output.manual_dns_records != null
    error_message = "Without a hosted zone the stack must list the DNS records to create by hand."
  }
}

run "flagsmith_and_route53" {
  command = plan

  variables {
    enable_flagsmith = true
    route53_zone_id  = "Z0000000000000EXAMPLE"
  }

  assert {
    condition     = length(module.svc_flagsmith) == 1
    error_message = "Flagsmith should be created when enabled."
  }

  assert {
    condition     = length(aws_route53_record.alb) == 3
    error_message = "api, sync and flags should get alias records."
  }
}

run "prod_like" {
  command = plan

  variables {
    environment        = "prod"
    nat_gateway_per_az = true
  }

  assert {
    condition     = length(module.network.nat_public_ips) == 3
    error_message = "prod should have one NAT gateway per availability zone."
  }

  assert {
    condition     = aws_secretsmanager_secret.this["db/harbour_app"].recovery_window_in_days == 30
    error_message = "prod secrets should have a 30-day recovery window."
  }
}
