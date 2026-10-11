# RDS for PostgreSQL 17, private, encrypted with a customer-managed key, with pgAudit,
# IAM authentication, Multi-AZ, 35 days of point-in-time recovery and enhanced monitoring.
# Used twice: the main Harbour database and the PowerSync bucket-storage database.

locals {
  family = "postgres${split(".", var.engine_version)[0]}"

  # pgAudit is configured to log DDL, role changes and writes, not reads:
  #   - Harbour's audit_event table (section 5.5) records every view of a care record with the
  #     actor, role, tenant, device and reason. pgAudit cannot add that context, because every
  #     request arrives through the same application role, so a database-level READ log would
  #     add volume without adding attribution.
  #   - Logging every SELECT (including PowerSync snapshots and RLS-filtered list screens)
  #     would multiply log volume and cost many times over and bury the DDL, privilege and
  #     write events that the log exists to make tamper-evident.
  #   - Statement text for reads carries search terms and filter literals, which are more
  #     likely to contain personal data; logs must be scrubbed of personal data (section 5.3).
  # pgaudit.log_parameter stays off so that bound parameter values (the personal data in a
  # parameterised INSERT or UPDATE) never reach CloudWatch.
  base_parameters = {
    "shared_preload_libraries" = { value = "pgaudit,pg_stat_statements", apply_method = "pending-reboot" }
    "pgaudit.log"              = { value = "ddl,role,write", apply_method = "immediate" }
    "pgaudit.log_relation"     = { value = "1", apply_method = "immediate" }
    "pgaudit.log_parameter"    = { value = "0", apply_method = "immediate" }
    "pgaudit.log_catalog"      = { value = "0", apply_method = "immediate" }
    "rds.force_ssl"            = { value = "1", apply_method = "immediate" }
    "ssl_min_protocol_version" = { value = "TLSv1.2", apply_method = "immediate" }
    "log_connections"          = { value = "1", apply_method = "immediate" }
    "log_disconnections"       = { value = "1", apply_method = "immediate" }
    "log_statement"            = { value = "none", apply_method = "immediate" }
    "password_encryption"      = { value = "scram-sha-256", apply_method = "immediate" }
  }

  replication_parameters = var.logical_replication ? {
    "rds.logical_replication" = { value = "1", apply_method = "pending-reboot" }
    "max_slot_wal_keep_size"  = { value = tostring(var.max_slot_wal_keep_size_mb), apply_method = "immediate" }
  } : {}

  parameters = merge(local.base_parameters, local.replication_parameters, var.extra_parameters)

  log_exports = ["postgresql", "upgrade"]
}

resource "aws_db_subnet_group" "this" {
  name        = var.identifier
  description = "Isolated data subnets for ${var.identifier}"
  subnet_ids  = var.subnet_ids
}

resource "aws_db_parameter_group" "this" {
  name_prefix = "${var.identifier}-"
  family      = local.family
  description = "Harbour hardened parameters for ${var.identifier}"

  dynamic "parameter" {
    for_each = local.parameters

    content {
      name         = parameter.key
      value        = parameter.value.value
      apply_method = parameter.value.apply_method
    }
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "this" {
  name        = "${var.identifier}-db"
  description = "Postgres access for ${var.identifier}"
  vpc_id      = var.vpc_id

  tags = { Name = "${var.identifier}-db" }
}

resource "aws_vpc_security_group_ingress_rule" "postgres" {
  for_each = var.allowed_security_group_ids

  security_group_id            = aws_security_group.this.id
  description                  = "Postgres from ${each.key}"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = each.value
}

# Pre-create the export log groups so they are KMS-encrypted and have a retention period;
# RDS would otherwise create them unencrypted with logs kept forever.
resource "aws_cloudwatch_log_group" "exports" {
  for_each = toset(local.log_exports)

  name              = "/aws/rds/instance/${var.identifier}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn
}

data "aws_iam_policy_document" "monitoring_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "monitoring" {
  name               = "${var.identifier}-rds-monitoring"
  assume_role_policy = data.aws_iam_policy_document.monitoring_assume.json
}

data "aws_partition" "current" {}

resource "aws_iam_role_policy_attachment" "monitoring" {
  role       = aws_iam_role.monitoring.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_db_instance" "this" {
  #checkov:skip=CKV2_AWS_69:rds.force_ssl = 1 and ssl_min_protocol_version = TLSv1.2 are set in the parameter group through local.parameters, which the scanner cannot evaluate.
  identifier     = var.identifier
  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  # Do not drift into paid RDS Extended Support at the end of the major version's life.
  engine_lifecycle_support = "open-source-rds-extended-support-disabled"

  db_name  = var.db_name
  username = var.master_username
  port     = 5432

  manage_master_user_password   = true
  master_user_secret_kms_key_id = var.secrets_kms_key_arn

  iam_database_authentication_enabled = true

  allocated_storage     = var.allocated_storage
  max_allocated_storage = var.max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = var.kms_key_arn

  multi_az               = var.multi_az
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.this.id]
  publicly_accessible    = false
  network_type           = "IPV4"
  ca_cert_identifier     = "rds-ca-rsa2048-g1"

  parameter_group_name = aws_db_parameter_group.this.name

  backup_retention_period   = var.backup_retention_days
  backup_window             = var.backup_window
  maintenance_window        = var.maintenance_window
  copy_tags_to_snapshot     = true
  delete_automated_backups  = false
  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = var.skip_final_snapshot
  final_snapshot_identifier = "${var.identifier}-final"

  auto_minor_version_upgrade  = true
  allow_major_version_upgrade = false
  apply_immediately           = var.apply_immediately

  performance_insights_enabled          = true
  performance_insights_kms_key_id       = var.kms_key_arn
  performance_insights_retention_period = var.performance_insights_retention_days

  monitoring_interval = var.monitoring_interval
  monitoring_role_arn = aws_iam_role.monitoring.arn

  enabled_cloudwatch_logs_exports = local.log_exports

  tags = { Name = var.identifier }

  depends_on = [
    aws_cloudwatch_log_group.exports,
    aws_iam_role_policy_attachment.monitoring,
  ]
}
