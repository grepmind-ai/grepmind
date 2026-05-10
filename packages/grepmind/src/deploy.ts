import { randomBytes } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';

import {
  deploymentTemplates,
  getDeploymentTemplateDirectory,
  type DeploymentTemplateId,
  type DeploymentTemplateManifest,
} from '@grepmind/deployment';

type ParsedArgs = {
  positionals: string[];
  options: Map<string, string[]>;
  booleans: Set<string>;
};

type DockerMode = 'bundled' | 'external';
type ReverseProxyMode = 'none' | 'traefik';

type DockerRenderConfig = {
  mode: DockerMode;
  publicBaseUrl: string;
  serverInstanceId: string;
  clerkFrontendApiUrl: string;
  clerkCliOAuthClientId: string;
  clerkPublishableKey: string;
  clerkSecretKey: string;
  voyageApiKey: string;
  reverseProxy: ReverseProxyMode;
  publicHost: string;
  traefikAcmeEmail: string;
  generateSecrets: boolean;
  external?: {
    databaseUrl: string;
    postgresHost: string;
    postgresPort: number;
    postgresDatabase: string;
    postgresUser: string;
    s3Endpoint: string;
    s3Port: number;
    s3UseSsl: boolean;
    s3Bucket: string;
    s3Prefix: string;
    s3AccessKey: string;
    s3SecretKey: string;
  };
};

type AwsRenderConfig = {
  projectName: string;
  awsRegion: string;
  domainName: string;
  route53ZoneId: string;
  publicBaseUrl: string;
  serverInstanceId: string;
  clerkFrontendApiUrl: string;
  clerkCliOAuthClientId: string;
  clerkPublishableKey: string;
  clerkSecretKey: string;
  voyageApiKey: string;
  databasePassword: string;
  databaseName: string;
  databaseUsername: string;
  databaseInstanceClass: string;
  databaseAllocatedStorageGb: number;
  s3BucketName: string;
  s3Prefix: string;
  instanceType: string;
  grepmindImage: string;
  grepmindTag: string;
  sshAllowedCidrs: string[];
};

const booleanOptions = new Set(['force', 'non-interactive', 'generate-secrets']);

const valueOptions = new Set([
  'aws-region',
  'clerk-cli-oauth-client-id',
  'clerk-frontend-api-url',
  'clerk-publishable-key',
  'clerk-secret-key-env',
  'database-allocated-storage-gb',
  'database-instance-class',
  'database-name',
  'database-password-env',
  'database-url-env',
  'database-username',
  'dir',
  'domain-name',
  'grepmind-image',
  'grepmind-tag',
  'instance-type',
  'mode',
  'postgres-database',
  'postgres-host',
  'postgres-port',
  'postgres-user',
  'project-name',
  'public-base-url',
  'public-host',
  'reverse-proxy',
  'route53-zone-id',
  's3-access-key-env',
  's3-bucket',
  's3-bucket-name',
  's3-endpoint',
  's3-port',
  's3-prefix',
  's3-secret-key-env',
  's3-use-ssl',
  'server-instance-id',
  'ssh-allowed-cidr',
  'traefik-acme-email',
  'voyage-api-key-env',
]);

export async function runDeployCommand(args: string[]) {
  const [command, ...rest] = args;

  switch (command) {
    case 'list':
      printDeployList();
      return;
    case 'init':
      await runDeployInit(rest);
      return;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      printDeployHelp();
      return;
    default:
      throw new Error(`Unknown command: deploy ${command}`);
  }
}

function printDeployList() {
  for (const template of Object.values(deploymentTemplates)) {
    process.stdout.write(`${template.id}\t${template.title}\t${template.description}\n`);
  }
}

function printDeployHelp() {
  process.stdout.write(
    [
      'grepmind deploy',
      '',
      'Commands:',
      '  grepmind deploy init',
      '  grepmind deploy init <platform> [--dir <path>] [--force]',
      '  grepmind deploy init docker --non-interactive --mode <mode> [options]',
      '  grepmind deploy init aws-terraform [--dir <path>] [--force]',
      '  grepmind deploy init aws-terraform --non-interactive [options]',
      '  grepmind deploy list',
      '',
      'Platforms:',
      '  docker  Docker Compose deployment for one Linux VM',
      '  aws-terraform  AWS deployment behind ALB, ACM, and Route53',
      '',
    ].join('\n'),
  );
}

async function runDeployInit(args: string[]) {
  const parsed = parseArgs(args);
  const [platform] = parsed.positionals;

  if (parsed.positionals.length > 1) {
    throw new Error(`Unexpected argument: ${parsed.positionals[1]}`);
  }

  if (platform == null) {
    await runInteractiveWizard(parsed);
    return;
  }

  if (!isDeploymentTemplateId(platform)) {
    throw new Error(`Unsupported deployment platform: ${platform}`);
  }

  if (platform === 'docker') {
    if (hasBoolean(parsed, 'non-interactive')) {
      await initDockerNonInteractive(parsed);
    } else {
      await copyTemplateCommand('docker', parsed);
    }
    return;
  }

  if (hasBoolean(parsed, 'non-interactive')) {
    await initAwsNonInteractive(parsed);
  } else {
    await copyTemplateCommand('aws-terraform', parsed);
  }
}

async function copyTemplateCommand(id: DeploymentTemplateId, parsed: ParsedArgs) {
  assertAllowedOptions(parsed, ['dir', 'force']);
  const manifest = deploymentTemplates[id];
  const targetDirectory = resolveTargetDirectory(
    getOption(parsed, 'dir') ?? manifest.defaultTargetDirectory,
  );

  await copyDeploymentTemplate(id, targetDirectory, hasBoolean(parsed, 'force'));
  if (id === 'aws-terraform') {
    await writeAwsPlaceholderSecrets(targetDirectory);
  }
  printTemplateSummary(manifest, targetDirectory);
}

