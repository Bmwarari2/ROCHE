locals {
  default_tags = merge(var.extra_tags, {
    Project            = "harbour"
    Environment        = var.environment
    Owner              = "thapsus"
    DataClassification = var.data_classification
    ManagedBy          = "terraform"
  })
}

# Everything that holds or processes personal data is created through this provider, which is
# pinned to London and refuses to run against any account except the one named.
provider "aws" {
  region              = var.region
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = local.default_tags
  }
}

# us-east-1 is used only for what CloudFront requires to live there: its ACM certificate and
# its CLOUDFRONT-scope WAF web ACL. Neither stores personal data.
provider "aws" {
  alias               = "us_east_1"
  region              = "us-east-1"
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = local.default_tags
  }
}
