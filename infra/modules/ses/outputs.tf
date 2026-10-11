output "identity_arn" {
  description = "SES domain identity ARN (for ses:SendEmail permissions)."
  value       = aws_sesv2_email_identity.this.arn
}

output "configuration_set_name" {
  description = "Configuration set every message must use."
  value       = aws_sesv2_configuration_set.this.configuration_set_name
}

output "configuration_set_arn" {
  description = "Configuration set ARN."
  value       = aws_sesv2_configuration_set.this.arn
}

output "dns_records" {
  description = "DNS records to publish for DKIM, MAIL FROM and DMARC when Route 53 is not managed here."
  value = concat(
    [for t in aws_sesv2_email_identity.this.dkim_signing_attributes[0].tokens : {
      name  = "${t}._domainkey.${var.domain}"
      type  = "CNAME"
      value = "${t}.dkim.amazonses.com"
    }],
    [
      { name = local.mail_from_domain, type = "MX", value = "10 feedback-smtp.${data.aws_region.current.region}.amazonses.com" },
      { name = local.mail_from_domain, type = "TXT", value = "v=spf1 include:amazonses.com -all" },
      { name = "_dmarc.${var.domain}", type = "TXT", value = var.dmarc_policy },
    ],
  )
}
