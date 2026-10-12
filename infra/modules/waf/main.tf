# AWS WAF web ACL with AWS managed rule groups (common, known bad inputs, SQL injection,
# IP reputation) and a per-IP rate limit. Blocks answer in the API's problem shape: 403 with
# code edge_blocked from the managed rules, 429 with code rate_limited from the rate limit.
#
# Residency: a CLOUDFRONT-scope web ACL must live in us-east-1. It is configuration only and
# stores no personal data: sampling and logging are switched off for that scope, so only
# aggregate CloudWatch metrics (request counts per rule) are kept in us-east-1. The
# REGIONAL web ACL in eu-west-2 is the one that logs blocked requests.

locals {
  metric_prefix = replace(var.name, "-", "")

  # Priorities and metric names are unchanged from the static rules they replace.
  managed_rule_groups = [
    {
      name     = "AWSManagedRulesAmazonIpReputationList"
      priority = 10
      metric   = "IpReputation"
      count    = []
    },
    {
      name     = "AWSManagedRulesCommonRuleSet"
      priority = 20
      metric   = "Common"
      count    = var.common_rule_count_overrides
    },
    # Includes the Log4JRCE rules.
    {
      name     = "AWSManagedRulesKnownBadInputsRuleSet"
      priority = 30
      metric   = "KnownBadInputs"
      count    = []
    },
    {
      name     = "AWSManagedRulesSQLiRuleSet"
      priority = 40
      metric   = "SQLi"
      count    = []
    },
  ]

  # A rule that only counts is never also given the block override.
  managed_rule_groups_with_blocks = [
    for group in local.managed_rule_groups : merge(group, {
      block = [
        for name in lookup(var.managed_rule_blocks, group.name, []) : name
        if !contains(group.count, name)
      ]
    })
  ]
}

resource "aws_wafv2_web_acl" "this" {
  name        = var.name
  description = "Harbour ${lower(var.scope)} protection"
  scope       = var.scope

  default_action {
    allow {}
  }

  # Blocks answer in the API's problem shape (RFC 9457 fields, sent as application/json,
  # the only JSON type WAF offers), so a device never mistakes the edge for the API ending its
  # session (security review round 3, H1): the device ends a session only on a 401 or on a 403
  # whose code is one of the API's session codes, and edge_blocked is not one of them.
  custom_response_body {
    key          = "edge_blocked"
    content_type = "APPLICATION_JSON"
    content = jsonencode({
      type   = "about:blank"
      title  = "Request blocked"
      status = 403
      code   = "edge_blocked"
      detail = "The request was blocked before it reached Harbour. Your session is unchanged."
    })
  }

  custom_response_body {
    key          = "rate_limited"
    content_type = "APPLICATION_JSON"
    content = jsonencode({
      type   = "about:blank"
      title  = "Too many requests"
      status = 429
      code   = "rate_limited"
      detail = "Too many requests from this address. Try again in a few minutes."
    })
  }

  # A rate limit is a 429 with Retry-After, which the device treats as "try again later",
  # never as a refusal.
  rule {
    name     = "rate-limit-per-ip"
    priority = 1

    action {
      block {
        custom_response {
          response_code            = 429
          custom_response_body_key = "rate_limited"

          response_header {
            name  = "retry-after"
            value = tostring(var.rate_limit_retry_after_seconds)
          }
        }
      }
    }

    statement {
      rate_based_statement {
        limit                 = var.rate_limit_per_5_minutes
        aggregate_key_type    = "IP"
        evaluation_window_sec = 300
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.metric_prefix}RateLimit"
      sampled_requests_enabled   = var.sampled_requests_enabled
    }
  }

  # AWS managed rule groups. Each rule listed in var.managed_rule_blocks blocks with the
  # edge_blocked body; a rule AWS adds later keeps its own action (a block without the body)
  # until it is listed, so nothing new is let through. Rules in var.common_rule_count_overrides,
  # and rules whose own action is count (AWSManagedIPDDoSList), only count.
  dynamic "rule" {
    for_each = local.managed_rule_groups_with_blocks

    content {
      name     = rule.value.name
      priority = rule.value.priority

      override_action {
        none {}
      }

      statement {
        managed_rule_group_statement {
          name        = rule.value.name
          vendor_name = "AWS"
          # A pinned static version changes only when this module does, so a new AWS rule cannot
          # start blocking (or lose the edge_blocked body) unannounced. Unpinned groups follow the
          # version AWS sets as default.
          version = lookup(var.managed_rule_group_versions, rule.value.name, null)

          dynamic "rule_action_override" {
            for_each = rule.value.count

            content {
              name = rule_action_override.value

              action_to_use {
                count {}
              }
            }
          }

          dynamic "rule_action_override" {
            for_each = rule.value.block

            content {
              name = rule_action_override.value

              action_to_use {
                block {
                  custom_response {
                    response_code            = 403
                    custom_response_body_key = "edge_blocked"
                  }
                }
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${local.metric_prefix}${rule.value.metric}"
        sampled_requests_enabled   = var.sampled_requests_enabled
      }
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = local.metric_prefix
    sampled_requests_enabled   = var.sampled_requests_enabled
  }
}

# WAF requires the log group name to start with aws-waf-logs-.
resource "aws_cloudwatch_log_group" "this" {
  count = var.enable_logging ? 1 : 0

  name              = "aws-waf-logs-${var.name}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.log_kms_key_arn
}

resource "aws_wafv2_web_acl_logging_configuration" "this" {
  count = var.enable_logging ? 1 : 0

  resource_arn            = aws_wafv2_web_acl.this.arn
  log_destination_configs = [aws_cloudwatch_log_group.this[0].arn]

  # Credentials and session cookies never reach the log; query strings may carry search terms.
  redacted_fields {
    single_header {
      name = "authorization"
    }
  }

  redacted_fields {
    single_header {
      name = "cookie"
    }
  }

  redacted_fields {
    query_string {}
  }

  # Keep only requests that were blocked or counted; allowed traffic is not logged here.
  logging_filter {
    default_behavior = "DROP"

    filter {
      behavior    = "KEEP"
      requirement = "MEETS_ANY"

      condition {
        action_condition {
          action = "BLOCK"
        }
      }

      condition {
        action_condition {
          action = "COUNT"
        }
      }
    }
  }
}
