# VPC across the three London availability zones with three subnet tiers:
#   public        - load balancers and NAT gateways only
#   private       - ECS tasks and interface endpoints; egress through NAT
#   isolated data - RDS only; no route to the internet in either direction

data "aws_region" "current" {}

locals {
  az_count = length(var.availability_zones)
  azs      = { for i, az in var.availability_zones : az => i }

  # 10.40.0.0/24 to 10.40.2.0/24 public, 10.40.16.0/20 onwards private, 10.40.200.0/24 onwards data.
  public_cidrs  = { for az, i in local.azs : az => cidrsubnet(var.cidr_block, 8, i) }
  private_cidrs = { for az, i in local.azs : az => cidrsubnet(var.cidr_block, 4, i + 1) }
  data_cidrs    = { for az, i in local.azs : az => cidrsubnet(var.cidr_block, 8, 200 + i) }

  nat_azs = var.nat_gateway_per_az ? var.availability_zones : [var.availability_zones[0]]

  endpoint_azs = slice(var.availability_zones, 0, min(var.interface_endpoint_az_count, local.az_count))
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr_block
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = var.name_prefix }
}

# Remove every rule from the default security group so nothing can use it by accident.
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-default-deny" }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = { Name = var.name_prefix }
}

resource "aws_subnet" "public" {
  for_each = local.public_cidrs

  vpc_id            = aws_vpc.this.id
  availability_zone = each.key
  cidr_block        = each.value

  # Load balancers get public addresses through their own configuration; instances never do.
  map_public_ip_on_launch = false

  tags = {
    Name = "${var.name_prefix}-public-${each.key}"
    Tier = "public"
  }
}

resource "aws_subnet" "private" {
  for_each = local.private_cidrs

  vpc_id            = aws_vpc.this.id
  availability_zone = each.key
  cidr_block        = each.value

  tags = {
    Name = "${var.name_prefix}-private-${each.key}"
    Tier = "private"
  }
}

resource "aws_subnet" "data" {
  for_each = local.data_cidrs

  vpc_id            = aws_vpc.this.id
  availability_zone = each.key
  cidr_block        = each.value

  tags = {
    Name = "${var.name_prefix}-data-${each.key}"
    Tier = "data"
  }
}

resource "aws_eip" "nat" {
  #checkov:skip=CKV2_AWS_19:These addresses belong to NAT gateways, not EC2 instances.
  for_each = toset(local.nat_azs)

  domain = "vpc"

  tags = { Name = "${var.name_prefix}-nat-${each.key}" }
}

resource "aws_nat_gateway" "this" {
  for_each = toset(local.nat_azs)

  allocation_id = aws_eip.nat[each.key].id
  subnet_id     = aws_subnet.public[each.key].id

  tags = { Name = "${var.name_prefix}-${each.key}" }

  depends_on = [aws_internet_gateway.this]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  for_each = local.azs

  vpc_id = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-private-${each.key}" }
}

resource "aws_route" "private_nat" {
  for_each = local.azs

  route_table_id         = aws_route_table.private[each.key].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[var.nat_gateway_per_az ? each.key : local.nat_azs[0]].id
}

resource "aws_route_table_association" "private" {
  for_each = aws_subnet.private

  subnet_id      = each.value.id
  route_table_id = aws_route_table.private[each.key].id
}

# The data tier has a route table with only the local route (and the S3 gateway endpoint),
# so databases cannot reach or be reached from the internet.
resource "aws_route_table" "data" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-data" }
}

resource "aws_route_table_association" "data" {
  for_each = aws_subnet.data

  subnet_id      = each.value.id
  route_table_id = aws_route_table.data.id
}

# ---------------------------------------------------------------------------------------------
# Flow logs: every accepted and rejected connection, encrypted with the logs key.
# ---------------------------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "flow_logs" {
  name                        = "/harbour/${var.name_prefix}/vpc-flow-logs"
  retention_in_days           = var.flow_log_retention_days
  kms_key_id                  = var.flow_log_kms_key_arn
  deletion_protection_enabled = var.log_group_deletion_protection
}

data "aws_iam_policy_document" "flow_logs_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["vpc-flow-logs.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "flow_logs" {
  name               = "${var.name_prefix}-vpc-flow-logs"
  assume_role_policy = data.aws_iam_policy_document.flow_logs_assume.json
}

data "aws_iam_policy_document" "flow_logs" {
  statement {
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogGroups",
      "logs:DescribeLogStreams",
    ]
    resources = [aws_cloudwatch_log_group.flow_logs.arn, "${aws_cloudwatch_log_group.flow_logs.arn}:*"]
  }
}

resource "aws_iam_role_policy" "flow_logs" {
  name   = "write-flow-logs"
  role   = aws_iam_role.flow_logs.id
  policy = data.aws_iam_policy_document.flow_logs.json
}

resource "aws_flow_log" "this" {
  vpc_id                   = aws_vpc.this.id
  traffic_type             = "ALL"
  log_destination_type     = "cloud-watch-logs"
  log_destination          = aws_cloudwatch_log_group.flow_logs.arn
  iam_role_arn             = aws_iam_role.flow_logs.arn
  max_aggregation_interval = 60

  tags = { Name = "${var.name_prefix}-vpc" }
}

# ---------------------------------------------------------------------------------------------
# VPC endpoints
# ---------------------------------------------------------------------------------------------

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = concat([for rt in aws_route_table.private : rt.id], [aws_route_table.data.id])

  tags = { Name = "${var.name_prefix}-s3" }
}

resource "aws_security_group" "endpoints" {
  name        = "${var.name_prefix}-vpc-endpoints"
  description = "HTTPS from inside the VPC to interface endpoints"
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${var.name_prefix}-vpc-endpoints" }
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_https" {
  security_group_id = aws_security_group.endpoints.id
  description       = "HTTPS from the VPC"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = aws_vpc.this.cidr_block
}

resource "aws_vpc_endpoint" "interface" {
  for_each = toset(var.interface_endpoint_services)

  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${data.aws_region.current.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = [for az in local.endpoint_azs : aws_subnet.private[az].id]
  security_group_ids  = [aws_security_group.endpoints.id]

  tags = { Name = "${var.name_prefix}-${each.key}" }
}
