# A custom-mode VPC in London: one subnet for Cloud Run Direct VPC egress (private Google access
# on, flow logs on) and a private services range peered for Cloud SQL, which has no public IP.
# No firewall rule admits traffic from the internet (the VPC's implied rule denies all ingress):
# requests reach Cloud Run only through the external load balancer.

resource "google_compute_network" "this" {
  project                         = var.project_id
  name                            = var.name_prefix
  auto_create_subnetworks         = false
  routing_mode                    = "REGIONAL"
  delete_default_routes_on_create = false
}

resource "google_compute_subnetwork" "run" {
  project                  = var.project_id
  name                     = "${var.name_prefix}-run"
  region                   = var.region
  network                  = google_compute_network.this.id
  ip_cidr_range            = var.subnet_cidr
  private_ip_google_access = true

  log_config {
    aggregation_interval = "INTERVAL_5_MIN"
    flow_sampling        = 0.5
    metadata             = "INCLUDE_ALL_METADATA"
  }
}

# Private services access: Cloud SQL gets addresses from this range on the VPC only.
resource "google_compute_global_address" "private_services" {
  project       = var.project_id
  name          = "${var.name_prefix}-private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = var.private_services_prefix_length
  network       = google_compute_network.this.id
}

resource "google_service_networking_connection" "private_services" {
  network                 = google_compute_network.this.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services.name]
}

resource "google_compute_router" "this" {
  count = var.enable_nat ? 1 : 0

  project = var.project_id
  name    = var.name_prefix
  region  = var.region
  network = google_compute_network.this.id
}

resource "google_compute_router_nat" "this" {
  count = var.enable_nat ? 1 : 0

  project                            = var.project_id
  name                               = var.name_prefix
  router                             = google_compute_router.this[0].name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}
