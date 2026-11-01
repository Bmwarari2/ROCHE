terraform {
  required_version = ">= 1.10.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 8.8, < 9.0"
    }

    google-beta = {
      source  = "hashicorp/google-beta"
      version = ">= 8.8, < 9.0"
    }
  }
}