async function initDockerNonInteractive(parsed: ParsedArgs) {
  assertAllowedOptions(parsed, [
    'clerk-cli-oauth-client-id',
    'clerk-frontend-api-url',
    'clerk-publishable-key',
    'clerk-secret-key-env',
    'database-url-env',
    'dir',
    'force',
    'generate-secrets',
    'mode',
    'postgres-database',
    'postgres-host',
    'postgres-port',
    'postgres-user',
    'public-base-url',
    'public-host',
    'reverse-proxy',
    's3-access-key-env',
    's3-bucket',
    's3-endpoint',
    's3-port',
    's3-prefix',
    's3-secret-key-env',
    's3-use-ssl',
    'server-instance-id',
    'traefik-acme-email',
    'voyage-api-key-env',
  ]);

  const targetDirectory = resolveTargetDirectory(requireOption(parsed, 'dir'));
  const config = readDockerNonInteractiveConfig(parsed);
  await copyDeploymentTemplate('docker', targetDirectory, hasBoolean(parsed, 'force'));
  await renderDockerConfig(targetDirectory, config);

  process.stdout.write(
    [
      `Initialized Docker deployment in ${targetDirectory}`,
      `Mode: ${config.mode}`,
      `Reverse proxy: ${config.reverseProxy}`,
      'Wrote .env and config.yml.',
      config.mode === 'bundled'
        ? 'Wrote .env.grepmind-generated with bundled service secret variables.'
        : 'External mode did not create .env.grepmind-generated.',
      'Next: ./bin/start-grepmind.sh',
      '',
    ].join('\n'),
  );
}

function readDockerNonInteractiveConfig(parsed: ParsedArgs): DockerRenderConfig {
  const mode = parseMode(requireOption(parsed, 'mode'));
  const reverseProxy = parseReverseProxy(requireOption(parsed, 'reverse-proxy'));
  const config: DockerRenderConfig = {
    mode,
    publicBaseUrl: requireUrl(requireOption(parsed, 'public-base-url'), 'public-base-url'),
    serverInstanceId: requireServerInstanceId(requireOption(parsed, 'server-instance-id')),
    clerkFrontendApiUrl: requireUrl(requireOption(parsed, 'clerk-frontend-api-url'), 'clerk-frontend-api-url'),
    clerkCliOAuthClientId: requireNonEmpty(requireOption(parsed, 'clerk-cli-oauth-client-id'), 'clerk-cli-oauth-client-id'),
    clerkPublishableKey: requireNonEmpty(requireOption(parsed, 'clerk-publishable-key'), 'clerk-publishable-key'),
    clerkSecretKey: readRequiredEnv(requireOption(parsed, 'clerk-secret-key-env')),
    voyageApiKey: readRequiredEnv(requireOption(parsed, 'voyage-api-key-env')),
    reverseProxy,
    publicHost: '',
    traefikAcmeEmail: '',
    generateSecrets: hasBoolean(parsed, 'generate-secrets'),
  };

  if (reverseProxy === 'traefik') {
    config.publicHost = requireNonEmpty(requireOption(parsed, 'public-host'), 'public-host');
    config.traefikAcmeEmail = requireNonEmpty(
      requireOption(parsed, 'traefik-acme-email'),
      'traefik-acme-email',
    );
    assertHttpsForTraefik(config.publicBaseUrl, config.publicHost);
  }

  if (mode === 'bundled') {
    if (!config.generateSecrets) {
      throw new Error('--generate-secrets is required for bundled non-interactive Docker init');
    }
    return config;
  }

  if (config.generateSecrets) {
    throw new Error('--generate-secrets is only valid for bundled Docker mode');
  }

  config.external = {
    databaseUrl: readRequiredEnv(requireOption(parsed, 'database-url-env')),
    postgresHost: requireNonEmpty(requireOption(parsed, 'postgres-host'), 'postgres-host'),
    postgresPort: parsePort(requireOption(parsed, 'postgres-port'), 'postgres-port'),
    postgresDatabase: requireNonEmpty(requireOption(parsed, 'postgres-database'), 'postgres-database'),
    postgresUser: requireNonEmpty(requireOption(parsed, 'postgres-user'), 'postgres-user'),
    s3Endpoint: requireTrimmed(requireOption(parsed, 's3-endpoint'), 's3-endpoint'),
    s3Port: parsePort(requireOption(parsed, 's3-port'), 's3-port'),
    s3UseSsl: parseBoolean(requireOption(parsed, 's3-use-ssl'), 's3-use-ssl'),
    s3Bucket: requireTrimmed(requireOption(parsed, 's3-bucket'), 's3-bucket'),
    s3Prefix: requireTrimmed(requireOption(parsed, 's3-prefix'), 's3-prefix'),
    s3AccessKey: readRequiredEnv(requireOption(parsed, 's3-access-key-env')),
    s3SecretKey: readRequiredEnv(requireOption(parsed, 's3-secret-key-env')),
  };

  return config;
}

