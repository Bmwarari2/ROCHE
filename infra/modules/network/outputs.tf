output "vpc_id" {
  description = "VPC ID."
  value       = aws_vpc.this.id
}

output "vpc_cidr_block" {
  description = "VPC IPv4 CIDR block."
  value       = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  description = "Public subnet IDs, one per availability zone."
  value       = [for az in var.availability_zones : aws_subnet.public[az].id]
}

output "private_subnet_ids" {
  description = "Private subnet IDs, one per availability zone."
  value       = [for az in var.availability_zones : aws_subnet.private[az].id]
}

output "data_subnet_ids" {
  description = "Isolated data subnet IDs, one per availability zone."
  value       = [for az in var.availability_zones : aws_subnet.data[az].id]
}

output "nat_public_ips" {
  description = "Elastic IP addresses of the NAT gateways (useful for allow-lists at third parties)."
  value       = [for eip in aws_eip.nat : eip.public_ip]
}

output "s3_gateway_endpoint_id" {
  description = "ID of the S3 gateway endpoint (usable in bucket policies with aws:SourceVpce)."
  value       = aws_vpc_endpoint.s3.id
}
