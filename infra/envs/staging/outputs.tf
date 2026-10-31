output "deploy_role_arn" {
  description = "Role for GitHub Actions on main. Store it as the AWS_DEPLOY_ROLE_ARN repository secret."
  value       = module.stack.deploy_role_arn
}

output "plan_role_arn" {
  description = "Role for pull request plans. Store it as the AWS_PLAN_ROLE_ARN repository secret."
  value       = module.stack.plan_role_arn
}

output "ecr_repository_urls" {
  description = "ECR repository URLs by short name."
  value       = module.stack.ecr_repository_urls
}

output "alb_dns_name" {
  description = "DNS name of the application load balancer."
  value       = module.stack.alb_dns_name
}

output "cloudfront_domain_name" {
  description = "CloudFront domain name serving the web app."
  value       = module.stack.cloudfront_domain_name
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID."
  value       = module.stack.cloudfront_distribution_id
}

output "hostnames" {
  description = "Public hostnames."
  value       = module.stack.hostnames
}

output "ecs_cluster_name" {
  description = "ECS cluster name."
  value       = module.stack.ecs_cluster_name
}

output "migrate_task" {
  description = "Parameters for running the migration task."
  value       = module.stack.migrate_task
}

output "release_parameters" {
  description = "SSM release pointers updated by the deploy workflow."
  value       = module.stack.release_parameters
}

output "secret_names" {
  description = "Secrets to populate with infra/scripts/seed-secrets.sh."
  value       = module.stack.secret_names
}

output "database_endpoints" {
  description = "Private database endpoints."
  value       = module.stack.database_endpoints
}

output "bucket_names" {
  description = "S3 bucket names."
  value       = module.stack.bucket_names
}

output "alerts_topic_arn" {
  description = "SNS alert topic."
  value       = module.stack.alerts_topic_arn
}

output "nat_public_ips" {
  description = "Outbound IP addresses."
  value       = module.stack.nat_public_ips
}

output "manual_dns_records" {
  description = "DNS records to create by hand when Route 53 is not managed here."
  value       = module.stack.manual_dns_records
}

output "manual_elearning_dns_records" {
  description = "DNS records to create by hand in the e-learning content domain (ADR-0093)."
  value       = module.stack.manual_elearning_dns_records
}