async function initAwsNonInteractive(parsed: ParsedArgs) {
  assertAllowedOptions(parsed, [
    'aws-region',
    'clerk-cli-oauth-client-id',
    'clerk-frontend-api-url',
    'clerk-publishable-key',
    'clerk-secret-key-env',
    'database-allocated-storage-gb',
    'database-instance-class',
    'database-name',
    'database-password-env',
    'database-username',
    'dir',
    'domain-name',
    'force',
    'grepmind-image',
    'grepmind-tag',
    'instance-type',
    'project-name',
    'route53-zone-id',
    's3-bucket-name',
    's3-prefix',
    'server-instance-id',
    'ssh-allowed-cidr',
    'voyage-api-key-env',
  ]);

  const targetDirectory = resolveTargetDirectory(requireOption(parsed, 'dir'));
  const config = readAwsNonInteractiveConfig(parsed);
  await copyDeploymentTemplate('aws-terraform', targetDirectory, hasBoolean(parsed, 'force'));
  await renderAwsConfig(targetDirectory, config);

  process.stdout.write(
    [
      `Initialized AWS Terraform deployment in ${targetDirectory}`,
      `Domain: ${config.domainName}`,
      `Region: ${config.awsRegion}`,
      `Instance: ${config.instanceType}`,
      `Database: ${config.databaseInstanceClass}, ${config.databaseAllocatedStorageGb} GiB`,
      'Wrote terraform.tfvars and secrets.auto.tfvars.',
      'Next: terraform init && terraform plan -out grepmind.tfplan',
      '',
    ].join('\n'),
  );
}

function readAwsNonInteractiveConfig(parsed: ParsedArgs): AwsRenderConfig {
  const domainName = requireHost(requireOption(parsed, 'domain-name'), 'domain-name');

  return {
    projectName: requireNonEmpty(requireOption(parsed, 'project-name'), 'project-name'),
    awsRegion: requireNonEmpty(requireOption(parsed, 'aws-region'), 'aws-region'),
    domainName,
    route53ZoneId: requireNonEmpty(requireOption(parsed, 'route53-zone-id'), 'route53-zone-id'),
    publicBaseUrl: `https://${domainName}`,
    serverInstanceId: requireServerInstanceId(requireOption(parsed, 'server-instance-id')),
    clerkFrontendApiUrl: requireUrl(requireOption(parsed, 'clerk-frontend-api-url'), 'clerk-frontend-api-url'),
    clerkCliOAuthClientId: requireNonEmpty(requireOption(parsed, 'clerk-cli-oauth-client-id'), 'clerk-cli-oauth-client-id'),
    clerkPublishableKey: requireNonEmpty(requireOption(parsed, 'clerk-publishable-key'), 'clerk-publishable-key'),
    clerkSecretKey: readRequiredEnv(requireOption(parsed, 'clerk-secret-key-env')),
    voyageApiKey: readRequiredEnv(requireOption(parsed, 'voyage-api-key-env')),
    databasePassword: readRequiredEnv(requireOption(parsed, 'database-password-env')),
    databaseName: requireNonEmpty(requireOption(parsed, 'database-name'), 'database-name'),
    databaseUsername: requireNonEmpty(requireOption(parsed, 'database-username'), 'database-username'),
    databaseInstanceClass: requireNonEmpty(
      requireOption(parsed, 'database-instance-class'),
      'database-instance-class',
    ),
    databaseAllocatedStorageGb: parsePositiveInteger(
      requireOption(parsed, 'database-allocated-storage-gb'),
      'database-allocated-storage-gb',
      20,
    ),
    s3BucketName: requireTrimmed(requireOption(parsed, 's3-bucket-name'), 's3-bucket-name'),
    s3Prefix: requireTrimmed(requireOption(parsed, 's3-prefix'), 's3-prefix'),
    instanceType: requireNonEmpty(requireOption(parsed, 'instance-type'), 'instance-type'),
    grepmindImage: getOption(parsed, 'grepmind-image') ?? 'ghcr.io/zaytra-labs/grepmind-app',
    grepmindTag: getOption(parsed, 'grepmind-tag') ?? 'latest',
    sshAllowedCidrs: getOptions(parsed, 'ssh-allowed-cidr'),
  };
}

async function runInteractiveWizard(parsed: ParsedArgs) {
  if (hasBoolean(parsed, 'non-interactive')) {
    throw new Error('grepmind deploy init --non-interactive requires a platform');
  }
  assertAllowedOptions(parsed, ['dir', 'force']);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('grepmind deploy init requires an interactive TTY');
  }

  const target = (await promptChoice('Deployment target', [
    ['docker', 'Docker Compose'],
    ['aws-terraform', 'AWS Terraform'],
  ])) as DeploymentTemplateId;

  if (target === 'docker') {
    await runDockerWizard(parsed);
  } else {
    await runAwsWizard(parsed);
  }
}

