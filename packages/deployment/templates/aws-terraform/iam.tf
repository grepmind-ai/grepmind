data "aws_iam_policy_document" "ec2_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app" {
  name               = "${local.name_prefix}-app"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume_role.json

  tags = local.common_tags
}

data "aws_iam_policy_document" "app" {
  statement {
    sid = "ReadGrepmindSecrets"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret"
    ]
    resources = [
      aws_secretsmanager_secret.clerk_secret_key.arn,
      aws_secretsmanager_secret.voyage_api_key.arn,
      aws_secretsmanager_secret.database_url.arn
    ]
  }

  statement {
    sid = "ListGrepmindArtifactPrefix"
    actions = [
      "s3:ListBucket"
    ]
    resources = [aws_s3_bucket.artifacts.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${local.s3_prefix_normalized}/*", local.s3_prefix_normalized]
    }
  }

  statement {
    sid = "ReadWriteGrepmindArtifacts"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject"
    ]
    resources = ["${aws_s3_bucket.artifacts.arn}/${local.s3_prefix_normalized}/*"]
  }
}

resource "aws_iam_role_policy" "app" {
  name   = "${local.name_prefix}-app"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.app.json
}

resource "aws_iam_instance_profile" "app" {
  name = "${local.name_prefix}-app"
  role = aws_iam_role.app.name
}
