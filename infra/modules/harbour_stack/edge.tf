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

  domain_name               = local.hosts.web
  subject_alternative_names = [local.hosts.learn]
  route53_zone_id           = var.route53_zone_id
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
# review round 5, S-L5): a plan without the pins fails here. A group AWS publishes no static
# versions for is exempted only by name, with its reason (security review round 6; H-140).
locals {
  waf_groups_needing_pins = setunion(
    module.waf_regional.managed_rule_groups_with_blocks,
    module.waf_cloudfront.managed_rule_groups_with_blocks,
  )
  waf_unpinned_groups = sort([
    for group in local.waf_groups_needing_pins : group
    if !contains(keys(var.waf_managed_rule_group_versions), group)
    && !contains(keys(var.waf_managed_rule_groups_unversioned), group)
  ])
}

resource "terraform_data" "waf_version_pins" {
  input = {
    versions    = var.waf_managed_rule_group_versions
    unversioned = var.waf_managed_rule_groups_unversioned
  }

  lifecycle {
    precondition {
      condition     = var.environment != "prod" || length(local.waf_unpinned_groups) == 0
      error_message = "Pin these AWS managed rule groups in waf_managed_rule_group_versions before a prod plan (or, only for a group with no versions, name it with a reason in waf_managed_rule_groups_unversioned): ${join(", ", local.waf_unpinned_groups)}."
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

# The e-learning content origin (ADR-0093): its own distribution, so the app's runtime page can be
# framed (no X-Frame-Options; the page's frame-ancestors names the app) and nothing is referred.
# The web tier answers only `/learn` on this host; caching stays off as for the app.
module "cdn_learn" {
  source = "../cloudfront"

  name                       = "${local.name_prefix}-learn"
  aliases                    = [local.hosts.learn]
  certificate_arn            = module.cert_cloudfront.certificate_arn
  origin_domain_name         = module.alb.dns_name
  origin_verify_header_value = random_password.origin_verify.result
  web_acl_arn                = module.waf_cloudfront.arn
  frame_options_deny         = false
  referrer_policy            = "no-referrer"
  permissions_policy         = "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
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

resource "aws_route53_record" "learn" {
  for_each = local.manage_dns ? toset(["A", "AAAA"]) : toset([])

  zone_id = var.route53_zone_id
  name    = local.hosts.learn
  type    = each.key

  alias {
    name                   = module.cdn_learn.domain_name
    zone_id                = module.cdn_learn.hosted_zone_id
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
