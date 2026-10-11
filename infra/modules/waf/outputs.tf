output "arn" {
  description = "Web ACL ARN."
  value       = aws_wafv2_web_acl.this.arn
}

output "managed_rule_groups_with_blocks" {
  description = "AWS managed rule groups that have rules blocking with the edge_blocked body: each needs a pinned version in prod."
  value       = sort([for group in local.managed_rule_groups_with_blocks : group.name if length(group.block) > 0])
}

output "name" {
  description = "Web ACL name."
  value       = aws_wafv2_web_acl.this.name
}
