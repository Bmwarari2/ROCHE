# A private S3 bucket with encryption at rest, versioning, TLS-only access, access logging
# and lifecycle rules. Every bucket in Harbour is built from this module.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_elb_service_account" "this" {}

locals {
  use_kms    = var.kms_key_arn != null
  log_prefix = coalesce(var.access_log_prefix, "s3/${var.bucket_name}/")
  arn_prefix = "arn:${data.aws_partition.current.partition}"
}

resource "aws_s3_bucket" "this" {
  #checkov:skip=CKV_AWS_144:Cross-region replication would copy personal data out of the UK; AWS has no second UK region. Resilience is versioning plus S3's multi-AZ durability (ADR-0001).
  bucket              = var.bucket_name
  force_destroy       = var.force_destroy
  object_lock_enabled = var.object_lock_enabled

  tags = merge(var.tags, { Name = var.bucket_name })
}

# ACLs are disabled: the bucket owner owns every object and access is controlled by policy only.
resource "aws_s3_bucket_ownership_controls" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket = aws_s3_bucket.this.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = local.use_kms ? "aws:kms" : "AES256"
      kms_master_key_id = local.use_kms ? var.kms_key_arn : null
    }

    # S3 Bucket Keys cut KMS request volume (and cost) by about 99 per cent.
    bucket_key_enabled = local.use_kms
  }
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id

  versioning_configuration {
    status = var.versioning_enabled || var.object_lock_enabled ? "Enabled" : "Suspended"
  }
}

resource "aws_s3_bucket_logging" "this" {
  count = var.access_logging ? 1 : 0

  bucket        = aws_s3_bucket.this.id
  target_bucket = var.access_log_bucket
  target_prefix = local.log_prefix

  target_object_key_format {
    partitioned_prefix {
      partition_date_source = "EventTime"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    id     = "housekeeping"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_expiration_days
    }

    expiration {
      expired_object_delete_marker = true
    }
  }

  dynamic "rule" {
    for_each = var.current_version_expiration_days == null ? [] : [var.current_version_expiration_days]

    content {
      id     = "expire-current-versions"
      status = "Enabled"

      filter {
        prefix = var.current_version_expiration_prefix
      }

      abort_incomplete_multipart_upload {
        days_after_initiation = 7
      }

      expiration {
        days = rule.value
      }
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}

resource "aws_s3_bucket_object_lock_configuration" "this" {
  count = var.object_lock_enabled ? 1 : 0

  bucket = aws_s3_bucket.this.id

  rule {
    default_retention {
      mode = var.object_lock_mode
      days = var.object_lock_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}

# Object events go to EventBridge (same account and region), where the antivirus scan on ingest
# and other consumers subscribe without changing the bucket.
resource "aws_s3_bucket_notification" "this" {
  count = var.eventbridge_notifications ? 1 : 0

  bucket      = aws_s3_bucket.this.id
  eventbridge = true
}

resource "aws_s3_bucket_cors_configuration" "this" {
  count = length(var.cors_allowed_origins) == 0 ? 0 : 1

  bucket = aws_s3_bucket.this.id

  cors_rule {
    allowed_methods = ["GET", "PUT", "HEAD"]
    allowed_origins = var.cors_allowed_origins
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

data "aws_iam_policy_document" "this" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.this.arn, "${aws_s3_bucket.this.arn}/*"]

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

  statement {
    sid       = "DenyTlsOlderThan12"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.this.arn, "${aws_s3_bucket.this.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "NumericLessThan"
      variable = "s3:TlsVersion"
      values   = ["1.2"]
    }
  }

  dynamic "statement" {
    for_each = var.allow_alb_access_logs ? [1] : []

    content {
      sid       = "AllowAlbAccessLogDelivery"
      effect    = "Allow"
      actions   = ["s3:PutObject"]
      resources = ["${aws_s3_bucket.this.arn}/alb/AWSLogs/${data.aws_caller_identity.current.account_id}/*"]

      # London predates August 2022, so ALB log delivery uses the regional ELB account.
      principals {
        type        = "AWS"
        identifiers = [data.aws_elb_service_account.this.arn]
      }
    }
  }

  dynamic "statement" {
    for_each = var.allow_s3_access_logs_from_account ? [1] : []

    content {
      sid       = "AllowS3ServerAccessLogDelivery"
      effect    = "Allow"
      actions   = ["s3:PutObject"]
      resources = ["${aws_s3_bucket.this.arn}/s3/*"]

      principals {
        type        = "Service"
        identifiers = ["logging.s3.amazonaws.com"]
      }

      condition {
        test     = "StringEquals"
        variable = "aws:SourceAccount"
        values   = [data.aws_caller_identity.current.account_id]
      }

      condition {
        test     = "ArnLike"
        variable = "aws:SourceArn"
        values   = ["${local.arn_prefix}:s3:::*"]
      }
    }
  }
}

resource "aws_s3_bucket_policy" "this" {
  bucket = aws_s3_bucket.this.id
  policy = data.aws_iam_policy_document.this.json

  depends_on = [aws_s3_bucket_public_access_block.this]
}
