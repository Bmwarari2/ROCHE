output "key_arns" {
  description = "Key ARNs by purpose."
  value       = { for k, v in aws_kms_key.this : k => v.arn }
}

output "key_ids" {
  description = "Key IDs by purpose."
  value       = { for k, v in aws_kms_key.this : k => v.key_id }
}

output "alias_arns" {
  description = "Alias ARNs by purpose."
  value       = { for k, v in aws_kms_alias.this : k => v.arn }
}
