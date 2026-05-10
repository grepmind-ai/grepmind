# Grepmind AWS Terraform Deployment

This template deploys one Grepmind runtime on AWS:

```txt
Internet
  -> Route53 A alias
  -> ACM certificate
  -> ALB :80 redirect to :443
  -> ALB :443 HTTPS listener
  -> ALB target group :3847
  -> EC2 instance running ghcr.io/zaytra-labs/grepmind-app
  -> RDS PostgreSQL
  -> S3 bucket
  -> AWS Secrets Manager
```

It creates a new VPC. Existing VPC, ECS, EKS, CloudFront, remote Terraform backend, and in-container TLS are not part of this template.

## Prerequisites

- Terraform `>= 1.6.0`
- AWS credentials with permissions to create VPC, EC2, ALB, ACM, Route53, RDS, S3, IAM, and Secrets Manager resources
- A Route53 hosted zone for `domain_name`
- A domain name in that zone
- Pull access to `ghcr.io/zaytra-labs/grepmind-app:latest`
- Clerk and Voyage runtime credentials

## Generated Files

Copy the secret placeholder file before planning:

```sh
cp secrets.auto.tfvars.example secrets.auto.tfvars
chmod 600 secrets.auto.tfvars
```

Edit `terraform.tfvars` for non-sensitive values and `secrets.auto.tfvars` for sensitive values. Do not commit Terraform state or `secrets.auto.tfvars`; local Terraform state contains sensitive data.

You can also pass sensitive values with environment variables:

```sh
export TF_VAR_clerk_secret_key='...'
export TF_VAR_voyage_api_key='...'
export TF_VAR_database_password='...'
```

## Deploy

```sh
terraform init
terraform plan -out grepmind.tfplan
terraform apply grepmind.tfplan
```

The ALB HTTP listener redirects `80` to `443`. The HTTPS listener uses an ACM certificate validated through Route53. The app target group forwards to the EC2 instance on internal port `3847` and checks `/api/health`.

## Runtime

User data writes:

- `/opt/grepmind/config.yml`
- `/opt/grepmind/.env`
- `/opt/grepmind/bin/update-grepmind-images.sh`
- `/etc/systemd/system/grepmind-app.service`
- `/etc/systemd/system/grepmind-images.service`
- `/etc/systemd/system/grepmind-images.timer`

Secrets are stored in AWS Secrets Manager and resolved on the instance at boot.
The EC2 instance role can read only the Grepmind secrets and read/write only the
configured S3 bucket prefix. Static AWS access keys are not created; the runtime
uses the AWS IAM credential provider for S3 when `GREPMIND_S3_ACCESS_KEY` and
`GREPMIND_S3_SECRET_KEY` are empty.

Inspect the service:

```sh
sudo systemctl status grepmind-app.service
sudo journalctl -u grepmind-app.service -f
sudo docker logs grepmind-app
```

Image updates are controlled by `grepmind_tag` and the daily `grepmind-images.timer`. The update script pulls the configured image, runs `npm run db:migrate`, and restarts only the app container without deleting the repo volume.

## Cost-Bearing Resources

This template creates cost-bearing resources: one NAT gateway, one ALB, one EC2 instance, one RDS PostgreSQL instance, one S3 bucket, Secrets Manager secrets, Route53 records, and EBS storage.

## Destroy

```sh
terraform destroy
```

RDS deletion protection defaults to `true`. To destroy the database, set `database_deletion_protection = false`, apply that change, then destroy. When deletion protection is disabled, Terraform creates a final RDS snapshot on destroy.

## Outputs

Useful outputs include:

- `public_url`
- `healthcheck_url`
- `alb_dns_name`
- `ec2_instance_id`
- `database_endpoint`
- `s3_bucket_name`

Secret ARNs are sensitive outputs. Secret values are not printed.
