resource "aws_route53_record" "grepmind" {
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_lb.grepmind.dns_name
    zone_id                = aws_lb.grepmind.zone_id
    evaluate_target_health = true
  }
}
