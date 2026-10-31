output "deploy_role_arn" {
  description = "IAM role for GitHub Actions on main (repository secret AWS_DEPLOY_ROLE_ARN)."
  value       = module.github_oidc.deploy_role_arn
}

output "plan_role_arn" {
  description = "IAM role for GitHub Actions pull request plans (repository secret AWS_PLAN_ROLE_ARN)."
  value       = module.github_oidc.plan_role_arn
}

output "ecr_repository_urls" {
  description = "ECR repository URLs by short name."
  value       = module.ecr.repository_urls
}

output "alb_dns_name" {
  description = "DNS name of the application load balancer."
  value       = module.alb.dns_name
}

output "cloudfront_domain_name" {
  description = "CloudFront domain name serving the web app."
  value       = module.cdn.domain_name
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID, for cache invalidations after a web release."
  value       = module.cdn.distribution_id
}

output "hostnames" {
  description = "Public hostnames of this environment."
  value       = local.hosts
}

output "ecs_cluster_name" {
  description = "ECS cluster name."
  value       = local.cluster_name
}

output "migrate_task" {
  description = "Everything `aws ecs run-task` needs to run the bootstrap and migration task."
  value = {
    task_definition   = module.task_migrate.task_definition_family
    subnets           = module.network.private_subnet_ids
    security_group_id = module.task_migrate.security_group_id
  }
}

output "release_parameters" {
  description = "SSM parameters the deploy workflow updates with the released image tag."
  value       = { for k, v in aws_ssm_parameter.release : k => v.name }
}

output "secret_names" {
  description = "Secrets Manager secrets to populate with infra/scripts/seed-secrets.sh."
  value       = { for k, v in aws_secretsmanager_secret.this : k => v.name }
}

output "database_endpoints" {
  description = "Private endpoints of the main and PowerSync bucket-storage databases."
  value = {
    main         = module.db_main.address
    sync_storage = module.db_sync_storage.address
  }
}

output "bucket_names" {
  description = "S3 bucket names."
  value = {
    documents     = module.bucket_documents.bucket_id
    exports       = module.bucket_exports.bucket_id
    audit_archive = module.bucket_audit_archive.bucket_id
    logs          = module.bucket_logs.bucket_id
  }
}

output "alerts_topic_arn" {
  description = "SNS topic receiving alarms and budget notifications."
  value       = module.observability.alerts_topic_arn
}

output "nat_public_ips" {
  description = "Outbound IP addresses, for third-party allow-lists."
  value       = module.network.nat_public_ips
}

output "manual_elearning_dns_records" {
  description = "DNS records to create by hand in the e-learning content domain when elearning_route53_zone_id is null (ADR-0093)."
  value = !local.learn_enabled || var.elearning_route53_zone_id != null ? null : {
    certificate_validation = module.cert_learn[0].domain_validation_records
    aliases                = [{ name = local.hosts.learn, type = "CNAME", value = module.cdn_learn[0].domain_name }]
  }
}

output "manual_dns_records" {
  description = "DNS records to create by hand when route53_zone_id is null (certificate validation, aliases, SES)."
  value = var.route53_zone_id != null ? null : {
    certificate_validation = concat(module.cert_regional.domain_validation_records, module.cert_cloudfront.domain_validation_records)
    aliases = concat(
      [{ name = local.hosts.web, type = "CNAME", value = module.cdn.domain_name }],
      [for h in local.alb_hosts : { name = local.hosts[h], type = "CNAME", value = module.alb.dns_name }],
    )
    email = module.ses.dns_records
  }
}
