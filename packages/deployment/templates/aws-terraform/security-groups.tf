resource "aws_security_group" "alb" {
  name        = "${local.name_prefix}-alb"
  description = "Public ALB ingress for Grepmind"
  vpc_id      = aws_vpc.grepmind.id

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-alb"
  })
}

resource "aws_security_group_rule" "alb_http_ingress" {
  type              = "ingress"
  security_group_id = aws_security_group.alb.id
  protocol          = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_blocks       = ["0.0.0.0/0"]
}

resource "aws_security_group_rule" "alb_https_ingress" {
  type              = "ingress"
  security_group_id = aws_security_group.alb.id
  protocol          = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_blocks       = ["0.0.0.0/0"]
}

resource "aws_security_group_rule" "alb_to_app" {
  type                     = "egress"
  security_group_id        = aws_security_group.alb.id
  protocol                 = "tcp"
  from_port                = local.app_port
  to_port                  = local.app_port
  source_security_group_id = aws_security_group.app.id
}

resource "aws_security_group" "app" {
  name        = "${local.name_prefix}-app"
  description = "Grepmind app runtime"
  vpc_id      = aws_vpc.grepmind.id

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-app"
  })
}

resource "aws_security_group_rule" "app_from_alb" {
  type                     = "ingress"
  security_group_id        = aws_security_group.app.id
  protocol                 = "tcp"
  from_port                = local.app_port
  to_port                  = local.app_port
  source_security_group_id = aws_security_group.alb.id
}

resource "aws_security_group_rule" "app_ssh" {
  count             = length(var.ssh_allowed_cidr_blocks)
  type              = "ingress"
  security_group_id = aws_security_group.app.id
  protocol          = "tcp"
  from_port         = 22
  to_port           = 22
  cidr_blocks       = [var.ssh_allowed_cidr_blocks[count.index]]
}

resource "aws_security_group_rule" "app_https_egress" {
  type              = "egress"
  security_group_id = aws_security_group.app.id
  protocol          = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_blocks       = ["0.0.0.0/0"]
}

resource "aws_security_group_rule" "app_to_database" {
  type                     = "egress"
  security_group_id        = aws_security_group.app.id
  protocol                 = "tcp"
  from_port                = local.database_port
  to_port                  = local.database_port
  source_security_group_id = aws_security_group.database.id
}

resource "aws_security_group" "database" {
  name        = "${local.name_prefix}-database"
  description = "Grepmind RDS PostgreSQL"
  vpc_id      = aws_vpc.grepmind.id

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-database"
  })
}

resource "aws_security_group_rule" "database_from_app" {
  type                     = "ingress"
  security_group_id        = aws_security_group.database.id
  protocol                 = "tcp"
  from_port                = local.database_port
  to_port                  = local.database_port
  source_security_group_id = aws_security_group.app.id
}
