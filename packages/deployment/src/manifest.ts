export type DeploymentTemplateId = 'docker' | 'aws-terraform';

export interface DeploymentTemplateManifest {
  id: DeploymentTemplateId;
  title: string;
  description: string;
  sourceDirectory: string;
  defaultTargetDirectory: string;
  nextSteps: string[];
}

export const deploymentTemplates: Record<
  DeploymentTemplateId,
  DeploymentTemplateManifest
> = {
  docker: {
    id: 'docker',
    title: 'Docker Compose',
    description: 'Run Grepmind on a single Linux VM with Docker Compose.',
    sourceDirectory: 'templates/docker',
    defaultTargetDirectory: 'grepmind-deployment',
    nextSteps: [
      'cd {targetDirectory}',
      'cp .env.example .env',
      './bin/generate-secrets.sh',
      'edit .env and config.yml',
      './bin/start-grepmind.sh',
    ],
  },
  'aws-terraform': {
    id: 'aws-terraform',
    title: 'AWS Terraform',
    description: 'Run Grepmind on AWS behind ALB, ACM, and Route53.',
    sourceDirectory: 'templates/aws-terraform',
    defaultTargetDirectory: 'grepmind-aws-terraform',
    nextSteps: [
      'cd {targetDirectory}',
      'review terraform.tfvars and secrets.auto.tfvars',
      'terraform init',
      'terraform plan -out grepmind.tfplan',
      'terraform apply grepmind.tfplan',
    ],
  },
};
