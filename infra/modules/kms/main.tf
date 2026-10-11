# Customer-managed KMS keys, one per purpose, so that access to each class of data can be
# granted and audited separately. Every key rotates automatically (section 5.3).

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region
  partition  = data.aws_partition.current.partition

  descriptions = {
    rds     = "RDS storage, snapshots and Performance Insights"
    s3      = "S3 objects (documents, photos, exports)"
    logs    = "CloudWatch Logs log groups"
    secrets = "Secrets Manager secrets, including RDS-managed master passwords"
    ecr     = "ECR container images"
    alerts  = "SNS alert topics"
  }
}

data "aws_iam_policy_document" "key" {
  #checkov:skip=CKV_AWS_109:Standard key policy: the account root delegates to IAM, and "*" in a key policy means this key only.
  #checkov:skip=CKV_AWS_111:Standard key policy: the account root delegates to IAM, and "*" in a key policy means this key only.
  #checkov:skip=CKV_AWS_356:In a key policy the resource "*" refers to the key the policy is attached to.
  for_each = var.purposes

  # The account root principal delegates key use to IAM policies in this account, so that
  # least-privilege grants live with the roles that use the key.
  statement {
    sid       = "EnableIamPolicies"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account_id}:root"]
    }
  }

  dynamic "statement" {
    for_each = each.key == "logs" ? [1] : []

    content {
      sid    = "AllowCloudWatchLogs"
      effect = "Allow"
      actions = [
        "kms:Encrypt*",
        "kms:Decrypt*",
        "kms:ReEncrypt*",
        "kms:GenerateDataKey*",
        "kms:Describe*",
      ]
      resources = ["*"]

      principals {
        type        = "Service"
        identifiers = ["logs.${local.region}.amazonaws.com"]
      }

      condition {
        test     = "ArnLike"
        variable = "kms:EncryptionContext:aws:logs:arn"
        values   = ["arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:*"]
      }
    }
  }

  # CloudWatch alarms publish to the encrypted alert topic; the topic policy limits who may
  # publish, so the key statement follows the AWS-documented form without conditions.
  dynamic "statement" {
    for_each = each.key == "alerts" ? [1] : []

    content {
      sid       = "AllowCloudWatchAlarms"
      effect    = "Allow"
      actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]
      resources = ["*"]

      principals {
        type        = "Service"
        identifiers = ["cloudwatch.amazonaws.com"]
      }
    }
  }

  dynamic "statement" {
    for_each = each.key == "alerts" ? [1] : []

    content {
      sid       = "AllowBudgets"
      effect    = "Allow"
      actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]
      resources = ["*"]

      principals {
        type        = "Service"
        identifiers = ["budgets.amazonaws.com"]
      }

      condition {
        test     = "StringEquals"
        variable = "aws:SourceAccount"
        values   = [local.account_id]
      }
    }
  }
}

resource "aws_kms_key" "this" {
  for_each = var.purposes

  description             = "${var.name_prefix} ${lookup(local.descriptions, each.key, each.key)}"
  key_usage               = "ENCRYPT_DECRYPT"
  enable_key_rotation     = true
  rotation_period_in_days = var.rotation_period_in_days
  deletion_window_in_days = var.deletion_window_in_days
  policy                  = data.aws_iam_policy_document.key[each.key].json

  tags = {
    Name    = "${var.name_prefix}-${each.key}"
    Purpose = each.key
  }
}

resource "aws_kms_alias" "this" {
  for_each = var.purposes

  name          = "alias/${var.name_prefix}-${each.key}"
  target_key_id = aws_kms_key.this[each.key].key_id
}
