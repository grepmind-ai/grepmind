data "aws_ssm_parameter" "al2023_x86_64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_instance" "grepmind" {
  ami                         = data.aws_ssm_parameter.al2023_x86_64.value
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.private[0].id
  vpc_security_group_ids      = [aws_security_group.app.id]
  iam_instance_profile        = aws_iam_instance_profile.app.name
  associate_public_ip_address = false

  user_data_replace_on_change = true
  user_data = templatefile("${path.module}/templates/user-data.sh.tftpl", {
    aws_region                  = var.aws_region
    grepmind_config             = templatefile("${path.module}/templates/config.yml.tftpl", {
      public_base_url           = var.public_base_url
      server_instance_id        = var.server_instance_id
      clerk_frontend_api_url    = var.clerk_frontend_api_url
      clerk_cli_oauth_client_id = var.clerk_cli_oauth_client_id
      clerk_publishable_key     = var.clerk_publishable_key
      database_endpoint         = aws_db_instance.grepmind.address
      database_name             = var.database_name
      database_username         = var.database_username
      aws_region                = var.aws_region
      s3_bucket_name            = aws_s3_bucket.artifacts.bucket
      s3_prefix                 = local.s3_prefix_normalized
    })
    grepmind_service            = templatefile("${path.module}/templates/grepmind.service.tftpl", {})
    grepmind_env_writer         = templatefile("${path.module}/templates/grepmind.env.tftpl", {})
    update_script               = templatefile("${path.module}/templates/update-grepmind-images.sh.tftpl", {
      aws_region             = var.aws_region
      grepmind_image         = var.grepmind_image
      grepmind_tag           = var.grepmind_tag
      clerk_secret_arn       = aws_secretsmanager_secret.clerk_secret_key.arn
      voyage_api_key_arn     = aws_secretsmanager_secret.voyage_api_key.arn
      database_url_secret_arn = aws_secretsmanager_secret.database_url.arn
      grepmind_env_writer    = templatefile("${path.module}/templates/grepmind.env.tftpl", {})
    })
  })

  root_block_device {
    encrypted   = true
    volume_size = 30
    volume_type = "gp3"
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-app"
  })

  depends_on = [
    aws_secretsmanager_secret_version.clerk_secret_key,
    aws_secretsmanager_secret_version.voyage_api_key,
    aws_secretsmanager_secret_version.database_url
  ]
}
