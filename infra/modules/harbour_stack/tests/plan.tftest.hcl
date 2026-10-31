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
  safety_case_version  = "v0.0"
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

  # The worker logs JSON (pino), so its alarms match the structured `event` field
  # (ADR-0071 review round 5, C5-M1; docs/runbooks/on-call.md).
  assert {
    condition     = module.observability.log_metric_filter_patterns.escalation_unrouted_daily == "{ $.event = \"escalation.unrouted.daily\" }"
    error_message = "The unrouted escalation alarm must match the worker's escalation.unrouted.daily event."
  }

  assert {
    condition     = module.observability.log_metric_filter_patterns.worker_job_failed == "{ $.event = \"worker.job.failed\" }"
    error_message = "The failed job alarm must match the worker's worker.job.failed event."
  }

  assert {
    condition     = module.observability.log_metric_filter_patterns.export_foreign_rows == "{ $.event = \"security.export.foreign_rows\" }"
    error_message = "The export foreign rows alarm must match the worker's security.export.foreign_rows event (HZ-070)."
  }

  # Each filter reads the worker's own log group, and each alarm reads the metric its filter
  # writes.
  assert {
    condition = alltrue([
      for rule in values(module.observability.log_alarm_rules) :
      rule.log_group_name == module.svc_worker.log_group_name && rule.alarm_metric == rule.filter_metric
    ])
    error_message = "Each worker log alarm must read the worker's log group through its own metric filter."
  }

  # Any unrouted line alarms, over an hour so each daily run notifies again; one or more failed
  # jobs in 15 minutes alarm by default.
  assert {
    condition = (
      module.observability.log_alarm_rules.escalation_unrouted_daily.statistic == "Sum" &&
      module.observability.log_alarm_rules.escalation_unrouted_daily.period == 3600 &&
      module.observability.log_alarm_rules.escalation_unrouted_daily.threshold == 1 &&
      module.observability.log_alarm_rules.escalation_unrouted_daily.comparison_operator == "GreaterThanOrEqualToThreshold" &&
      module.observability.log_alarm_rules.escalation_unrouted_daily.treat_missing_data == "notBreaching"
    )
    error_message = "The unrouted escalation alarm must fire on any escalation.unrouted.daily line, over an hour so each daily run notifies again (HZ-073)."
  }

  assert {
    condition = (
      module.observability.log_alarm_rules.worker_job_failed.statistic == "Sum" &&
      module.observability.log_alarm_rules.worker_job_failed.period == 900 &&
      module.observability.log_alarm_rules.worker_job_failed.threshold == 1 &&
      module.observability.log_alarm_rules.worker_job_failed.comparison_operator == "GreaterThanOrEqualToThreshold"
    )
    error_message = "The failed job alarm must fire on one or more worker.job.failed lines in 15 minutes."
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
