# CloudFront in front of the Next.js web tier. The origin is the ALB over HTTPS (TLS 1.2).
#
# Residency: CloudFront terminates TLS at edge locations, some outside the UK. Pages can
# contain personal data, so dynamic responses use the managed CachingDisabled policy and are
# never stored at the edge; only immutable static assets (JavaScript, CSS, fonts, icons),
# which carry no personal data, are cached. No access logs are written from the edge.

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_cache_policy" "optimised" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewer"
}

resource "aws_cloudfront_response_headers_policy" "this" {
  name    = "${var.name}-security-headers"
  comment = "Security headers for ${var.name}"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }

    content_type_options {
      override = true
    }

    dynamic "frame_options" {
      for_each = var.frame_options_deny ? [1] : []
      content {
        frame_option = "DENY"
        override     = true
      }
    }

    referrer_policy {
      referrer_policy = var.referrer_policy
      override        = true
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = var.permissions_policy
      override = true
    }
  }
}

# Edge access logging is intentionally off: standard logs are delivered from us-east-1 and
# would hold client IP addresses (personal data) outside the UK. Requests that reach the
# origin are logged by the ALB in eu-west-2.
#trivy:ignore:AVD-AWS-0010
resource "aws_cloudfront_distribution" "this" {
  #checkov:skip=CKV2_AWS_47:The web ACL (modules/waf, CLOUDFRONT scope) runs AWSManagedRulesKnownBadInputsRuleSet, which includes Log4JRCE; the scanner cannot follow the ARN across modules.
  #checkov:skip=CKV_AWS_86:Edge logs would be delivered from us-east-1 and hold client IP addresses outside the UK; the ALB logs requests in eu-west-2.
  #checkov:skip=CKV_AWS_305:The origin is a Next.js server that routes / itself; a default root object applies to S3 origins.
  #checkov:skip=CKV_AWS_310:There is a single origin in a single region by design (personal data stays in London); resilience is Multi-AZ behind the ALB.
  #checkov:skip=CKV_AWS_374:Families and professionals may sign in from abroad; access control is authentication plus WAF rate and reputation rules, not geography.
  enabled         = true
  comment         = var.name
  aliases         = var.aliases
  price_class     = var.price_class
  http_version    = "http2and3"
  is_ipv6_enabled = true
  web_acl_id      = var.web_acl_arn

  origin {
    origin_id   = "alb"
    domain_name = var.origin_domain_name

    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "https-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60
      origin_keepalive_timeout = 5
    }

    custom_header {
      name  = var.origin_verify_header_name
      value = var.origin_verify_header_value
    }
  }

  default_cache_behavior {
    target_origin_id           = "alb"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.this.id
  }

  dynamic "ordered_cache_behavior" {
    for_each = var.static_path_patterns

    content {
      path_pattern               = ordered_cache_behavior.value
      target_origin_id           = "alb"
      viewer_protocol_policy     = "redirect-to-https"
      allowed_methods            = ["GET", "HEAD"]
      cached_methods             = ["GET", "HEAD"]
      compress                   = true
      cache_policy_id            = data.aws_cloudfront_cache_policy.optimised.id
      origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer.id
      response_headers_policy_id = aws_cloudfront_response_headers_policy.this.id
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}
