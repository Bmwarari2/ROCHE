# Alarms for the load balancer, ECS services and RDS, all sent to one KMS-encrypted SNS
# topic. Alarm names and descriptions never include personal data.

data "aws_caller_identity" "current" {}

resource "aws_sns_topic" "alerts" {
  name              = "${var.name_prefix}-alerts"
  kms_master_key_id = var.alerts_kms_key_arn
}

data "aws_iam_policy_document" "alerts" {
  statement {
    sid       = "AllowAccountOwner"
    actions   = ["sns:Publish", "sns:Subscribe", "sns:GetTopicAttributes", "sns:SetTopicAttributes", "sns:ListSubscriptionsByTopic"]
    resources = [aws_sns_topic.alerts.arn]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  statement {
    sid       = "AllowAlarmAndBudgetPublishers"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com", "budgets.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts.json
}

resource "aws_sns_topic_subscription" "email" {
  for_each = toset(var.alert_email_addresses)

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = each.key
}

locals {
  actions = [aws_sns_topic.alerts.arn]
}

# ---------------------------------------------------------------------------------------------
# Load balancer
# ---------------------------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "elb_5xx" {
  alarm_name          = "${var.name_prefix}-alb-elb-5xx"
  alarm_description   = "The load balancer itself is returning 5xx responses (no healthy targets, timeouts)."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
  dimensions          = { LoadBalancer = var.alb_arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.elb_5xx_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "target_5xx" {
  for_each = var.target_group_arn_suffixes

  alarm_name          = "${var.name_prefix}-${each.key}-target-5xx"
  alarm_description   = "The ${each.key} service is returning 5xx responses."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = each.value }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.target_5xx_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_targets" {
  for_each = var.target_group_arn_suffixes

  alarm_name          = "${var.name_prefix}-${each.key}-unhealthy-targets"
  alarm_description   = "At least one ${each.key} task is failing load balancer health checks."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = each.value }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

# ---------------------------------------------------------------------------------------------
# ECS services (Container Insights metrics)
# ---------------------------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "ecs_running_tasks" {
  for_each = var.ecs_services

  alarm_name          = "${var.name_prefix}-${each.key}-running-tasks"
  alarm_description   = "Fewer ${each.key} tasks are running than the minimum."
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  dimensions          = { ClusterName = var.ecs_cluster_name, ServiceName = each.key }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 5
  threshold           = each.value.min_running_tasks
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "ecs_cpu" {
  for_each = var.ecs_services

  alarm_name          = "${var.name_prefix}-${each.key}-cpu-high"
  alarm_description   = "${each.key} CPU has stayed above 90 per cent despite autoscaling."
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  dimensions          = { ClusterName = var.ecs_cluster_name, ServiceName = each.key }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 90
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "ecs_memory" {
  for_each = var.ecs_services

  alarm_name          = "${var.name_prefix}-${each.key}-memory-high"
  alarm_description   = "${each.key} memory has stayed above 90 per cent despite autoscaling."
  namespace           = "AWS/ECS"
  metric_name         = "MemoryUtilization"
  dimensions          = { ClusterName = var.ecs_cluster_name, ServiceName = each.key }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 90
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

# ---------------------------------------------------------------------------------------------
# RDS
# ---------------------------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  for_each = var.rds_instances

  alarm_name          = "${var.name_prefix}-${each.key}-db-cpu"
  alarm_description   = "Database ${each.value.identifier} CPU is high."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = each.value.identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = var.rds_cpu_threshold_percent
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "rds_storage" {
  for_each = var.rds_instances

  alarm_name          = "${var.name_prefix}-${each.key}-db-free-storage"
  alarm_description   = "Database ${each.value.identifier} is running out of storage."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = { DBInstanceIdentifier = each.value.identifier }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.rds_free_storage_threshold_bytes
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

# Multi-AZ instances replicate synchronously and publish no replica lag. For the main
# database the lag that matters is the PowerSync logical replication slot; a read replica,
# if one is added, is watched with ReplicaLag.
resource "aws_cloudwatch_metric_alarm" "rds_replication_slot_lag" {
  for_each = { for k, v in var.rds_instances : k => v if v.logical_replication }

  alarm_name          = "${var.name_prefix}-${each.key}-db-replication-slot-lag"
  alarm_description   = "The PowerSync logical replication slot on ${each.value.identifier} is falling behind; mobile devices are not receiving changes."
  namespace           = "AWS/RDS"
  metric_name         = "OldestReplicationSlotLag"
  dimensions          = { DBInstanceIdentifier = each.value.identifier }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.replication_slot_lag_threshold_bytes
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "rds_replica_lag" {
  for_each = { for k, v in var.rds_instances : k => v if v.read_replica }

  alarm_name          = "${var.name_prefix}-${each.key}-db-replica-lag"
  alarm_description   = "Read replica ${each.value.identifier} is lagging behind the primary."
  namespace           = "AWS/RDS"
  metric_name         = "ReplicaLag"
  dimensions          = { DBInstanceIdentifier = each.value.identifier }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.replica_lag_threshold_seconds
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}
