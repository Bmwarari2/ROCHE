variable "name" {
  description = "Name used in comments and the response headers policy."
  type        = string
}

variable "aliases" {
  description = "Hostnames served by the distribution, for example [\"app.dev.harbour.example\"]."
  type        = list(string)
}

variable "certificate_arn" {
  description = "ACM certificate ARN in us-east-1 covering the aliases (CloudFront only reads certificates from us-east-1)."
  type        = string
}

variable "origin_domain_name" {
  description = "DNS name of the ALB origin. The Host header is forwarded, so the ALB certificate must cover the aliases."
  type        = string
}

variable "origin_verify_header_name" {
  description = "Name of the secret header CloudFront adds so the ALB only accepts web traffic that came through CloudFront."
  type        = string
  default     = "X-Harbour-Origin-Verify"
}

variable "origin_verify_header_value" {
  description = "Secret value of the origin-verify header."
  type        = string
  sensitive   = true
}

variable "web_acl_arn" {
  description = "CLOUDFRONT-scope WAF web ACL ARN (created in us-east-1)."
  type        = string
}

variable "price_class" {
  description = "Edge locations used. PriceClass_100 limits edges to Europe and North America."
  type        = string
  default     = "PriceClass_100"
}

variable "static_path_patterns" {
  description = "Path patterns for immutable, non-personal static assets that may be cached at the edge."
  type        = list(string)
  default     = ["/_next/static/*", "/static/*", "/favicon.ico"]
}

variable "frame_options_deny" {
  description = "Send X-Frame-Options DENY on every response. False only for the e-learning content host, whose runtime page the app frames (ADR-0093); its own Content-Security-Policy frame-ancestors decides who may frame it."
  type        = bool
  default     = true
}

variable "referrer_policy" {
  description = "Referrer-Policy sent on every response."
  type        = string
  default     = "strict-origin-when-cross-origin"
}

variable "permissions_policy" {
  description = "Permissions-Policy sent on every response."
  type        = string
  default     = "camera=(self), microphone=(self), geolocation=(), payment=()"
}
