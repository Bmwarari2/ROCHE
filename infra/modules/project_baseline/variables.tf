variable "project_id" {
  description = "The Google Cloud project for one environment."
  type        = string
}

variable "region" {
  description = "The only region resources may be created in."
  type        = string
  default     = "europe-west2"

  validation {
    condition     = var.region == "europe-west2"
    error_message = "Harbour runs in europe-west2 (London) only: personal data may not leave the UK."
  }
}

variable "services" {
  description = "APIs to enable on the project."
  type        = set(string)
  default = [
    "artifactregistry.googleapis.com",
    "billingbudgets.googleapis.com",
    "certificatemanager.googleapis.com",
    "cloudkms.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "compute.googleapis.com",
    # Artifact Registry scans every image it receives for known vulnerabilities (H-1170).
    "containerscanning.googleapis.com",
    "dns.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "orgpolicy.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "servicenetworking.googleapis.com",
    "sqladmin.googleapis.com",
    "storage.googleapis.com",
    "sts.googleapis.com",
    "vpcaccess.googleapis.com",
  ]
}
