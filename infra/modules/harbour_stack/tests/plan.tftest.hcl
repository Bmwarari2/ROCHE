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

  mock_data "aws_ec2_managed_prefix_list" {
    defaults = { entries = [{ cidr = "198.51.100.0/24", description = "documentation range" }] }
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

run "prod_needs_waf_pins" {
  command = plan

  variables {
    environment        = "prod"
    nat_gateway_per_az = true
  }

  expect_failures = [terraform_data.waf_version_pins]
}

run "prod_like" {
  command = plan

  variables {
    environment        = "prod"
    nat_gateway_per_az = true

    # Test values only: the real pins are read from the prod account (human action H-140).
    waf_managed_rule_group_versions = {
      AWSManagedRulesAmazonIpReputationList = "Version_1.0"
      AWSManagedRulesCommonRuleSet          = "Version_1.0"
      AWSManagedRulesKnownBadInputsRuleSet  = "Version_1.0"
      AWSManagedRulesSQLiRuleSet            = "Version_1.0"
    }
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

# A group AWS publishes no versions for is left out of the pin check by name, with its reason;
# the others still need pins (security review round 6; human action H-140).
run "prod_exempts_an_unversioned_group_by_name" {
  command = plan

  variables {
    environment        = "prod"
    nat_gateway_per_az = true

    waf_managed_rule_group_versions = {
      AWSManagedRulesCommonRuleSet         = "Version_1.0"
      AWSManagedRulesKnownBadInputsRuleSet = "Version_1.0"
      AWSManagedRulesSQLiRuleSet           = "Version_1.0"
    }
    waf_managed_rule_groups_unversioned = {
      AWSManagedRulesAmazonIpReputationList = "Test value: AWS lists no static versions for this group."
    }
  }

  assert {
    condition     = length(local.waf_unpinned_groups) == 0
    error_message = "the named group should be the only one left unpinned."
  }
}

run "prod_still_needs_the_other_pins" {
  command = plan

  variables {
    environment        = "prod"
    nat_gateway_per_az = true

    waf_managed_rule_groups_unversioned = {
      AWSManagedRulesAmazonIpReputationList = "Test value: AWS lists no static versions for this group."
    }
  }

  expect_failures = [terraform_data.waf_version_pins]
}

run "an_exemption_needs_a_reason" {
  command = plan

  variables {
    waf_managed_rule_groups_unversioned = {
      AWSManagedRulesAmazonIpReputationList = ""
    }
  }

  expect_failures = [var.waf_managed_rule_groups_unversioned]
}
