output "distribution_id" {
  description = "Distribution ID (for cache invalidations)."
  value       = aws_cloudfront_distribution.this.id
}

output "distribution_arn" {
  description = "Distribution ARN."
  value       = aws_cloudfront_distribution.this.arn
}

output "domain_name" {
  description = "CloudFront domain name for DNS aliases."
  value       = aws_cloudfront_distribution.this.domain_name
}

output "hosted_zone_id" {
  description = "Route 53 zone ID of CloudFront, for alias records."
  value       = aws_cloudfront_distribution.this.hosted_zone_id
}
