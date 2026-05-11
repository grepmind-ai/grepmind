locals {
  name_prefix        = substr(var.project_name, 0, 32)
  vpc_cidr           = "10.70.0.0/16"
  public_subnet_cidrs  = ["10.70.0.0/24", "10.70.1.0/24"]
  private_subnet_cidrs = ["10.70.10.0/24", "10.70.11.0/24"]
  app_port           = 3847
  database_port      = 5432
  s3_prefix_normalized = trim(var.s3_prefix, "/")

  common_tags = {
    Project   = var.project_name
    ManagedBy = "grepmind-terraform"
  }
}
