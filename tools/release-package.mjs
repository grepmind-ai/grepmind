import { writeFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const rootDir = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

function parseArgs(argv) {
  const args = {
    dryRun: false,
    tag: 'alpha',
    workspace: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }

    if (arg === '--workspace') {
      args.workspace = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg.startsWith('--workspace=')) {
      args.workspace = arg.slice('--workspace='.length);
      continue;
    }

    if (arg === '--tag') {
      args.tag = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg.startsWith('--tag=')) {
      args.tag = arg.slice('--tag='.length);
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printUsage(0);
    }

    printUsage(1, `Unknown argument: ${arg}`);
  }

  if (!args.workspace) {
    printUsage(1, 'Missing required --workspace');
  }

  if (!args.tag) {
    printUsage(1, 'Missing value for --tag');
  }

  return args;
}

function printUsage(exitCode, errorMessage) {
  if (errorMessage) {
    console.error(errorMessage);
    console.error('');
  }

  console.error(`Usage:
  node tools/release-package.mjs --workspace <name> [--tag <dist-tag>] [--dry-run]

Examples:
  node tools/release-package.mjs --workspace @grepmind/agent
  node tools/release-package.mjs --workspace grepmind --tag latest --dry-run`);
  process.exit(exitCode);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
    env: options.env ?? process.env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const args = parseArgs(process.argv.slice(2));
const releaseEnv = {
  ...process.env,
  NPM_CONFIG_CACHE: process.env.NPM_CONFIG_CACHE ?? '/tmp/.npm-cache',
};

if (!releaseEnv.NODE_AUTH_TOKEN && releaseEnv.NPM_TOKEN) {
  releaseEnv.NODE_AUTH_TOKEN = releaseEnv.NPM_TOKEN;
}

if (!args.dryRun && !releaseEnv.NODE_AUTH_TOKEN) {
  console.error('Missing NODE_AUTH_TOKEN or NPM_TOKEN for npm publish.');
  process.exit(1);
}

let tempUserConfigPath = null;
if (releaseEnv.NODE_AUTH_TOKEN) {
  tempUserConfigPath = path.join(os.tmpdir(), `grepmind-npmrc-${process.pid}-${Date.now()}`);
  writeFileSync(
    tempUserConfigPath,
    `//registry.npmjs.org/:_authToken=${releaseEnv.NODE_AUTH_TOKEN}\nregistry=https://registry.npmjs.org/\nalways-auth=true\n`,
    'utf8',
  );
  releaseEnv.NPM_CONFIG_USERCONFIG = tempUserConfigPath;
}

try {
  console.log(`${args.dryRun ? 'Dry-run publishing' : 'Publishing'} ${args.workspace} with dist-tag "${args.tag}"...`);
  const publishArgs = ['publish', '--workspace', args.workspace, '--access', 'public', '--tag', args.tag];
  if (args.dryRun) {
    publishArgs.push('--dry-run');
  }
  run('npm', publishArgs, {
    env: releaseEnv,
  });
} finally {
  if (tempUserConfigPath) {
    unlinkSync(tempUserConfigPath);
  }
}
