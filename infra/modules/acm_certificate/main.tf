# ACM certificate with DNS validation. The provider passed in decides the region:
# eu-west-2 for the ALB, us-east-1 for CloudFront.

locals {
  manage_dns = var.route53_zone_id != null
  names      = distinct(concat([var.domain_name], var.subject_alternative_names))
}

resource "aws_acm_certificate" "this" {
  domain_name               = var.domain_name
  subject_alternative_names = var.subject_alternative_names
  validation_method         = "DNS"
  key_algorithm             = "RSA_2048"

  options {
    certificate_transparency_logging_preference = "ENABLED"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# Keyed by the names in configuration (known at plan time); the record values are filled in
# from the certificate once AWS has issued the validation tokens. A wildcard and its apex
# share one record, hence allow_overwrite.
resource "aws_route53_record" "validation" {
  for_each = local.manage_dns ? toset(local.names) : toset([])

  zone_id         = var.route53_zone_id
  name            = one([for d in aws_acm_certificate.this.domain_validation_options : d.resource_record_name if d.domain_name == each.key])
  type            = one([for d in aws_acm_certificate.this.domain_validation_options : d.resource_record_type if d.domain_name == each.key])
  records         = [one([for d in aws_acm_certificate.this.domain_validation_options : d.resource_record_value if d.domain_name == each.key])]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "this" {
  count = local.manage_dns ? 1 : 0

  certificate_arn         = aws_acm_certificate.this.arn
  validation_record_fqdns = [for r in aws_route53_record.validation : r.fqdn]
}
