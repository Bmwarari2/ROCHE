output "network_id" {
  value = google_compute_network.this.id
}

output "network_self_link" {
  value = google_compute_network.this.self_link
}

output "subnet_id" {
  value = google_compute_subnetwork.run.id
}

output "subnet_region" {
  value = google_compute_subnetwork.run.region
}

output "subnet_cidr" {
  value = google_compute_subnetwork.run.ip_cidr_range
}

output "private_services_connection" {
  description = "Depend on this before creating a Cloud SQL instance with a private IP."
  value       = google_service_networking_connection.private_services.id
}
