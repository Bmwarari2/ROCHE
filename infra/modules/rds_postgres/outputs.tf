output "instance_id" {
  description = "RDS instance identifier."
  value       = aws_db_instance.this.identifier
}

output "instance_arn" {
  description = "RDS instance ARN."
  value       = aws_db_instance.this.arn
}

output "resource_id" {
  description = "DbiResourceId, used in rds-db:connect IAM policies."
  value       = aws_db_instance.this.resource_id
}

output "address" {
  description = "Hostname of the instance endpoint."
  value       = aws_db_instance.this.address
}

output "port" {
  description = "Port of the instance endpoint."
  value       = aws_db_instance.this.port
}

output "db_name" {
  description = "Name of the initial database."
  value       = aws_db_instance.this.db_name
}

output "master_username" {
  description = "Master user name."
  value       = aws_db_instance.this.username
}

output "master_user_secret_arn" {
  description = "ARN of the RDS-managed Secrets Manager secret holding the master credentials."
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "security_group_id" {
  description = "Security group attached to the instance."
  value       = aws_security_group.this.id
}

output "parameter_group_name" {
  description = "Name of the parameter group."
  value       = aws_db_parameter_group.this.name
}
