# The Harbour platform for one environment (one Google Cloud project), composed from the modules
# in infra/modules. dev, staging and prod all call this module and differ only in sizing and
# protection settings, so that staging is a faithful rehearsal of prod (ADR-0098).
#
# Residency: everything that stores or processes personal data is created in europe-west2, and
# the gcp.resourceLocations organisation policy (infra/bootstrap) refuses anything else. The load balancer, its
# certificates, Cloud Armor, Cloud CDN (static files only) and Cloud DNS are global services that
# hold no personal data.

locals {
  name_prefix = "harbour-${var.environment}"
  is_prod     = var.environment == "prod"
  labels = merge(var.labels, {
    project     = "harbour"
    environment = var.environment
    managed_by  = "terraform"
  })

  hosts = {
    web   = "app.${var.domain_name}"
    api   = "api.${var.domain_name}"
    sync  = "sync.${var.domain_name}"
    flags = "flags.${var.domain_name}"
  }

  default_sizes = {
    api       = { cpu = "1", memory = "1Gi", min = 1, max = 4 }
    worker    = { cpu = "1", memory = "1Gi", min = 1, max = 2 }
    web       = { cpu = "1", memory = "1Gi", min = 1, max = 4 }
    powersync = { cpu = "1", memory = "2Gi", min = 1, max = 1 }
    migrate   = { cpu = "1", memory = "1Gi", min = 0, max = 0 }
    flagsmith = { cpu = "1", memory = "1Gi", min = 1, max = 1 }
  }
  sizes = merge(local.default_sizes, var.service_sizes)

  ports = {
    api       = 4000
    web       = 3000
    powersync = 8080
    flagsmith = 8000
  }

  # Write-once locks are irreversible, so they are on in prod only unless set otherwise.
  lock_audit_archive = coalesce(var.lock_audit_archive, local.is_prod)
  lock_security_logs = coalesce(var.lock_security_logs, local.is_prod)
}

# A lock outside prod would make a dev or staging bucket impossible to delete for a year.
resource "terraform_data" "locks_only_in_prod" {
  input = { audit = local.lock_audit_archive, security_logs = local.lock_security_logs }

  lifecycle {
    precondition {
      condition     = local.is_prod || (!local.lock_audit_archive && !local.lock_security_logs)
      error_message = "Retention locks are irreversible and are set in prod only."
    }

    precondition {
      condition     = !local.is_prod || var.audit_archive_retention_days >= 365
      error_message = "Prod keeps the audit archive for at least 365 days (section 5.5)."
    }
  }
}

# ---------------------------------------------------------------------------------------------
# Project, keys and network
# ---------------------------------------------------------------------------------------------

module "project" {
  source = "../project_baseline"

  project_id = var.project_id
  region     = var.region
}

module "kms" {
  source = "../kms"

  project_id  = var.project_id
  region      = var.region
  name_prefix = local.name_prefix

  keys = {
    sql       = ["serviceAccount:${module.project.service_agents.sql}"]
    storage   = ["serviceAccount:${module.project.service_agents.storage}"]
    secrets   = ["serviceAccount:${module.project.service_agents.secrets}"]
    artifacts = ["serviceAccount:${module.project.service_agents.artifacts}"]
    logs      = ["serviceAccount:${module.project.service_agents.logs}"]
  }
}

module "network" {
  source = "../network"

  project_id  = var.project_id
  region      = var.region
  name_prefix = local.name_prefix
  subnet_cidr = var.subnet_cidr
}

# ---------------------------------------------------------------------------------------------
# Container images
# ---------------------------------------------------------------------------------------------

module "registry" {
  source = "../artifact_registry"

  project_id    = var.project_id
  region        = var.region
  repository_id = "harbour"
  kms_key_id    = module.kms.key_ids["artifacts"]

  depends_on = [module.kms]
}

locals {
  repo = module.registry.repository_url

  images = {
    api       = "${local.repo}/api:${var.initial_image_tag}"
    web       = "${local.repo}/web:${var.initial_image_tag}"
    powersync = "${local.repo}/powersync-service:${var.powersync_version}"
    flagsmith = "${local.repo}/flagsmith:${var.flagsmith_version}"
    clamav    = coalesce(var.clamav_image, "${local.repo}/clamav:${var.clamav_version}")
  }
}
