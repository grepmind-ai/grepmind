output "public_url" {
  value = var.public_base_url
}

output "alb_dns_name" {
  value = aws_lb.grepmind.dns_name
}

output "healthcheck_url" {
  value = "${var.public_base_url}/api/health"
}

output "s3_bucket_name" {
  value = aws_s3_bucket.artifacts.bucket
}

output "database_endpoint" {
  value = aws_db_instance.grepmind.address
}

output "ec2_instance_id" {
  value = aws_instance.grepmind.id
}

output "app_security_group_id" {
  value = aws_security_group.app.id
}

output "alb_security_group_id" {
  value = aws_security_group.alb.id
}

output "clerk_secret_arn" {
  value     = aws_secretsmanager_secret.clerk_secret_key.arn
  sensitive = true
}

output "voyage_api_key_secret_arn" {
  value     = aws_secretsmanager_secret.voyage_api_key.arn
  sensitive = true
}

output "database_url_secret_arn" {
  value     = aws_secretsmanager_secret.database_url.arn
  sensitive = true
}
