output "repository_urls" {
  description = "Repository URLs by short name."
  value       = { for k, v in aws_ecr_repository.this : k => v.repository_url }
}

output "repository_arns" {
  description = "Repository ARNs by short name."
  value       = { for k, v in aws_ecr_repository.this : k => v.arn }
}
