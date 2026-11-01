locals {
  labels = merge(var.extra_labels, {
    project             = "harbour"
    environment         = var.environment
    owner               = "thapsus"
    data_classification = var.data_classification
    managed_by          = "terraform"
  })
}

# Everything is created in this project and region; the gcp.resourceLocations organisation
# policy (project_baseline) refuses any other location.
provider "google" {
  project               = var.project_id
  region                = var.region
  default_labels        = local.labels
  user_project_override = true
  billing_project       = var.project_id
}

provider "google-beta" {
  project               = var.project_id
  region                = var.region
  default_labels        = local.labels
  user_project_override = true
  billing_project       = var.project_id
}