async function runDockerWizard(parsed: ParsedArgs) {
  const manifest = deploymentTemplates.docker;
  const targetDirectory = await promptTargetDirectory(parsed, manifest);
  const force = await resolveForce(parsed, targetDirectory);

  const mode = (await promptChoice('Data mode', [
    ['bundled', 'bundled PostgreSQL and MinIO'],
    ['external', 'external PostgreSQL and S3-compatible storage'],
  ])) as DockerMode;
  const reverseProxy = (await promptChoice('Reverse proxy', [
    ['none', 'direct HTTP on 3847'],
    ['traefik', 'Traefik HTTP->HTTPS with ACME'],
  ])) as ReverseProxyMode;

  const publicHost =
    reverseProxy === 'traefik'
      ? await promptRequired('Public hostname')
      : '';
  const publicBaseUrlDefault =
    reverseProxy === 'traefik' ? `https://${publicHost}` : 'http://203.0.113.10:3847';

  const config: DockerRenderConfig = {
    mode,
    publicBaseUrl: requireUrl(
      await promptRequired('Public base URL', publicBaseUrlDefault),
      'public base URL',
    ),
    serverInstanceId: requireServerInstanceId(
      await promptRequired('Server instance ID', 'grepmind-self-hosted-1'),
    ),
    clerkFrontendApiUrl: requireUrl(
      await promptRequired('Clerk frontend API URL'),
      'Clerk frontend API URL',
    ),
    clerkCliOAuthClientId: await promptRequired('Clerk CLI OAuth client ID'),
    clerkPublishableKey: await promptRequired('Clerk publishable key'),
    clerkSecretKey: await promptSecretRequired('Clerk secret key'),
    voyageApiKey: await promptSecretRequired('Voyage API key'),
    reverseProxy,
    publicHost,
    traefikAcmeEmail:
      reverseProxy === 'traefik' ? await promptRequired('Traefik ACME email') : '',
    generateSecrets: mode === 'bundled',
  };

  if (reverseProxy === 'traefik') {
    assertHttpsForTraefik(config.publicBaseUrl, publicHost);
  }

  if (mode === 'external') {
    config.external = {
      databaseUrl: await promptSecretRequired('PostgreSQL DATABASE_URL'),
      postgresHost: await promptRequired('PostgreSQL host'),
      postgresPort: parsePort(await promptRequired('PostgreSQL port', '5432'), 'PostgreSQL port'),
      postgresDatabase: await promptRequired('PostgreSQL database', 'grepmind'),
      postgresUser: await promptRequired('PostgreSQL user', 'grepmind'),
      s3Endpoint: requireTrimmed(await promptRequired('S3 endpoint'), 'S3 endpoint'),
      s3Port: parsePort(await promptRequired('S3 port', '443'), 'S3 port'),
      s3UseSsl: await promptBoolean('S3 use SSL', true),
      s3Bucket: requireTrimmed(await promptRequired('S3 bucket'), 'S3 bucket'),
      s3Prefix: requireTrimmed(await promptRequired('S3 prefix', 'artifacts'), 'S3 prefix'),
      s3AccessKey: await promptSecretRequired('S3 access key'),
      s3SecretKey: await promptSecretRequired('S3 secret key'),
    };
  }

  await copyDeploymentTemplate('docker', targetDirectory, force);
  await renderDockerConfig(targetDirectory, config);
  process.stdout.write(
    [
      `Initialized Docker deployment in ${targetDirectory}`,
      `Mode: ${config.mode}`,
      `Reverse proxy: ${config.reverseProxy}`,
      'Configured secret variables: CLERK_SECRET_KEY, VOYAGE_API_KEY',
      config.mode === 'external'
        ? 'Configured external secret variables: DATABASE_URL, GREPMIND_S3_ACCESS_KEY, GREPMIND_S3_SECRET_KEY'
        : 'Generated bundled service secret variables in .env.grepmind-generated',
      'Next: ./bin/start-grepmind.sh',
      '',
    ].join('\n'),
  );
}

async function runAwsWizard(parsed: ParsedArgs) {
  const manifest = deploymentTemplates['aws-terraform'];
  const targetDirectory = await promptTargetDirectory(parsed, manifest);
  const force = await resolveForce(parsed, targetDirectory);
  const domainName = requireHost(await promptRequired('Domain name'), 'domain name');
  const publicBaseUrl = `https://${domainName}`;
  process.stdout.write(`public_base_url will be ${publicBaseUrl}\n`);

  const config: AwsRenderConfig = {
    projectName: await promptRequired('Project name', 'grepmind'),
    awsRegion: await promptRequired('AWS region', 'us-east-1'),
    domainName,
    route53ZoneId: await promptRequired('Route53 hosted zone id'),
    publicBaseUrl,
    serverInstanceId: requireServerInstanceId(
      await promptRequired('Server instance ID', 'grepmind-aws-1'),
    ),
    clerkFrontendApiUrl: requireUrl(
      await promptRequired('Clerk frontend API URL'),
      'Clerk frontend API URL',
    ),
    clerkCliOAuthClientId: await promptRequired('Clerk CLI OAuth client ID'),
    clerkPublishableKey: await promptRequired('Clerk publishable key'),
    clerkSecretKey: await promptSecretRequired('Clerk secret key'),
    voyageApiKey: await promptSecretRequired('Voyage API key'),
    databasePassword: await promptSecretRequired('RDS database password'),
    databaseName: await promptRequired('RDS database name', 'grepmind'),
    databaseUsername: await promptRequired('RDS database username', 'grepmind'),
    databaseInstanceClass: await promptRequired('RDS instance class', 'db.t4g.micro'),
    databaseAllocatedStorageGb: parsePositiveInteger(
      await promptRequired('RDS allocated storage GiB', '20'),
      'RDS allocated storage GiB',
      20,
    ),
    s3BucketName: requireTrimmed(await promptRequired('S3 bucket name'), 'S3 bucket name'),
    s3Prefix: requireTrimmed(await promptRequired('S3 prefix', 'artifacts'), 'S3 prefix'),
    instanceType: await promptRequired('EC2 instance type', 't3.small'),
    grepmindImage: 'ghcr.io/zaytra-labs/grepmind-app',
    grepmindTag: 'latest',
    sshAllowedCidrs: await promptStringList('SSH allowed CIDR blocks, comma-separated', ''),
  };

  await copyDeploymentTemplate('aws-terraform', targetDirectory, force);
  await renderAwsConfig(targetDirectory, config);
  process.stdout.write(
    [
      `Initialized AWS Terraform deployment in ${targetDirectory}`,
      `Domain: ${config.domainName}`,
      `Region: ${config.awsRegion}`,
      `Instance: ${config.instanceType}`,
      `Database: ${config.databaseInstanceClass}, ${config.databaseAllocatedStorageGb} GiB`,
      'Configured secret variables in secrets.auto.tfvars.',
      'Next: terraform init && terraform plan -out grepmind.tfplan',
      '',
    ].join('\n'),
  );
}

