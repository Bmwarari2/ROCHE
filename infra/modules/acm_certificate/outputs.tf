output "certificate_arn" {
  description = "Certificate ARN. When DNS is managed here, this waits for validation to finish."
  value       = local.manage_dns ? aws_acm_certificate_validation.this[0].certificate_arn : aws_acm_certificate.this.arn
}

output "domain_validation_records" {
  description = "DNS records that prove control of the domain; create them by hand when Route 53 is not used."
  value = [for dvo in aws_acm_certificate.this.domain_validation_options : {
    name  = dvo.resource_record_name
    type  = dvo.resource_record_type
    value = dvo.resource_record_value
  }]
}
