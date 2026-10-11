# GitHub Actions OIDC federation: no long-lived AWS keys anywhere.
#
#   plan role   - assumable only by pull_request workflows in the Harbour repository.
#                 Read-only configuration access plus state read and lock; data-plane reads
#                 (S3 objects, secret values, log events, database connections) are denied.
#   deploy role - assumable only by workflows running on refs/heads/main. Can change the
#                 services this stack uses, in eu-west-2 (and us-east-1 for the CloudFront
#                 certificate and WAF), and IAM only for roles and policies named harbour-*.
#
# Note: a job that declares a GitHub environment gets the subject
# repo:<owner>/<repo>:environment:<name> instead of the ref, so these roles deliberately do
# not trust environment subjects. Tighten the deploy policy with IAM Access Analyzer policy
# generation once CloudTrail has a month of apply history.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  arn_iam    = "arn:${local.partition}:iam::${local.account_id}"

  provider_arn = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : var.existing_oidc_provider_arn

  state_bucket_arn = "arn:${local.partition}:s3:::${var.state_bucket_name}"
}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 1 : 0

  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

# ---------------------------------------------------------------------------------------------
# Trust policies
# ---------------------------------------------------------------------------------------------

data "aws_iam_policy_document" "trust_deploy" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:ref:refs/heads/${var.deploy_branch}"]
    }
  }
}

data "aws_iam_policy_document" "trust_plan" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:pull_request"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name                 = "${var.name_prefix}-github-deploy"
  description          = "Terraform apply and application deploys from ${var.github_repository} on ${var.deploy_branch}"
  assume_role_policy   = data.aws_iam_policy_document.trust_deploy.json
  max_session_duration = var.max_session_duration
}

resource "aws_iam_role" "plan" {
  name                 = "${var.name_prefix}-github-plan"
  description          = "Read-only Terraform plan for pull requests in ${var.github_repository}"
  assume_role_policy   = data.aws_iam_policy_document.trust_plan.json
  max_session_duration = var.max_session_duration
}

# ---------------------------------------------------------------------------------------------
# State access (both roles)
# ---------------------------------------------------------------------------------------------

