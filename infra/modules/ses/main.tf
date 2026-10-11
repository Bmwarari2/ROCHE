# Amazon SES in eu-west-2: a verified domain identity with Easy DKIM (2048-bit), a custom
# MAIL FROM domain, a configuration set that requires TLS to the receiving server and
# suppresses bounces and complaints, and delivery metrics in CloudWatch (counts only, no
# recipient addresses). Leaving the SES sandbox is a human action (see infra/README.md).

data "aws_region" "current" {}

locals {
  manage_dns       = var.route53_zone_id != null
  mail_from_domain = "${var.mail_from_subdomain}.${var.domain}"
}

resource "aws_sesv2_configuration_set" "this" {
  configuration_set_name = var.configuration_set_name

  delivery_options {
    tls_policy = "REQUIRE"
  }

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }

  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }
}

resource "aws_sesv2_configuration_set_event_destination" "cloudwatch" {
  configuration_set_name = aws_sesv2_configuration_set.this.configuration_set_name
  event_destination_name = "cloudwatch-metrics"

  event_destination {
    enabled              = true
    matching_event_types = ["SEND", "REJECT", "BOUNCE", "COMPLAINT", "DELIVERY", "RENDERING_FAILURE", "DELIVERY_DELAY"]

    cloud_watch_destination {
      dimension_configuration {
        dimension_name          = "ses:configuration-set"
        dimension_value_source  = "MESSAGE_TAG"
        default_dimension_value = var.configuration_set_name
      }
    }
  }
}

resource "aws_sesv2_email_identity" "this" {
  email_identity         = var.domain
  configuration_set_name = aws_sesv2_configuration_set.this.configuration_set_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

resource "aws_sesv2_email_identity_mail_from_attributes" "this" {
  email_identity         = aws_sesv2_email_identity.this.email_identity
  mail_from_domain       = local.mail_from_domain
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

resource "aws_route53_record" "dkim" {
  count = local.manage_dns ? 3 : 0

  zone_id = var.route53_zone_id
  name    = "${aws_sesv2_email_identity.this.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.domain}"
  type    = "CNAME"
  ttl     = 1800
  records = ["${aws_sesv2_email_identity.this.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

resource "aws_route53_record" "mail_from_mx" {
  count = local.manage_dns ? 1 : 0

  zone_id = var.route53_zone_id
  name    = local.mail_from_domain
  type    = "MX"
  ttl     = 1800
  records = ["10 feedback-smtp.${data.aws_region.current.region}.amazonses.com"]
}

resource "aws_route53_record" "mail_from_spf" {
  count = local.manage_dns ? 1 : 0

  zone_id = var.route53_zone_id
  name    = local.mail_from_domain
  type    = "TXT"
  ttl     = 1800
  records = ["v=spf1 include:amazonses.com -all"]
}

resource "aws_route53_record" "dmarc" {
  count = local.manage_dns ? 1 : 0

  zone_id = var.route53_zone_id
  name    = "_dmarc.${var.domain}"
  type    = "TXT"
  ttl     = 1800
  records = [var.dmarc_policy]
}
