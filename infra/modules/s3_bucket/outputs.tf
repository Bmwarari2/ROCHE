output "bucket_id" {
  description = "Bucket name. Available only once the bucket policy is in place, so log delivery to it works on first apply."
  value       = aws_s3_bucket.this.id

  depends_on = [aws_s3_bucket_policy.this]
}

output "bucket_arn" {
  description = "Bucket ARN."
  value       = aws_s3_bucket.this.arn
}

output "bucket_regional_domain_name" {
  description = "Regional domain name of the bucket."
  value       = aws_s3_bucket.this.bucket_regional_domain_name
}
