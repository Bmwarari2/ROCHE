output "arn" {
  description = "Load balancer ARN."
  value       = aws_lb.this.arn
}

output "arn_suffix" {
  description = "Load balancer ARN suffix, used as the CloudWatch dimension."
  value       = aws_lb.this.arn_suffix
}

output "dns_name" {
  description = "Load balancer DNS name."
  value       = aws_lb.this.dns_name
}

output "zone_id" {
  description = "Route 53 hosted zone ID of the load balancer, for alias records."
  value       = aws_lb.this.zone_id
}

output "https_listener_arn" {
  description = "HTTPS listener ARN, for host-based listener rules."
  value       = aws_lb_listener.https.arn
}

output "security_group_id" {
  description = "Security group of the load balancer."
  value       = aws_security_group.this.id
}
