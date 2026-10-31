# Plans the whole stack against mocked providers, so CI can catch count and for_each values
# that are unknown until apply, broken cross-module references, wrong conditional wiring and
# the residency and safety rules below, without any Google Cloud credentials. Run from this
# directory:
#   terraform init -backend=false && terraform test

mock_provider "google" {
  mock_data "google_project" {
    defaults = { number = "000000000000" }
  }
}

mock_provider "google-beta" {}

variables {
  project_id           = "harbour-dev-test"
  environment          = "dev"
  domain_name          = "dev.harbour.example.invalid"
  safety_case_version  = "v0.0"
  state_bucket_name    = "harbour-tfstate-dev-test"
  budget_monthly_limit = 600
}

run "dev_defaults" {
  command = plan

  assert {
    condition     = length(module.svc_flagsmith) == 0
    error_message = "Flagsmith must be off by default."
  }

  assert {
    condition     = output.manual_dns_records != null
    error_message = "Without a Cloud DNS zone the stack must list the DNS records to create by hand."
  }

  # The worker logs JSON (pino), so its alerts match the structured `event` field
  # (ADR-0071 review round 5, C5-M1; docs/runbooks/on-call.md).
  assert {
    condition     = strcontains(module.observability.log_metric_filters.escalation_unrouted_daily, "jsonPayload.event=\"escalation.unrouted.daily\"")
    error_message = "The unrouted escalation alert must match the worker's escalation.unrouted.daily event."
  }

  assert {
    condition     = strcontains(module.observability.log_metric_filters.worker_job_failed, "jsonPayload.event=\"worker.job.failed\"")
    error_message = "The failed job alert must match the worker's worker.job.failed event."
  }

  assert {
    condition     = strcontains(module.observability.log_metric_filters.export_foreign_rows, "jsonPayload.event=\"security.export.foreign_rows\"")
    error_message = "The export foreign rows alert must match the worker's security.export.foreign_rows event (HZ-070)."
  }

  # Each metric reads the worker's own logs.
  assert {
    condition = alltrue([
      for f in values(module.observability.log_metric_filters) :
      strcontains(f, "resource.labels.service_name=\"harbour-dev-worker\"")
    ])
    error_message = "Each worker log metric must read the worker service's logs."
  }

  # Any unrouted line alerts, over an hour so each daily run notifies again; one or more failed
  # jobs in 15 minutes alert by default.
  assert {
    condition = (
      module.observability.log_alert_rules.escalation_unrouted_daily.aligner == "ALIGN_SUM" &&
      module.observability.log_alert_rules.escalation_unrouted_daily.period == 3600 &&
      module.observability.log_alert_rules.escalation_unrouted_daily.threshold == 0 &&
      module.observability.log_alert_rules.escalation_unrouted_daily.comparison == "COMPARISON_GT"
    )
    error_message = "The unrouted escalation alert must fire on any escalation.unrouted.daily line, over an hour so each daily run notifies again (HZ-073)."
  }

  assert {
    condition = (
      module.observability.log_alert_rules.worker_job_failed.aligner == "ALIGN_SUM" &&
      module.observability.log_alert_rules.worker_job_failed.period == 900 &&
      module.observability.log_alert_rules.worker_job_failed.threshold == 0 &&
      module.observability.log_alert_rules.worker_job_failed.comparison == "COMPARISON_GT"
    )
    error_message = "The failed job alert must fire on one or more worker.job.failed lines in 15 minutes."
  }

  # Security logs are kept at least 400 days, and not locked outside prod.
  assert {
    condition     = module.observability.security_log_bucket.retention_days >= 400 && !module.observability.security_log_bucket.locked
    error_message = "Security logs must be kept 400 days or more, unlocked outside prod."
  }

  assert {
    condition     = strcontains(module.observability.security_sink_filter, "cloudaudit.googleapis.com")
    error_message = "The security log bucket must receive the audit logs."
  }
}