async function promptTargetDirectory(
  parsed: ParsedArgs,
  manifest: DeploymentTemplateManifest,
) {
  const value =
    getOption(parsed, 'dir') ??
    (await promptRequired('Target directory', manifest.defaultTargetDirectory));
  return resolveTargetDirectory(value);
}

async function resolveForce(parsed: ParsedArgs, targetDirectory: string) {
  if (hasBoolean(parsed, 'force')) {
    return true;
  }

  if (await isNonEmptyDirectory(targetDirectory)) {
    return promptBoolean(`Target ${targetDirectory} is non-empty. Overwrite template files`, false);
  }

  return false;
}

async function renderDockerConfig(targetDirectory: string, config: DockerRenderConfig) {
  validateDockerConfig(config);
  await writePrivateFile(path.join(targetDirectory, '.env'), renderDockerEnv(config));
  await writeFile(path.join(targetDirectory, 'config.yml'), renderDockerYaml(config), 'utf8');

  if (config.mode === 'bundled' && config.generateSecrets) {
    await writePrivateFile(
      path.join(targetDirectory, '.env.grepmind-generated'),
      renderGeneratedBundledSecrets(),
    );
  }
}

function renderDockerEnv(config: DockerRenderConfig) {
  const lines = [
    ['GREPMIND_IMAGE', 'ghcr.io/zaytra-labs/grepmind-app'],
    ['GREPMIND_TAG', 'latest'],
    ['GREPMIND_DEPLOYMENT_MODE', config.mode],
    ['GREPMIND_HTTP_PORT', config.reverseProxy === 'traefik' ? '80' : '3847'],
    ['GREPMIND_REVERSE_PROXY', config.reverseProxy],
    ['GREPMIND_HTTPS_PORT', '443'],
    ['GREPMIND_PUBLIC_HOST', config.publicHost],
    ['TRAEFIK_ACME_EMAIL', config.traefikAcmeEmail],
    ['CLERK_SECRET_KEY', config.clerkSecretKey],
    ['VOYAGE_API_KEY', config.voyageApiKey],
    ['DATABASE_URL', config.external?.databaseUrl ?? ''],
    ['GREPMIND_S3_ACCESS_KEY', config.external?.s3AccessKey ?? ''],
    ['GREPMIND_S3_SECRET_KEY', config.external?.s3SecretKey ?? ''],
  ];

  return `${lines.map(([key, value]) => `${key}=${quoteShell(value)}`).join('\n')}\n`;
}

function renderDockerYaml(config: DockerRenderConfig) {
  const database =
    config.mode === 'external' && config.external != null
      ? {
          host: config.external.postgresHost,
          port: config.external.postgresPort,
          name: config.external.postgresDatabase,
          user: config.external.postgresUser,
        }
      : {
          host: 'postgres',
          port: 5432,
          name: 'grepmind',
          user: 'grepmind',
        };
  const storage =
    config.mode === 'external' && config.external != null
      ? {
          endPoint: config.external.s3Endpoint,
          port: config.external.s3Port,
          useSSL: config.external.s3UseSsl,
          bucket: config.external.s3Bucket,
          prefix: config.external.s3Prefix,
        }
      : {
          endPoint: 'minio',
          port: 9000,
          useSSL: false,
          bucket: 'grepmind',
          prefix: 'artifacts',
        };

  return [
    'app:',
    '  host: 0.0.0.0',
    '  port: 3847',
    `  publicBaseUrl: ${config.publicBaseUrl}`,
    `  serverInstanceId: ${config.serverInstanceId}`,
    '',
    'agentAuth:',
    `  frontendApiUrl: ${config.clerkFrontendApiUrl}`,
    `  cliOAuthClientId: ${config.clerkCliOAuthClientId}`,
    '',
    'clerk:',
    `  publishableKey: ${config.clerkPublishableKey}`,
    '',
    'database:',
    `  host: ${database.host}`,
    `  port: ${database.port}`,
    `  name: ${database.name}`,
    `  user: ${database.user}`,
    '',
    'storage:',
    `  endPoint: ${storage.endPoint}`,
    `  port: ${storage.port}`,
    `  useSSL: ${storage.useSSL ? 'true' : 'false'}`,
    `  bucket: ${storage.bucket}`,
    `  prefix: ${storage.prefix}`,
    '',
    'embedding:',
    '  provider: voyage',
    '  model: voyage-code-3',
    '',
    'docsEmbedding:',
    '  provider: voyage',
    '  model: voyage-context-3',
    '',
    'reranker:',
    '  provider: voyage',
    '  model: rerank-2',
    '',
  ].join('\n');
}

function renderGeneratedBundledSecrets() {
  const postgresPassword = randomSecret();
  const s3AccessKey = `grepmind_${randomAlphaNumeric(24)}`;
  const s3SecretKey = randomSecret();
  const minioRootUser = `minio_${randomAlphaNumeric(18)}`;
  const minioRootPassword = randomSecret();
  const databaseUrl = `postgresql://grepmind:${postgresPassword}@postgres:5432/grepmind`;

  const lines = [
    ['POSTGRES_PASSWORD', postgresPassword],
    ['DATABASE_URL', databaseUrl],
    ['GREPMIND_S3_ACCESS_KEY', s3AccessKey],
    ['GREPMIND_S3_SECRET_KEY', s3SecretKey],
    ['MINIO_ROOT_USER', minioRootUser],
    ['MINIO_ROOT_PASSWORD', minioRootPassword],
  ];

  return `${lines.map(([key, value]) => `${key}=${quoteShell(value)}`).join('\n')}\n`;
}

