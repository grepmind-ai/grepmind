resource "aws_lb" "grepmind" {
  name               = "${local.name_prefix}-alb"
  load_balancer_type = "application"
  internal           = false
  ip_address_type    = "ipv4"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-alb"
  })
}

resource "aws_lb_target_group" "grepmind" {
  name                 = "${local.name_prefix}-app"
  port                 = local.app_port
  protocol             = "HTTP"
  target_type          = "instance"
  vpc_id               = aws_vpc.grepmind.id
  deregistration_delay = 30

  health_check {
    enabled             = true
    path                = "/api/health"
    matcher             = "200"
    protocol            = "HTTP"
    port                = "traffic-port"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 5
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-app"
  })
}

resource "aws_lb_target_group_attachment" "grepmind" {
  target_group_arn = aws_lb_target_group.grepmind.arn
  target_id        = aws_instance.grepmind.id
  port             = local.app_port
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.grepmind.arn
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

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.grepmind.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.grepmind.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.grepmind.arn
  }
}