# Every resource that stores or processes data is in europe-west2.
run "everything_in_london" {
  command = plan

  assert {
    condition = alltrue([
      module.db_main.region == "europe-west2",
      module.db_sync_storage.region == "europe-west2",
      module.db_main.backup_location == "europe-west2",
      module.db_sync_storage.backup_location == "europe-west2",
      module.kms.key_ring_location == "europe-west2",
      module.registry.location == "europe-west2",
      module.network.subnet_region == "europe-west2",
      module.observability.security_log_bucket.location == "europe-west2",
      module.svc_api.location == "europe-west2",
      module.svc_worker.location == "europe-west2",
      module.svc_web.location == "europe-west2",
      module.svc_powersync.location == "europe-west2",
      module.job_migrate.location == "europe-west2",
    ])
    error_message = "Databases, backups, keys, images, the network, logs and services must all be in europe-west2."
  }

  assert {
    condition = alltrue([
      for b in [module.bucket_documents, module.bucket_exports, module.bucket_audit_archive, module.bucket_logs] :
      b.location == "EUROPE-WEST2"
    ])
    error_message = "Every bucket must be in europe-west2 (never a multi-region)."
  }

  assert {
    condition     = alltrue([for l in values(module.secrets.locations) : l == "europe-west2"])
    error_message = "Every secret must be a regional secret in europe-west2."
  }

  assert {
    condition     = jsonencode(module.project.allowed_locations) == jsonencode(["in:europe-west2-locations"])
    error_message = "The gcp.resourceLocations policy must allow europe-west2 locations only."
  }

  assert {
    condition     = contains(module.project.audit_log_types, "DATA_READ") && contains(module.project.audit_log_types, "DATA_WRITE")
    error_message = "Data Access audit logs must be on for every service."
  }
}

# Keys rotate at least every 90 days.
run "keys_rotate" {
  command = plan

  assert {
    condition     = alltrue([for p in values(module.kms.rotation_periods) : tonumber(trimsuffix(p, "s")) <= 7776000])
    error_message = "Every key must rotate at least every 90 days."
  }
}

run "another_region_is_refused" {
  command = plan

  variables {
    region = "europe-west1"
  }

  expect_failures = [var.region]
}

# A bucket is never public, and the database is never on a public IP.
run "nothing_public" {
  command = plan

  assert {
    condition = alltrue([
      for b in [module.bucket_documents, module.bucket_exports, module.bucket_audit_archive, module.bucket_logs] :
      b.public_access_prevention == "enforced" && b.uniform_bucket_level_access
    ])
    error_message = "Every bucket must enforce public access prevention and uniform bucket-level access."
  }

  assert {
    condition     = !module.db_main.public_ip_enabled && !module.db_sync_storage.public_ip_enabled
    error_message = "Cloud SQL must have a private IP only."
  }

  assert {
    condition = alltrue([
      module.svc_api.ingress == "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
      module.svc_web.ingress == "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
      module.svc_powersync.ingress == "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
      module.svc_worker.ingress == "INGRESS_TRAFFIC_INTERNAL_ONLY",
    ])
    error_message = "Services are reached only through the load balancer; the worker not at all."
  }

  assert {
    condition     = jsonencode(module.load_balancer.cdn_backends) == jsonencode(["app"])
    error_message = "Cloud CDN must be on for the web tier only (static files), never for the API or sync."
  }

  assert {
    condition     = module.load_balancer.min_tls_version == "TLS_1_2"
    error_message = "The load balancer must refuse TLS below 1.2."
  }

  assert {
    condition     = strcontains(module.github_wif.attribute_condition, "assertion.repository == \"Bmwarari2/ROCHE\"")
    error_message = "Workload Identity Federation must accept this repository's tokens only."
  }

  assert {
    condition = (
      module.github_wif.subjects.plan == "repo:Bmwarari2/ROCHE:pull_request" &&
      module.github_wif.subjects.deploy == "repo:Bmwarari2/ROCHE:ref:refs/heads/main"
    )
    error_message = "Pull requests may impersonate the plan account only; main the deploy account only."
  }
}

