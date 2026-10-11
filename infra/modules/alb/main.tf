# Internet-facing Application Load Balancer: HTTPS only (HTTP is redirected), TLS 1.2 or 1.3,
# invalid headers dropped, access logs to S3 and a regional WAF in front.

resource "aws_security_group" "this" {
  name        = "${var.name}-alb"
  description = "Public HTTPS to the ${var.name} load balancer"
  vpc_id      = var.vpc_id

  tags = { Name = "${var.name}-alb" }
}

# The API, PowerSync and the CloudFront origin are reached over the public internet by design
# (mobile devices, browsers and CloudFront edges), so ingress is open on 443. Port 80 exists
# only to send a permanent redirect to HTTPS. WAF filters requests before they reach targets.
#trivy:ignore:AVD-AWS-0107
resource "aws_vpc_security_group_ingress_rule" "https" {
  security_group_id = aws_security_group.this.id
  description       = "HTTPS from the internet"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

#trivy:ignore:AVD-AWS-0107
resource "aws_vpc_security_group_ingress_rule" "http_redirect" {
  #checkov:skip=CKV_AWS_260:Port 80 only answers with a permanent redirect to HTTPS (aws_lb_listener.http).
  security_group_id = aws_security_group.this.id
  description       = "HTTP from the internet, redirected to HTTPS"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "targets" {
  for_each = { for p in var.target_ports : tostring(p) => p }

  security_group_id = aws_security_group.this.id
  description       = "Forward to targets on ${each.key}"
  ip_protocol       = "tcp"
  from_port         = each.value
  to_port           = each.value
  cidr_ipv4         = var.vpc_cidr_block
}

# An internet-facing load balancer is the intended design for the API and sync endpoints.
#trivy:ignore:AVD-AWS-0053
resource "aws_lb" "this" {
  #checkov:skip=CKV2_AWS_76:The associated web ACL (modules/waf) runs AWSManagedRulesKnownBadInputsRuleSet, which includes Log4JRCE; the scanner cannot follow the association across modules.
  name               = var.name
  load_balancer_type = "application"
  internal           = false
  security_groups    = [aws_security_group.this.id]
  subnets            = var.public_subnet_ids

  drop_invalid_header_fields = true
  desync_mitigation_mode     = "strictest"
  enable_http2               = true
  idle_timeout               = var.idle_timeout
  enable_deletion_protection = var.deletion_protection
  xff_header_processing_mode = "append"

  access_logs {
    bucket  = var.access_log_bucket
    prefix  = "alb"
    enabled = true
  }

  tags = { Name = var.name }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = var.ssl_policy
  certificate_arn   = var.certificate_arn

  routing_http_response_strict_transport_security_header_value = "max-age=63072000; includeSubDomains; preload"
  routing_http_response_x_content_type_options_header_value    = "nosniff"
  routing_http_response_x_frame_options_header_value           = "DENY"
  routing_http_response_server_enabled                         = false

  # Anything that matches no host rule gets a plain 404.
  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      message_body = "Not found"
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener_certificate" "additional" {
  for_each = var.additional_certificate_arns

  listener_arn    = aws_lb_listener.https.arn
  certificate_arn = each.value
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_wafv2_web_acl_association" "this" {
  count = var.enable_waf ? 1 : 0

  resource_arn = aws_lb.this.arn
  web_acl_arn  = var.web_acl_arn
}