function validateDockerConfig(config: DockerRenderConfig) {
  requireUrl(config.publicBaseUrl, 'publicBaseUrl');
  requireServerInstanceId(config.serverInstanceId);
  requireUrl(config.clerkFrontendApiUrl, 'clerkFrontendApiUrl');
  requireNonEmpty(config.clerkCliOAuthClientId, 'clerkCliOAuthClientId');
  requireNonEmpty(config.clerkPublishableKey, 'clerkPublishableKey');
  requireNonEmpty(config.clerkSecretKey, 'CLERK_SECRET_KEY');
  requireNonEmpty(config.voyageApiKey, 'VOYAGE_API_KEY');

  if (config.reverseProxy === 'traefik') {
    requireHost(config.publicHost, 'GREPMIND_PUBLIC_HOST');
    requireNonEmpty(config.traefikAcmeEmail, 'TRAEFIK_ACME_EMAIL');
    assertHttpsForTraefik(config.publicBaseUrl, config.publicHost);
  }

  if (config.mode === 'external') {
    if (config.external == null) {
      throw new Error('External Docker mode requires external database and S3 config');
    }
    requireNonEmpty(config.external.databaseUrl, 'DATABASE_URL');
    requireNonEmpty(config.external.s3AccessKey, 'GREPMIND_S3_ACCESS_KEY');
    requireNonEmpty(config.external.s3SecretKey, 'GREPMIND_S3_SECRET_KEY');
  }
}

async function renderAwsConfig(targetDirectory: string, config: AwsRenderConfig) {
  validateAwsConfig(config);
  await writeFile(path.join(targetDirectory, 'terraform.tfvars'), renderTerraformTfvars(config), 'utf8');
  await writePrivateFile(
    path.join(targetDirectory, 'secrets.auto.tfvars'),
    renderTerraformSecrets(config),
  );
}

function renderTerraformTfvars(config: AwsRenderConfig) {
  const values: Record<string, string | number | boolean | string[]> = {
    project_name: config.projectName,
    aws_region: config.awsRegion,
    domain_name: config.domainName,
    route53_zone_id: config.route53ZoneId,
    grepmind_image: config.grepmindImage,
    grepmind_tag: config.grepmindTag,
    public_base_url: config.publicBaseUrl,
    server_instance_id: config.serverInstanceId,
    clerk_frontend_api_url: config.clerkFrontendApiUrl,
    clerk_cli_oauth_client_id: config.clerkCliOAuthClientId,
    clerk_publishable_key: config.clerkPublishableKey,
    database_name: config.databaseName,
    database_username: config.databaseUsername,
    database_instance_class: config.databaseInstanceClass,
    database_allocated_storage_gb: config.databaseAllocatedStorageGb,
    s3_bucket_name: config.s3BucketName,
    s3_prefix: config.s3Prefix,
    instance_type: config.instanceType,
    ssh_allowed_cidr_blocks: config.sshAllowedCidrs,
  };

  return `${Object.entries(values)
    .map(([key, value]) => `${key} = ${toHclValue(value)}`)
    .join('\n')}\n`;
}

function renderTerraformSecrets(config: AwsRenderConfig) {
  return [
    `clerk_secret_key = ${toHclValue(config.clerkSecretKey)}`,
    `voyage_api_key = ${toHclValue(config.voyageApiKey)}`,
    `database_password = ${toHclValue(config.databasePassword)}`,
    '',
  ].join('\n');
}

function validateAwsConfig(config: AwsRenderConfig) {
  requireNonEmpty(config.projectName, 'project_name');
  requireNonEmpty(config.awsRegion, 'aws_region');
  requireHost(config.domainName, 'domain_name');
  requireNonEmpty(config.route53ZoneId, 'route53_zone_id');
  if (config.publicBaseUrl !== `https://${config.domainName}`) {
    throw new Error('public_base_url must be derived from domain_name');
  }
  requireServerInstanceId(config.serverInstanceId);
  requireUrl(config.clerkFrontendApiUrl, 'clerk_frontend_api_url');
  requireNonEmpty(config.clerkCliOAuthClientId, 'clerk_cli_oauth_client_id');
  requireNonEmpty(config.clerkPublishableKey, 'clerk_publishable_key');
  requireNonEmpty(config.clerkSecretKey, 'clerk_secret_key');
  requireNonEmpty(config.voyageApiKey, 'voyage_api_key');
  requireNonEmpty(config.databasePassword, 'database_password');
  requireNonEmpty(config.databaseName, 'database_name');
  requireNonEmpty(config.databaseUsername, 'database_username');
  requireNonEmpty(config.databaseInstanceClass, 'database_instance_class');
  if (config.databaseAllocatedStorageGb < 20) {
    throw new Error('database_allocated_storage_gb must be at least 20');
  }
  requireTrimmed(config.s3BucketName, 's3_bucket_name');
  requireTrimmed(config.s3Prefix, 's3_prefix');
  requireNonEmpty(config.instanceType, 'instance_type');
}

async function copyDeploymentTemplate(
  id: DeploymentTemplateId,
  targetDirectory: string,
  force: boolean,
) {
  const sourceDirectory = getDeploymentTemplateDirectory(id);
  await prepareTargetDirectory(targetDirectory, force);
  await copyDirectoryContents(sourceDirectory, targetDirectory, targetDirectory);
}

async function prepareTargetDirectory(targetDirectory: string, force: boolean) {
  let targetStat;
  try {
    targetStat = await lstat(targetDirectory);
  } catch (error) {
    if (isNotFound(error)) {
      await mkdir(targetDirectory, { recursive: true });
      return;
    }
    throw error;
  }

  if (targetStat.isSymbolicLink()) {
    throw new Error(`Target directory is a symlink: ${targetDirectory}`);
  }

  if (!targetStat.isDirectory()) {
    throw new Error(`Target path is not a directory: ${targetDirectory}`);
  }

  const entries = await readdir(targetDirectory);
  if (entries.length > 0 && !force) {
    throw new Error(`Target directory is not empty: ${targetDirectory}`);
  }
}

