output "deploy_role_arn" {
  description = "Role assumed by workflows on main (store as the AWS_DEPLOY_ROLE_ARN repository secret)."
  value       = aws_iam_role.deploy.arn
}

output "plan_role_arn" {
  description = "Role assumed by pull request workflows for terraform plan (store as AWS_PLAN_ROLE_ARN)."
  value       = aws_iam_role.plan.arn
}

output "oidc_provider_arn" {
  description = "GitHub OIDC identity provider ARN."
  value       = local.provider_arn
}
