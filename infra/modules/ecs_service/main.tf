# One Fargate service: task definition (read-only root filesystem, non-root user, all Linux
# capabilities dropped), KMS-encrypted log group, secrets injected from Secrets Manager,
# optional ALB target group and listener rule, and CPU and memory target-tracking autoscaling.

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  full_name  = "${var.name_prefix}-${var.name}"
  has_lb     = var.load_balancer != null
  has_port   = var.container_port != null
  partition  = data.aws_partition.current.partition
  volumes    = { for i, p in var.writable_paths : "scratch${i}" => p }
  has_header = local.has_lb ? var.load_balancer.required_header_name != null : false

  # Strip any ":json-key:version-stage:version-id" suffix to get the secret ARN for IAM.
  secret_arns = distinct([
    for v in values(var.secrets) : join(":", slice(split(":", v), 0, 7))
  ])

  container = merge(
    {
      name                   = var.name
      image                  = var.image
      essential              = true
      user                   = var.user
      readonlyRootFilesystem = true
      stopTimeout            = var.stop_timeout

      portMappings = local.has_port ? [{
        name          = var.name
        containerPort = var.container_port
        protocol      = "tcp"
      }] : []

      environment = [for k, v in var.environment : { name = k, value = v }]
      secrets     = [for k, v in var.secrets : { name = k, valueFrom = v }]

      mountPoints = [for vol, path in local.volumes : {
        sourceVolume  = vol
        containerPath = path
        readOnly      = false
      }]

      linuxParameters = {
        initProcessEnabled = true
        capabilities = {
          add  = []
          drop = ["ALL"]
        }
      }

      ulimits = [{ name = "nofile", softLimit = 65536, hardLimit = 65536 }]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.this.name
          awslogs-region        = data.aws_region.current.region
          awslogs-stream-prefix = var.name
        }
      }
    },
    var.command == null ? {} : { command = var.command },
    var.health_check_command == null ? {} : {
      healthCheck = {
        command     = var.health_check_command
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
    },
  )
}

resource "aws_cloudwatch_log_group" "this" {
  name                        = "/harbour/${var.name_prefix}/${var.name}"
  retention_in_days           = var.log_retention_days
  kms_key_id                  = var.log_kms_key_arn
  deletion_protection_enabled = var.log_group_deletion_protection
}

