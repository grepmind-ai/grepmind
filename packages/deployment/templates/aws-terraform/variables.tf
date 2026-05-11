variable "project_name" {
  type        = string
  description = "Name prefix for Grepmind AWS resources."

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}[a-z0-9]$", var.project_name))
    error_message = "project_name must be 3-32 lowercase letters, digits, or hyphens, and start with a letter."
  }
}

variable "aws_region" {
  type        = string
  description = "AWS region for all resources."

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]+$", var.aws_region))
    error_message = "aws_region must look like us-east-1."
  }
}

variable "domain_name" {
  type        = string
  description = "Public hostname served by the ALB."

  validation {
    condition     = length(trimspace(var.domain_name)) > 0 && !can(regex("://", var.domain_name))
    error_message = "domain_name must be non-empty and must not include a URL scheme."
  }
}

variable "route53_zone_id" {
  type        = string
  description = "Route53 hosted zone id that owns domain_name."
}

variable "grepmind_image" {
  type        = string
  description = "Grepmind app container image."
  default     = "ghcr.io/zaytra-labs/grepmind-app"
}

variable "grepmind_tag" {
  type        = string
  description = "Grepmind app container tag."
  default     = "latest"
}

variable "instance_type" {
  type        = string
  description = "EC2 instance type for the Grepmind runtime."
  default     = "t3.small"
}

variable "ssh_allowed_cidr_blocks" {
  type        = list(string)
  description = "Optional CIDR blocks allowed to SSH to the private EC2 instance."
  default     = []

  validation {
    condition     = alltrue([for cidr in var.ssh_allowed_cidr_blocks : can(cidrhost(cidr, 0))])
    error_message = "ssh_allowed_cidr_blocks must contain valid CIDR blocks."
  }
}

variable "public_base_url" {
  type        = string
  description = "External HTTPS base URL used by Grepmind."

  validation {
    condition     = startswith(var.public_base_url, "https://") && can(regex("^https://${replace(var.domain_name, ".", "\\.")}(:[0-9]+)?/?$", var.public_base_url))
    error_message = "public_base_url must start with https:// and use domain_name as its host."
  }
}

variable "server_instance_id" {
  type        = string
  description = "Stable server instance id written to Grepmind config."
}

variable "clerk_frontend_api_url" {
  type        = string
  description = "Clerk frontend API URL."

  validation {
    condition     = startswith(var.clerk_frontend_api_url, "https://")
    error_message = "clerk_frontend_api_url must be an HTTPS URL."
  }
}

variable "clerk_cli_oauth_client_id" {
  type        = string
  description = "Clerk CLI OAuth client id."
}

variable "clerk_publishable_key" {
  type        = string
  description = "Clerk publishable key written to config.yml."
}

variable "database_name" {
  type        = string
  description = "RDS PostgreSQL database name."
}

variable "database_username" {
  type        = string
  description = "RDS PostgreSQL username."
}

variable "database_instance_class" {
  type        = string
  description = "RDS instance class."
  default     = "db.t4g.micro"
}

variable "database_allocated_storage_gb" {
  type        = number
  description = "RDS allocated storage in GiB."
  default     = 20

  validation {
    condition     = var.database_allocated_storage_gb >= 20
    error_message = "database_allocated_storage_gb must be at least 20."
  }
}

variable "database_deletion_protection" {
  type        = bool
  description = "Enable RDS deletion protection."
  default     = true
}

variable "s3_bucket_name" {
  type        = string
  description = "S3 bucket name for Grepmind artifacts."

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.s3_bucket_name)) && !can(regex("\\.\\.", var.s3_bucket_name)) && !can(regex("^-|-$", var.s3_bucket_name))
    error_message = "s3_bucket_name must be a valid S3 bucket name."
  }
}

variable "s3_prefix" {
  type        = string
  description = "S3 object prefix for Grepmind artifacts."
  default     = "artifacts"
}

variable "clerk_secret_key" {
  type        = string
  description = "Clerk secret key stored in Secrets Manager."
  sensitive   = true
}

variable "voyage_api_key" {
  type        = string
  description = "Voyage API key stored in Secrets Manager."
  sensitive   = true
}

variable "database_password" {
  type        = string
  description = "RDS PostgreSQL password stored in Secrets Manager."
  sensitive   = true
}
