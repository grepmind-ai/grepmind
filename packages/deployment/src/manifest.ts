export type DeploymentTemplateId = 'docker' | 'aws-terraform' | 'kubernetes-beta';

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
  'kubernetes-beta': {
    id: 'kubernetes-beta',
    title: 'Kubernetes beta',
    description: 'Run the controlled Grepmind SaaS beta app/worker split on Kubernetes.',
    sourceDirectory: 'templates/kubernetes-beta',
    defaultTargetDirectory: 'grepmind-kubernetes-beta',
    nextSteps: [
      'cd {targetDirectory}',
      'set a phase 09-compatible image tag and revision in app-deployment.yaml, worker-deployment.yaml and migration-job.yaml',
      'replace Kubernetes placeholders in configmap.yaml, app-ingress.yaml and the DB budget env',
      'create a real Secret or ExternalSecret from secret.example.yaml without committing secret literals',
      'kubectl apply -f namespace.yaml',
      'kubectl -n <namespace> apply -f configmap.yaml -f <real-secret-or-external-secret-manifest>',
      'kubectl -n <namespace> apply -f migration-job.yaml',
      'kubectl -n <namespace> wait --for=condition=complete job/grepmind-migrate --timeout=300s',
      'kubectl -n <namespace> apply -f worker-deployment.yaml',
      'kubectl -n <namespace> rollout status deployment/grepmind-worker --timeout=300s',
      'kubectl -n <namespace> apply -f app-service.yaml -f app-deployment.yaml -f app-ingress.yaml -f pdb.yaml',
      'kubectl -n <namespace> rollout status deployment/grepmind-app --timeout=300s',
      'complete the beta verification and rollback runbook before launch',
      'run bin/verify-launch-gate.sh with phase 04-08 and staging drill evidence refs',
    ],
  },
};
