resource "aws_secretsmanager_secret" "clerk_secret_key" {
  name = "/${var.project_name}/clerk-secret-key"

  tags = local.common_tags
}

resource "aws_secretsmanager_secret_version" "clerk_secret_key" {
  secret_id     = aws_secretsmanager_secret.clerk_secret_key.id
  secret_string = var.clerk_secret_key
}

resource "aws_secretsmanager_secret" "voyage_api_key" {
  name = "/${var.project_name}/voyage-api-key"

  tags = local.common_tags
}

resource "aws_secretsmanager_secret_version" "voyage_api_key" {
  secret_id     = aws_secretsmanager_secret.voyage_api_key.id
  secret_string = var.voyage_api_key
}

resource "aws_secretsmanager_secret" "database_url" {
  name = "/${var.project_name}/database-url"

  tags = local.common_tags
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id = aws_secretsmanager_secret.database_url.id
  secret_string = "postgresql://${var.database_username}:${urlencode(var.database_password)}@${aws_db_instance.grepmind.address}:${local.database_port}/${var.database_name}"
}
