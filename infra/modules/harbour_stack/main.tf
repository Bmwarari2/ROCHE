# The Harbour platform for one environment (one AWS account), composed from the modules in
# infra/modules. dev, staging and prod all call this module and differ only in sizing and
# protection settings, so that staging is a faithful rehearsal of prod.
#
# Residency: every resource that stores or processes personal data is created in eu-west-2.
# Only the CloudFront certificate and the CloudFront-scope WAF web ACL are created in
# us-east-1 (an AWS requirement); neither stores personal data.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  name_prefix = "harbour-${var.environment}"
  account_id  = data.aws_caller_identity.current.account_id
  region      = data.aws_region.current.region

  hosts = {
    web   = "app.${var.domain_name}"
    api   = "api.${var.domain_name}"
    sync  = "sync.${var.domain_name}"
    flags = "flags.${var.domain_name}"
    # The e-learning content origin (ADR-0093): another site, served by the web tier.
    learn = "learn.${var.domain_name}"
  }

  default_sizes = {
    api       = { cpu = 512, memory = 1024, min = 1, max = 4 }
    worker    = { cpu = 512, memory = 1024, min = 1, max = 2 }
    web       = { cpu = 512, memory = 1024, min = 1, max = 4 }
    powersync = { cpu = 1024, memory = 2048, min = 1, max = 1 }
    migrate   = { cpu = 512, memory = 1024, min = 0, max = 0 }
    flagsmith = { cpu = 512, memory = 1024, min = 1, max = 1 }
  }
  sizes = merge(local.default_sizes, var.service_sizes)
}

check "region_is_london" {
  assert {
    condition     = local.region == "eu-west-2"
    error_message = "The Harbour stack must be deployed to eu-west-2 (London); personal data may not leave the UK."
  }
}

# ---------------------------------------------------------------------------------------------
# Keys and network
# ---------------------------------------------------------------------------------------------

module "kms" {
  source = "../kms"

  name_prefix = local.name_prefix
}

module "network" {
  source = "../network"

  name_prefix                   = local.name_prefix
  cidr_block                    = var.vpc_cidr_block
  nat_gateway_per_az            = var.nat_gateway_per_az
  interface_endpoint_az_count   = var.interface_endpoint_az_count
  flow_log_kms_key_arn          = module.kms.key_arns["logs"]
  flow_log_retention_days       = var.log_retention_days
  log_group_deletion_protection = var.protect_log_groups
}

# ---------------------------------------------------------------------------------------------
# Buckets
# ---------------------------------------------------------------------------------------------

# Access logs for the other buckets and the ALB. S3 server access logs and ALB access logs can
# only be delivered to SSE-S3 (AES-256) buckets, so this one bucket does not use the CMK.
#trivy:ignore:AVD-AWS-0132
#trivy:ignore:AVD-AWS-0089
module "bucket_logs" {
  source = "../s3_bucket"

  bucket_name                        = "${local.name_prefix}-logs-${local.account_id}"
  kms_key_arn                        = null
  access_logging                     = false
  allow_alb_access_logs              = true
  allow_s3_access_logs_from_account  = true
  current_version_expiration_days    = 400
  noncurrent_version_expiration_days = 30
  force_destroy                      = var.force_destroy_buckets
}

# Care documents, photos and attachments (presigned uploads from web and mobile).
module "bucket_documents" {
  source = "../s3_bucket"

  bucket_name          = "${local.name_prefix}-documents-${local.account_id}"
  kms_key_arn          = module.kms.key_arns["s3"]
  access_log_bucket    = module.bucket_logs.bucket_id
  cors_allowed_origins = ["https://${local.hosts.web}"]
  force_destroy        = var.force_destroy_buckets
}

# Generated exports (DSAR bundles, tenant data exports, inspector PDFs); short-lived.
module "bucket_exports" {
  source = "../s3_bucket"

  bucket_name                        = "${local.name_prefix}-exports-${local.account_id}"
  kms_key_arn                        = module.kms.key_arns["s3"]
  access_log_bucket                  = module.bucket_logs.bucket_id
  current_version_expiration_days    = 30
  noncurrent_version_expiration_days = 7
  force_destroy                      = var.force_destroy_buckets
}

# Write-once archive of audit_event batches and destruction certificates (section 5.5).
module "bucket_audit_archive" {
  source = "../s3_bucket"

  bucket_name                        = "${local.name_prefix}-audit-archive-${local.account_id}"
  kms_key_arn                        = module.kms.key_arns["s3"]
  access_log_bucket                  = module.bucket_logs.bucket_id
  object_lock_enabled                = true
  object_lock_mode                   = var.audit_archive_lock_mode
  object_lock_days                   = var.audit_archive_lock_days
  noncurrent_version_expiration_days = max(var.audit_archive_lock_days, 90)
  force_destroy                      = var.force_destroy_buckets
}

# ---------------------------------------------------------------------------------------------
# Container images and release pointers
# ---------------------------------------------------------------------------------------------

module "ecr" {
  source = "../ecr"

  name_prefix = "harbour"
  # The worker and the migration task run the api image with a different command.
  repositories = ["api", "web", "powersync-service", "flagsmith"]
  kms_key_arn  = module.kms.key_arns["ecr"]
}

locals {
  release_services = toset(["api", "web"])
}

# The deploy workflow writes the tag it has just pushed here and then runs terraform apply.
# Terraform reads the pointer but never resets it, so an infrastructure-only change cannot
# roll an application back. var.image_tags overrides a pointer for a single apply.
resource "aws_ssm_parameter" "release" {
  #checkov:skip=CKV2_AWS_34:Holds a public image tag, not a secret; String keeps it readable by the plan role, which has no kms:Decrypt.
  for_each = local.release_services

  name           = "/harbour/${var.environment}/release/${each.key}"
  description    = "Image tag of ${each.key} currently released to ${var.environment}"
  type           = "String"
  insecure_value = var.initial_image_tag

  lifecycle {
    ignore_changes = [insecure_value]
  }
}

locals {
  image_tags = {
    for s in local.release_services : s => lookup(var.image_tags, s, aws_ssm_parameter.release[s].insecure_value)
  }

  images = {
    api       = "${module.ecr.repository_urls["api"]}:${local.image_tags["api"]}"
    web       = "${module.ecr.repository_urls["web"]}:${local.image_tags["web"]}"
    powersync = coalesce(var.powersync_image, "${module.ecr.repository_urls["powersync-service"]}:${var.powersync_version}")
    flagsmith = "${module.ecr.repository_urls["flagsmith"]}:${var.flagsmith_version}"
  }
}