async function copyDirectoryContents(
  sourceDirectory: string,
  targetDirectory: string,
  rootTarget: string,
) {
  const entries = await readdir(sourceDirectory);
  for (const entry of entries) {
    const targetEntry = entry === 'gitignore' ? '.gitignore' : entry;
    await copyEntry(
      path.join(sourceDirectory, entry),
      path.join(targetDirectory, targetEntry),
      rootTarget,
    );
  }
}

async function copyEntry(sourcePath: string, targetPath: string, rootTarget: string) {
  const sourceStat = await lstat(sourcePath);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`Template contains unsupported symlink: ${sourcePath}`);
  }

  assertInside(rootTarget, targetPath);
  await assertNoSymlinkParents(rootTarget, targetPath);

  if (sourceStat.isDirectory()) {
    await assertDestinationIsNotSymlink(targetPath);
    await mkdir(targetPath, { recursive: true });
    await copyDirectoryContents(sourcePath, targetPath, rootTarget);
    return;
  }

  if (!sourceStat.isFile()) {
    throw new Error(`Template contains unsupported file type: ${sourcePath}`);
  }

  await assertDestinationIsNotSymlink(targetPath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);

  const relativeTarget = path.relative(rootTarget, targetPath);
  if (relativeTarget.startsWith(`bin${path.sep}`) && relativeTarget.endsWith('.sh')) {
    await chmod(targetPath, 0o755);
  } else {
    await chmod(targetPath, sourceStat.mode & 0o777);
  }
}

async function assertDestinationIsNotSymlink(targetPath: string) {
  try {
    const destinationStat = await lstat(targetPath);
    if (destinationStat.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symlink: ${targetPath}`);
    }
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

async function assertNoSymlinkParents(rootTarget: string, targetPath: string) {
  let current = path.dirname(targetPath);
  const parents: string[] = [];
  while (current !== rootTarget && current.startsWith(rootTarget)) {
    parents.push(current);
    current = path.dirname(current);
  }

  for (const parent of parents.reverse()) {
    try {
      const parentStat = await lstat(parent);
      if (parentStat.isSymbolicLink()) {
        throw new Error(`Refusing to write through symlink directory: ${parent}`);
      }
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
  }
}

async function writeAwsPlaceholderSecrets(targetDirectory: string) {
  const secretsPath = path.join(targetDirectory, 'secrets.auto.tfvars');
  try {
    await lstat(secretsPath);
    return;
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }

  await writePrivateFile(
    secretsPath,
    [
      'clerk_secret_key = "replace_me"',
      'voyage_api_key = "replace_me"',
      'database_password = "replace_me"',
      '',
    ].join('\n'),
  );
}

function assertInside(root: string, target: string) {
  const relative = path.relative(root, target);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error(`Refusing to write outside target directory: ${target}`);
}

function printTemplateSummary(
  manifest: DeploymentTemplateManifest,
  targetDirectory: string,
) {
  process.stdout.write(`Initialized ${manifest.title} template in ${targetDirectory}\n`);
  process.stdout.write('Next steps:\n');
  for (const step of manifest.nextSteps) {
    process.stdout.write(`  ${step.replaceAll('{targetDirectory}', targetDirectory)}\n`);
  }
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  const booleans = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    const equalsIndex = arg.indexOf('=');
    const rawName = equalsIndex === -1 ? arg.slice(2) : arg.slice(2, equalsIndex);
    if (!booleanOptions.has(rawName) && !valueOptions.has(rawName)) {
      throw new Error(`Unknown option: --${rawName}`);
    }

    if (booleanOptions.has(rawName)) {
      if (equalsIndex !== -1) {
        throw new Error(`Option --${rawName} does not take a value`);
      }
      booleans.add(rawName);
      continue;
    }

    const value = equalsIndex === -1 ? args[index + 1] : arg.slice(equalsIndex + 1);
    if (value == null || value.startsWith('--')) {
      throw new Error(`Option --${rawName} requires a value`);
    }
    if (equalsIndex === -1) {
      index += 1;
    }
    const values = options.get(rawName) ?? [];
    values.push(value);
    options.set(rawName, values);
  }

  return { positionals, options, booleans };
}

function assertAllowedOptions(parsed: ParsedArgs, allowed: string[]) {
  const allowedSet = new Set(allowed);
  for (const option of parsed.options.keys()) {
    if (!allowedSet.has(option)) {
      throw new Error(`Option --${option} is not supported here`);
    }
  }
  for (const option of parsed.booleans) {
    if (!allowedSet.has(option) && option !== 'non-interactive') {
      throw new Error(`Option --${option} is not supported here`);
    }
  }
}

function getOption(parsed: ParsedArgs, name: string) {
  const values = parsed.options.get(name);
  if (values == null) {
    return undefined;
  }
  if (values.length !== 1) {
    throw new Error(`Option --${name} can be provided only once`);
  }
  return values[0];
}

function getOptions(parsed: ParsedArgs, name: string) {
  return parsed.options.get(name) ?? [];
}

function requireOption(parsed: ParsedArgs, name: string) {
  const value = getOption(parsed, name);
  if (value == null || value === '') {
    throw new Error(`Missing required option --${name}`);
  }
  return value;
}

function hasBoolean(parsed: ParsedArgs, name: string) {
  return parsed.booleans.has(name);
}

function parseMode(value: string): DockerMode {
  if (value === 'bundled' || value === 'external') {
    return value;
  }
  throw new Error('--mode must be bundled or external');
}

function parseReverseProxy(value: string): ReverseProxyMode {
  if (value === 'none' || value === 'traefik') {
    return value;
  }
  throw new Error('--reverse-proxy must be none or traefik');
}

function parsePort(value: string, name: string) {
  return parsePositiveInteger(value, name, 1, 65_535);
}

function parsePositiveInteger(value: string, name: string, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return parsed;
}

function parseBoolean(value: string, name: string) {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

function readRequiredEnv(name: string) {
  requireEnvName(name);
  const value = process.env[name];
  if (value == null || value === '') {
    throw new Error(`Environment variable ${name} must be set`);
  }
  return value;
}

function requireEnvName(name: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid environment variable name: ${name}`);
  }
}

