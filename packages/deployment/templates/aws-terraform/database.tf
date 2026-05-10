resource "aws_db_subnet_group" "grepmind" {
  name       = "${local.name_prefix}-database"
  subnet_ids = aws_subnet.private[*].id

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-database"
  })
}

resource "aws_db_instance" "grepmind" {
  identifier                  = "${local.name_prefix}-database"
  engine                      = "postgres"
  engine_version              = "16"
  instance_class              = var.database_instance_class
  allocated_storage           = var.database_allocated_storage_gb
  storage_encrypted           = true
  db_name                     = var.database_name
  username                    = var.database_username
  password                    = var.database_password
  port                        = local.database_port
  db_subnet_group_name        = aws_db_subnet_group.grepmind.name
  vpc_security_group_ids      = [aws_security_group.database.id]
  publicly_accessible         = false
  backup_retention_period     = 7
  deletion_protection         = var.database_deletion_protection
  skip_final_snapshot         = false
  final_snapshot_identifier   = "${local.name_prefix}-database-final"
  auto_minor_version_upgrade  = true
  apply_immediately           = true
  multi_az                    = false
  performance_insights_enabled = false

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-database"
  })
}
