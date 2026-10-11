# ---------------------------------------------------------------------------------------------
# Certificates
# ---------------------------------------------------------------------------------------------

module "cert_regional" {
  source = "../acm_certificate"

  domain_name               = var.domain_name
  subject_alternative_names = ["*.${var.domain_name}"]
  route53_zone_id           = var.route53_zone_id
}

# CloudFront reads certificates from us-east-1 only.
module "cert_cloudfront" {
  source = "../acm_certificate"

  providers = {
    aws = aws.us_east_1
  }

  domain_name     = local.hosts.web
  route53_zone_id = var.route53_zone_id
}

# ---------------------------------------------------------------------------------------------
# WAF
# ---------------------------------------------------------------------------------------------

module "waf_regional" {
  source = "../waf"

  name                        = "${local.name_prefix}-alb"
  scope                       = "REGIONAL"
  rate_limit_per_5_minutes    = var.waf_rate_limit_per_5_minutes
  managed_rule_group_versions = var.waf_managed_rule_group_versions
  enable_logging              = true
  log_kms_key_arn             = module.kms.key_arns["logs"]
  log_retention_days          = var.log_retention_days
}

# CLOUDFRONT scope must be created in us-east-1. Sampling and logging stay off so that no
# request data (client IPs, headers) is held outside London.
module "waf_cloudfront" {
  source = "../waf"

  providers = {
    aws = aws.us_east_1
  }

  name                        = "${local.name_prefix}-cloudfront"
  scope                       = "CLOUDFRONT"
  rate_limit_per_5_minutes    = var.waf_rate_limit_per_5_minutes
  managed_rule_group_versions = var.waf_managed_rule_group_versions
  sampled_requests_enabled    = false
  enable_logging              = false
}

# Prod pins every managed rule group whose rules block with the edge_blocked body (security
# review round 5, S-L5): a plan without the pins fails here.
locals {
  waf_groups_needing_pins = setunion(
    module.waf_regional.managed_rule_groups_with_blocks,
    module.waf_cloudfront.managed_rule_groups_with_blocks,
  )
  waf_unpinned_groups = sort([
    for group in local.waf_groups_needing_pins : group
    if !contains(keys(var.waf_managed_rule_group_versions), group)
  ])
}

resource "terraform_data" "waf_version_pins" {
  input = var.waf_managed_rule_group_versions

  lifecycle {
    precondition {
      condition     = var.environment != "prod" || length(local.waf_unpinned_groups) == 0
      error_message = "Pin these AWS managed rule groups in waf_managed_rule_group_versions before a prod plan: ${join(", ", local.waf_unpinned_groups)}."
    }
  }
}

# ---------------------------------------------------------------------------------------------
# Load balancer and CDN
# ---------------------------------------------------------------------------------------------

locals {
  ports = {
    api       = 4000
    web       = 3000
    powersync = 8080
    flagsmith = 8000
  }
}

module "alb" {
  source = "../alb"

  name                = local.name_prefix
  vpc_id              = module.network.vpc_id
  vpc_cidr_block      = module.network.vpc_cidr_block
  public_subnet_ids   = module.network.public_subnet_ids
  certificate_arn     = module.cert_regional.certificate_arn
  target_ports        = toset([for k, v in local.ports : v if k != "flagsmith" || var.enable_flagsmith])
  access_log_bucket   = module.bucket_logs.bucket_id
  deletion_protection = var.alb_deletion_protection
  web_acl_arn         = module.waf_regional.arn
  enable_waf          = true
}

# Shared secret CloudFront sends to the origin; the ALB rule for the web host requires it, so
# the web tier cannot be reached around CloudFront and its WAF.
resource "random_password" "origin_verify" {
  length  = 48
  special = false
}

module "cdn" {
  source = "../cloudfront"

  name                       = "${local.name_prefix}-web"
  aliases                    = [local.hosts.web]
  certificate_arn            = module.cert_cloudfront.certificate_arn
  origin_domain_name         = module.alb.dns_name
  origin_verify_header_value = random_password.origin_verify.result
  web_acl_arn                = module.waf_cloudfront.arn
}

# ---------------------------------------------------------------------------------------------
# DNS (only when the hosted zone is managed in this account)
# ---------------------------------------------------------------------------------------------

locals {
  manage_dns = var.route53_zone_id != null
  alb_hosts  = var.enable_flagsmith ? ["api", "sync", "flags"] : ["api", "sync"]
}

resource "aws_route53_record" "web" {
  for_each = local.manage_dns ? toset(["A", "AAAA"]) : toset([])

  zone_id = var.route53_zone_id
  name    = local.hosts.web
  type    = each.key

  alias {
    name                   = module.cdn.domain_name
    zone_id                = module.cdn.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "alb" {
  for_each = local.manage_dns ? toset(local.alb_hosts) : toset([])

  zone_id = var.route53_zone_id
  name    = local.hosts[each.key]
  type    = "A"

  alias {
    name                   = module.alb.dns_name
    zone_id                = module.alb.zone_id
    evaluate_target_health = true
  }
}