function requireNonEmpty(value: string, name: string) {
  if (value.trim() === '') {
    throw new Error(`${name} must not be empty`);
  }
  return value;
}

function requireTrimmed(value: string, name: string) {
  requireNonEmpty(value, name);
  if (value !== value.trim()) {
    throw new Error(`${name} must not contain surrounding whitespace`);
  }
  return value;
}

function requireUrl(value: string, name: string) {
  requireNonEmpty(value, name);
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('invalid protocol');
    }
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  return value;
}

function requireHost(value: string, name: string) {
  requireTrimmed(value, name);
  if (value.includes('://') || value.includes('/')) {
    throw new Error(`${name} must be a hostname, not a URL`);
  }
  return value;
}

function requireServerInstanceId(value: string) {
  requireNonEmpty(value, 'serverInstanceId');
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error('serverInstanceId may contain only letters, digits, dot, underscore, colon, and hyphen');
  }
  return value;
}

function assertHttpsForTraefik(publicBaseUrl: string, publicHost: string) {
  const parsed = new URL(publicBaseUrl);
  if (parsed.protocol !== 'https:' || parsed.hostname !== publicHost) {
    throw new Error('Traefik mode requires --public-base-url to be https://<public-host>');
  }
}

function quoteShell(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function toHclValue(value: string | number | boolean | string[]) {
  return JSON.stringify(value);
}

function randomSecret() {
  return randomBytes(36).toString('base64');
}

function randomAlphaNumeric(length: number) {
  let result = '';
  while (result.length < length) {
    result += randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, '');
  }
  return result.slice(0, length);
}

async function writePrivateFile(filePath: string, content: string) {
  await writeFile(filePath, content, { encoding: 'utf8', mode: 0o600 });
  await chmod(filePath, 0o600);
}

function resolveTargetDirectory(value: string) {
  return path.resolve(process.cwd(), value);
}

async function isNonEmptyDirectory(targetDirectory: string) {
  try {
    const targetStat = await stat(targetDirectory);
    if (!targetStat.isDirectory()) {
      return false;
    }
    return (await readdir(targetDirectory)).length > 0;
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

function isNotFound(error: unknown) {
  return (
    typeof error === 'object' &&
    error != null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function isDeploymentTemplateId(value: string): value is DeploymentTemplateId {
  return value === 'docker' || value === 'aws-terraform';
}

async function promptRequired(label: string, defaultValue?: string) {
  const answer = await promptText(label, defaultValue);
  return requireNonEmpty(answer, label);
}

async function promptText(label: string, defaultValue?: string) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const suffix = defaultValue == null ? ': ' : ` [${defaultValue}]: `;
    const answer = await rl.question(`${label}${suffix}`);
    return answer === '' && defaultValue != null ? defaultValue : answer;
  } finally {
    rl.close();
  }
}

async function promptChoice(label: string, choices: [string, string][]) {
  process.stdout.write(`${label}:\n`);
  choices.forEach(([value, description], index) => {
    process.stdout.write(`  ${index + 1}. ${value} - ${description}\n`);
  });

  while (true) {
    const answer = await promptText('Select', '1');
    const selectedIndex = Number(answer) - 1;
    if (Number.isInteger(selectedIndex) && choices[selectedIndex] != null) {
      return choices[selectedIndex][0];
    }
    const selected = choices.find(([value]) => value === answer);
    if (selected != null) {
      return selected[0];
    }
    process.stdout.write('Invalid selection.\n');
  }
}

async function promptBoolean(label: string, defaultValue: boolean) {
  const defaultText = defaultValue ? 'yes' : 'no';
  while (true) {
    const answer = (await promptText(`${label} (yes/no)`, defaultText)).toLowerCase();
    if (answer === 'yes' || answer === 'y' || answer === 'true') {
      return true;
    }
    if (answer === 'no' || answer === 'n' || answer === 'false') {
      return false;
    }
    process.stdout.write('Answer yes or no.\n');
  }
}

async function promptStringList(label: string, defaultValue: string) {
  const answer = await promptText(label, defaultValue);
  if (answer.trim() === '') {
    return [];
  }
  return answer
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

async function promptSecretRequired(label: string) {
  const value = await promptSecret(label);
  return requireNonEmpty(value, label);
}

async function promptSecret(label: string) {
  if (!process.stdin.isTTY) {
    throw new Error(`${label} requires an interactive TTY`);
  }

  process.stdout.write(`${label}: `);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise<string>((resolve, reject) => {
    let value = '';

    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw);
      process.stdout.write('\n');
    };

    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup();
          reject(new Error('Interrupted'));
          return;
        }
        if (byte === 13 || byte === 10) {
          cleanup();
          resolve(value);
          return;
        }
        if (byte === 127 || byte === 8) {
          value = value.slice(0, -1);
          continue;
        }
        value += Buffer.from([byte]).toString('utf8');
      }
    };

    stdin.on('data', onData);
  });
}