data "aws_iam_policy_document" "state" {
  statement {
    sid       = "ListStateBucket"
    actions   = ["s3:ListBucket", "s3:GetBucketVersioning", "s3:GetBucketLocation"]
    resources = [local.state_bucket_arn]
  }

  statement {
    sid       = "ReadWriteStateAndLockFiles"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${local.state_bucket_arn}/*"]
  }

  dynamic "statement" {
    for_each = var.state_kms_key_arn == null ? [] : [var.state_kms_key_arn]

    content {
      sid       = "UseStateKey"
      actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
      resources = [statement.value]
    }
  }

  dynamic "statement" {
    for_each = var.state_lock_table_name == null ? [] : [var.state_lock_table_name]

    content {
      sid       = "UseLockTable"
      actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:DescribeTable"]
      resources = ["arn:${local.partition}:dynamodb:${var.region}:${local.account_id}:table/${statement.value}"]
    }
  }
}

resource "aws_iam_policy" "state" {
  name        = "${var.name_prefix}-terraform-state"
  description = "Read and write Terraform state and locks"
  policy      = data.aws_iam_policy_document.state.json
}

# ---------------------------------------------------------------------------------------------
# Guardrails (both roles): explicit denies that no allow can override.
# ---------------------------------------------------------------------------------------------

data "aws_iam_policy_document" "guardrails" {
  # Neither role ever needs to read personal data or credentials.
  statement {
    sid    = "DenyDataPlaneReads"
    effect = "Deny"
    actions = [
      "secretsmanager:GetSecretValue",
      "rds-db:connect",
      "rds:DownloadDBLogFilePortion",
      "rds:DownloadCompleteDBLogFile",
      "logs:GetLogEvents",
      "logs:FilterLogEvents",
      "logs:StartQuery",
      "logs:StartLiveTail",
      "logs:GetLogRecord",
      "dynamodb:Scan",
      "dynamodb:Query",
      "dynamodb:BatchGetItem",
      "ec2:GetConsoleOutput",
      "ec2:GetConsoleScreenshot",
      "sqs:ReceiveMessage",
      "athena:StartQueryExecution",
    ]
    resources = ["*"]
  }

  statement {
    sid           = "DenyObjectReadsOutsideState"
    effect        = "Deny"
    actions       = ["s3:GetObject", "s3:GetObjectVersion", "s3:GetObjectAttributes"]
    not_resources = ["${local.state_bucket_arn}/*"]
  }

  # No long-lived credentials, ever.
  statement {
    sid    = "DenyLongLivedCredentials"
    effect = "Deny"
    actions = [
      "iam:CreateUser",
      "iam:CreateAccessKey",
      "iam:CreateLoginProfile",
      "iam:UpdateLoginProfile",
      "iam:CreateServiceSpecificCredential",
      "iam:UploadSSHPublicKey",
    ]
    resources = ["*"]
  }

  # Residency: regional services may only be used in London. us-east-1 is permitted only for
  # the global services and for the ACM certificate and WAF web ACL that CloudFront requires.
  statement {
    sid    = "DenyOutsideLondon"
    effect = "Deny"
    not_actions = [
      "iam:*",
      "sts:*",
      "cloudfront:*",
      "route53:*",
      "route53domains:*",
      "budgets:*",
      "ce:*",
      "organizations:Describe*",
      "organizations:List*",
      "support:*",
      "health:*",
      "acm:*",
      "wafv2:*",
    ]
    resources = ["*"]

    condition {
      test     = "StringNotEquals"
      variable = "aws:RequestedRegion"
      values   = [var.region]
    }
  }

  statement {
    sid       = "DenyEdgeServicesOutsideLondonAndUsEast1"
    effect    = "Deny"
    actions   = ["acm:*", "wafv2:*"]
    resources = ["*"]

    condition {
      test     = "StringNotEquals"
      variable = "aws:RequestedRegion"
      values   = [var.region, "us-east-1"]
    }
  }
}

resource "aws_iam_policy" "guardrails" {
  name        = "${var.name_prefix}-ci-guardrails"
  description = "Explicit denies for CI roles: no data-plane reads, no long-lived credentials, London only"
  policy      = data.aws_iam_policy_document.guardrails.json
}

# ---------------------------------------------------------------------------------------------
# Plan role: configuration read-only.
# ---------------------------------------------------------------------------------------------

resource "aws_iam_role_policy_attachment" "plan_read_only" {
  role       = aws_iam_role.plan.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/ReadOnlyAccess"
}

resource "aws_iam_role_policy_attachment" "plan_state" {
  role       = aws_iam_role.plan.name
  policy_arn = aws_iam_policy.state.arn
}

resource "aws_iam_role_policy_attachment" "plan_guardrails" {
  role       = aws_iam_role.plan.name
  policy_arn = aws_iam_policy.guardrails.arn
}

# ---------------------------------------------------------------------------------------------
# Deploy role: change the services this stack uses, and nothing in IAM outside harbour-*.
# ---------------------------------------------------------------------------------------------

data "aws_iam_policy_document" "deploy" {
  #checkov:skip=CKV_AWS_107:Terraform apply role; the guardrails policy denies credential reads (secretsmanager:GetSecretValue) and IAM user keys.
  #checkov:skip=CKV_AWS_108:Terraform apply role; data-plane reads of S3 objects, secrets, logs and databases are denied by the guardrails policy.
  #checkov:skip=CKV_AWS_109:Terraform must manage key policies, bucket policies and IAM for the stack; IAM is limited to harbour-* and guardrails apply.
  #checkov:skip=CKV_AWS_111:Terraform must create and change the stack's resources, whose ARNs are not known in advance; region guardrails apply.
  #checkov:skip=CKV_AWS_356:Create and Describe calls for EC2, ECS, RDS, ELB, KMS and CloudFront do not support resource-level scoping.

  # Services whose create calls cannot be scoped to resource ARNs known in advance.
  statement {
    sid = "ManageStackServices"
    actions = [
      "acm:*",
      "application-autoscaling:*",
      "budgets:*",
      "cloudfront:*",
      "cloudwatch:*",
      "ec2:*",
      "ecs:*",
      "elasticloadbalancing:*",
      "events:*",
      "kms:*",
      "logs:*",
      "rds:*",
      "route53:*",
      "ses:*",
      "sns:*",
      "wafv2:*",
      "tag:GetResources",
      "tag:TagResources",
      "tag:UntagResources",
      "sts:GetCallerIdentity",
      "ecr:GetAuthorizationToken",
      "ecr:DescribeRepositories",
      "secretsmanager:ListSecrets",
      "secretsmanager:GetRandomPassword",
      "ssm:DescribeParameters",
      "s3:ListAllMyBuckets",
    ]
    resources = ["*"]
  }

  # Everything else is limited to resources named for Harbour.
  statement {
    sid     = "ManageHarbourBuckets"
    actions = ["s3:*"]
    resources = [
      "arn:${local.partition}:s3:::harbour-*",
      "arn:${local.partition}:s3:::harbour-*/*",
    ]
  }

  statement {
    sid     = "ManageHarbourRepositories"
    actions = ["ecr:*"]
    resources = [
      "arn:${local.partition}:ecr:${var.region}:${local.account_id}:repository/harbour/*",
    ]
  }

  # rds!* covers the master user secrets RDS creates on the caller's behalf.
  statement {
    sid     = "ManageHarbourSecrets"
    actions = ["secretsmanager:*"]
    resources = [
      "arn:${local.partition}:secretsmanager:${var.region}:${local.account_id}:secret:harbour-*",
      "arn:${local.partition}:secretsmanager:${var.region}:${local.account_id}:secret:rds!*",
    ]
  }

  statement {
    sid     = "ManageHarbourParameters"
    actions = ["ssm:*"]
    resources = [
      "arn:${local.partition}:ssm:${var.region}:${local.account_id}:parameter/harbour/*",
    ]
  }

  statement {
    sid     = "ManageHarbourIamOnly"
    actions = ["iam:*"]
    resources = [
      "${local.arn_iam}:role/harbour-*",
      "${local.arn_iam}:policy/harbour-*",
      "${local.arn_iam}:oidc-provider/token.actions.githubusercontent.com",
    ]
  }

  statement {
    sid = "ReadIam"
    actions = [
      "iam:Get*",
      "iam:List*",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "PassHarbourRolesToServices"
    actions   = ["iam:PassRole"]
    resources = ["${local.arn_iam}:role/harbour-*"]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com", "monitoring.rds.amazonaws.com", "vpc-flow-logs.amazonaws.com"]
    }
  }

  statement {
    sid       = "CreateServiceLinkedRoles"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "iam:AWSServiceName"
      values = [
        "ecs.amazonaws.com",
        "ecs.application-autoscaling.amazonaws.com",
        "elasticloadbalancing.amazonaws.com",
        "rds.amazonaws.com",
        "wafv2.amazonaws.com",
        "ses.amazonaws.com",
      ]
    }
  }

  # Keys that encrypt personal data are never switched off from CI; removing a key goes
  # through scheduled deletion and its 30-day waiting period instead.
  statement {
    sid    = "DenyKmsKeyDisable"
    effect = "Deny"
    actions = [
      "kms:DisableKey",
      "kms:DisableKeyRotation",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "deploy" {
  name        = "${var.name_prefix}-terraform-deploy"
  description = "Apply the Harbour stack and deploy application releases"
  policy      = data.aws_iam_policy_document.deploy.json
}

resource "aws_iam_role_policy_attachment" "deploy" {
  role       = aws_iam_role.deploy.name
  policy_arn = aws_iam_policy.deploy.arn
}

resource "aws_iam_role_policy_attachment" "deploy_state" {
  role       = aws_iam_role.deploy.name
  policy_arn = aws_iam_policy.state.arn
}

resource "aws_iam_role_policy_attachment" "deploy_guardrails" {
  role       = aws_iam_role.deploy.name
  policy_arn = aws_iam_policy.guardrails.arn
}