run "services_and_database" {
  command = plan

  assert {
    condition     = jsonencode(module.svc_api.sidecar_names) == jsonencode(["clamav"])
    error_message = "ClamAV must run beside the API (127.0.0.1:3310)."
  }

  assert {
    condition     = module.svc_powersync.min_instances >= 1
    error_message = "PowerSync must always run at least one instance."
  }

  assert {
    condition = (
      module.db_main.flags["cloudsql.enable_pgaudit"] == "on" &&
      module.db_main.flags["cloudsql.logical_decoding"] == "on" &&
      module.db_sync_storage.flags["cloudsql.enable_pgaudit"] == "on"
    )
    error_message = "pgAudit must be on for both databases and logical decoding on the main one."
  }

  assert {
    condition     = module.db_main.availability_type == "REGIONAL"
    error_message = "The main database must be regional (high availability) by default."
  }

  # Each service may read only its own secrets: the web tier none, PowerSync no API secrets.
  assert {
    condition     = length(module.svc_web.secret_ids) == 0
    error_message = "The web tier must read no secrets."
  }

  assert {
    condition     = !anytrue([for s in module.svc_powersync.secret_ids : strcontains(s, "api-auth-secret")])
    error_message = "PowerSync must not read the API's secrets."
  }
}

run "flagsmith_and_cloud_dns" {
  command = plan

  variables {
    enable_flagsmith = true
    dns_zone_name    = "harbour-dev"
    create_dns_zone  = true
  }

  assert {
    condition     = length(module.svc_flagsmith) == 1
    error_message = "Flagsmith should be created when enabled."
  }

  assert {
    condition     = jsonencode(module.dns.managed_record_keys) == jsonencode(["api", "app", "cert", "flags", "sync"])
    error_message = "app, api, sync and flags should point at the load balancer, with the certificate's authorisation record."
  }

  assert {
    condition     = output.manual_dns_records == null
    error_message = "With a Cloud DNS zone nothing should be left to create by hand."
  }
}

# The audit archive's lock is irreversible: off in dev and staging, on in prod.
run "audit_lock_not_outside_prod" {
  command = plan

  assert {
    condition     = !module.bucket_audit_archive.retention_locked
    error_message = "The audit archive must not be locked outside prod."
  }
}

run "audit_lock_refused_outside_prod" {
  command = plan

  variables {
    lock_audit_archive = true
  }

  expect_failures = [terraform_data.locks_only_in_prod]
}

run "prod_needs_armor_pins" {
  command = plan

  variables {
    environment = "prod"
  }

  expect_failures = [terraform_data.armor_version_pins]
}

run "prod_still_needs_every_pin" {
  command = plan

  variables {
    environment = "prod"

    armor_rule_versions = {
      sqli = "v33-stable"
      xss  = "v33-stable"
    }
  }

  expect_failures = [terraform_data.armor_version_pins]
}

run "prod_like" {
  command = plan

  variables {
    environment = "prod"

    # Test values only: the real pins are read in the prod project (human action H-140).
    armor_rule_versions = {
      sqli              = "v33-stable"
      xss               = "v33-stable"
      lfi               = "v33-stable"
      rfi               = "v33-stable"
      rce               = "v33-stable"
      methodenforcement = "v33-stable"
      scannerdetection  = "v33-stable"
      protocolattack    = "v33-stable"
      sessionfixation   = "v33-stable"
    }
  }

  assert {
    condition     = module.bucket_audit_archive.retention_locked
    error_message = "The audit archive must be locked (365 days) in prod."
  }

  assert {
    condition     = module.observability.security_log_bucket.locked
    error_message = "Security logs must be locked in prod."
  }

  assert {
    condition     = alltrue([for e in values(module.load_balancer.armor_expressions) : strcontains(e, "-v33-stable'")])
    error_message = "Every Cloud Armor rule must use its pinned version."
  }
}