# ---------------------------------------------------------------------------------------------
# IAM: the execution role starts the task (pull image, write logs, read secrets); the task
# role is what the application code can do.
# ---------------------------------------------------------------------------------------------

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.full_name}-execution"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  count = length(var.secrets) > 0 ? 1 : 0

  statement {
    sid       = "ReadInjectedSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = local.secret_arns
  }

  statement {
    sid       = "DecryptInjectedSecrets"
    actions   = ["kms:Decrypt"]
    resources = [var.secrets_kms_key_arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  count = length(var.secrets) > 0 ? 1 : 0

  name   = "read-injected-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets[0].json
}

resource "aws_iam_role" "task" {
  name               = "${local.full_name}-task"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "task" {
  count = length(var.task_role_statements) > 0 ? 1 : 0

  dynamic "statement" {
    for_each = var.task_role_statements

    content {
      sid       = statement.value.sid
      actions   = statement.value.actions
      resources = statement.value.resources

      dynamic "condition" {
        for_each = statement.value.conditions

        content {
          test     = condition.value.test
          variable = condition.value.variable
          values   = condition.value.values
        }
      }
    }
  }
}

resource "aws_iam_role_policy" "task" {
  count = length(var.task_role_statements) > 0 ? 1 : 0

  name   = "application"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task[0].json
}

# ---------------------------------------------------------------------------------------------
# Task definition
# ---------------------------------------------------------------------------------------------

resource "aws_ecs_task_definition" "this" {
  family                   = local.full_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.cpu)
  memory                   = tostring(var.memory)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions    = jsonencode([local.container])

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  # Task-local scratch space for the writable paths; nothing persists between tasks.
  dynamic "volume" {
    for_each = local.volumes

    content {
      name = volume.key
    }
  }
}

# ---------------------------------------------------------------------------------------------
# Networking
# ---------------------------------------------------------------------------------------------

resource "aws_security_group" "this" {
  name        = "${local.full_name}-task"
  description = "Tasks of the ${local.full_name} service"
  vpc_id      = var.vpc_id

  tags = { Name = "${local.full_name}-task" }
}

resource "aws_vpc_security_group_ingress_rule" "from_alb" {
  count = local.has_lb && local.has_port ? 1 : 0

  security_group_id            = aws_security_group.this.id
  description                  = "From the load balancer"
  ip_protocol                  = "tcp"
  from_port                    = var.container_port
  to_port                      = var.container_port
  referenced_security_group_id = var.load_balancer.security_group_id
}

# Outbound HTTPS is needed for third parties that have no VPC endpoint (SES API, Sentry EU,
# Grafana Cloud UK, Expo push, the JWKS URL). Traffic leaves through the NAT gateway.
#trivy:ignore:AVD-AWS-0104
resource "aws_vpc_security_group_egress_rule" "https" {
  count = var.allow_https_egress ? 1 : 0

  security_group_id = aws_security_group.this.id
  description       = "HTTPS to AWS endpoints and approved third parties"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "to_security_groups" {
  for_each = var.egress_security_groups

  security_group_id            = aws_security_group.this.id
  description                  = "To ${each.key}"
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
  referenced_security_group_id = each.value.security_group_id
}

# ---------------------------------------------------------------------------------------------
# Load balancing
# ---------------------------------------------------------------------------------------------

resource "aws_lb_target_group" "this" {
  #checkov:skip=CKV_AWS_378:TLS terminates at the ALB; the hop to the task stays inside private subnets of the VPC, restricted by security groups to the ALB.
  count = local.has_lb ? 1 : 0

  name                 = substr(local.full_name, 0, 32)
  port                 = var.container_port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = var.load_balancer.deregistration_delay

  health_check {
    path                = var.load_balancer.health_check_path
    matcher             = var.load_balancer.health_check_matcher
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = { Name = local.full_name }
}

resource "aws_lb_listener_rule" "this" {
  count = local.has_lb ? 1 : 0

  listener_arn = var.load_balancer.listener_arn
  priority     = var.load_balancer.priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this[0].arn
  }

  condition {
    host_header {
      values = var.load_balancer.host_headers
    }
  }

  # Used by the web tier so that only CloudFront (which adds the header) reaches the origin.
  dynamic "condition" {
    for_each = local.has_header ? [1] : []

    content {
      http_header {
        http_header_name = var.load_balancer.required_header_name
        values           = [var.load_balancer.required_header_value]
      }
    }
  }
}

# ---------------------------------------------------------------------------------------------
# Service and autoscaling
# ---------------------------------------------------------------------------------------------

resource "aws_ecs_service" "this" {
  count = var.create_service ? 1 : 0

  name                               = var.name
  cluster                            = var.cluster
  task_definition                    = aws_ecs_task_definition.this.arn
  desired_count                      = var.desired_count
  platform_version                   = "LATEST"
  enable_execute_command             = false
  propagate_tags                     = "SERVICE"
  enable_ecs_managed_tags            = true
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = local.has_lb ? var.health_check_grace_period_seconds : null
  availability_zone_rebalancing      = "ENABLED"

  capacity_provider_strategy {
    capacity_provider = var.use_fargate_spot ? "FARGATE_SPOT" : "FARGATE"
    weight            = 1
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.this.id]
    assign_public_ip = false
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  dynamic "load_balancer" {
    for_each = local.has_lb ? [1] : []

    content {
      target_group_arn = aws_lb_target_group.this[0].arn
      container_name   = var.name
      container_port   = var.container_port
    }
  }

  # Autoscaling owns the running count after the first deployment.
  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener_rule.this]
}

resource "aws_appautoscaling_target" "this" {
  count = var.create_service ? 1 : 0

  service_namespace  = "ecs"
  resource_id        = "service/${var.cluster_name}/${aws_ecs_service.this[0].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.min_capacity
  max_capacity       = var.max_capacity
}

resource "aws_appautoscaling_policy" "cpu" {
  count = var.create_service ? 1 : 0

  name               = "${local.full_name}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this[0].service_namespace
  resource_id        = aws_appautoscaling_target.this[0].resource_id
  scalable_dimension = aws_appautoscaling_target.this[0].scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = var.cpu_target_percent
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

resource "aws_appautoscaling_policy" "memory" {
  count = var.create_service ? 1 : 0

  name               = "${local.full_name}-memory"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this[0].service_namespace
  resource_id        = aws_appautoscaling_target.this[0].resource_id
  scalable_dimension = aws_appautoscaling_target.this[0].scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = var.memory_target_percent
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageMemoryUtilization"
    }
  }
}
