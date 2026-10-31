output "service_name" {
  description = "ECS service name (null when only a task definition is created)."
  value       = var.create_service ? aws_ecs_service.this[0].name : null
}

output "task_definition_arn" {
  description = "Task definition ARN including revision."
  value       = aws_ecs_task_definition.this.arn
}

output "task_definition_family" {
  description = "Task definition family, for run-task calls."
  value       = aws_ecs_task_definition.this.family
}

output "task_role_arn" {
  description = "Task (application) role ARN."
  value       = aws_iam_role.task.arn
}

output "execution_role_arn" {
  description = "Execution role ARN."
  value       = aws_iam_role.execution.arn
}

output "security_group_id" {
  description = "Security group of the tasks."
  value       = aws_security_group.this.id
}

output "target_group_arn" {
  description = "Target group ARN, for extra listener rules (null without a load balancer)."
  value       = local.has_lb ? aws_lb_target_group.this[0].arn : null
}

output "target_group_arn_suffix" {
  description = "Target group ARN suffix for CloudWatch dimensions (null without a load balancer)."
  value       = local.has_lb ? aws_lb_target_group.this[0].arn_suffix : null
}

output "log_group_name" {
  description = "CloudWatch log group of the service."
  value       = aws_cloudwatch_log_group.this.name
}
