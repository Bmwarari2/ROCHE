# One Cloud Run service (or job) with its own service account. Secrets come from Secret Manager
# as environment variables or files; sidecars share the main container's network namespace, so
# ClamAV beside the API answers on 127.0.0.1:3310. Direct VPC egress sends private ranges (Cloud
# SQL) through the VPC. The deploy workflow changes the image after the first apply, so Terraform
# ignores it from then on and an infrastructure change can never roll an application back.

resource "google_service_account" "this" {
  project      = var.project_id
  account_id   = substr(replace(var.name, "/[^a-z0-9-]/", "-"), 0, 30)
  display_name = "Cloud Run ${var.name}"
}

resource "google_project_iam_member" "roles" {
  for_each = var.project_roles

  project = var.project_id
  role    = each.key
  member  = "serviceAccount:${google_service_account.this.email}"
}

locals {
  # Secret ids are built from known names by the caller, so the plan can count these grants.
  secret_ids = toset(concat(values(var.secret_env), [for v in values(var.secret_volumes) : v.secret]))
}

# Each service may read only its own secrets.
resource "google_secret_manager_regional_secret_iam_member" "access" {
  for_each = local.secret_ids

  project   = var.project_id
  location  = var.region
  secret_id = each.key
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.this.email}"
}

resource "google_cloud_run_v2_service" "this" {
  count = var.kind == "service" ? 1 : 0

  project              = var.project_id
  name                 = var.name
  location             = var.region
  ingress              = var.ingress
  invoker_iam_disabled = var.behind_load_balancer
  deletion_protection  = var.deletion_protection
  labels               = var.labels

  template {
    service_account                  = google_service_account.this.email
    timeout                          = "${var.timeout_seconds}s"
    max_instance_request_concurrency = 80
    labels                           = var.labels

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"

      network_interfaces {
        network    = var.network_id
        subnetwork = var.subnet_id
      }
    }

    containers {
      name    = "main"
      image   = var.image
      command = var.command
      args    = var.args

      ports {
        container_port = var.port
      }

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
        cpu_idle          = !var.cpu_always_allocated
        startup_cpu_boost = true
      }

      dynamic "env" {
        for_each = var.env

        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.secret_env

        content {
          name = env.key

          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      dynamic "volume_mounts" {
        for_each = var.secret_volumes

        content {
          name       = volume_mounts.key
          mount_path = volume_mounts.value.mount_path
        }
      }

      dynamic "startup_probe" {
        for_each = var.health_path == null ? [] : [var.health_path]

        content {
          initial_delay_seconds = 0
          period_seconds        = 5
          failure_threshold     = 24
          timeout_seconds       = 3

          http_get {
            path = startup_probe.value
          }
        }
      }

      dynamic "liveness_probe" {
        for_each = var.health_path == null ? [] : [var.health_path]

        content {
          period_seconds    = 30
          failure_threshold = 3
          timeout_seconds   = 5

          http_get {
            path = liveness_probe.value
          }
        }
      }

      depends_on = [for s in var.sidecars : s.name]
    }

    dynamic "containers" {
      for_each = var.sidecars

      content {
        name    = containers.value.name
        image   = containers.value.image
        command = containers.value.command
        args    = containers.value.args

        resources {
          limits = {
            cpu    = containers.value.cpu
            memory = containers.value.memory
          }
          cpu_idle = !var.cpu_always_allocated
        }

        dynamic "env" {
          for_each = containers.value.env

          content {
            name  = env.key
            value = env.value
          }
        }

        dynamic "startup_probe" {
          for_each = containers.value.probe_port == null ? [] : [containers.value.probe_port]

          content {
            period_seconds    = 10
            failure_threshold = 30
            timeout_seconds   = 5

            tcp_socket {
              port = startup_probe.value
            }
          }
        }
      }
    }

    dynamic "volumes" {
      for_each = var.secret_volumes

      content {
        name = volumes.key

        secret {
          secret = volumes.value.secret

          items {
            version = "latest"
            path    = volumes.value.file
            mode    = 256
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].containers[0].image, client, client_version]
  }

  depends_on = [google_secret_manager_regional_secret_iam_member.access]
}

resource "google_cloud_run_v2_job" "this" {
  count = var.kind == "job" ? 1 : 0

  project             = var.project_id
  name                = var.name
  location            = var.region
  deletion_protection = var.deletion_protection
  labels              = var.labels

  template {
    task_count = 1

    template {
      service_account = google_service_account.this.email
      timeout         = "${var.timeout_seconds}s"
      max_retries     = 0

      vpc_access {
        egress = "PRIVATE_RANGES_ONLY"

        network_interfaces {
          network    = var.network_id
          subnetwork = var.subnet_id
        }
      }

      containers {
        name    = "main"
        image   = var.image
        command = var.command
        args    = var.args

        resources {
          limits = {
            cpu    = var.cpu
            memory = var.memory
          }
        }

        dynamic "env" {
          for_each = var.env

          content {
            name  = env.key
            value = env.value
          }
        }

        dynamic "env" {
          for_each = var.secret_env

          content {
            name = env.key

            value_source {
              secret_key_ref {
                secret  = env.value
                version = "latest"
              }
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image, client, client_version]
  }

  depends_on = [google_secret_manager_regional_secret_iam_member.access]
}
