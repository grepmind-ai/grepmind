import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DeploymentTemplateId } from './manifest.js';
import { deploymentTemplates } from './manifest.js';

const packageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

export function getDeploymentTemplateDirectory(
  id: DeploymentTemplateId,
): string {
  const manifest = deploymentTemplates[id];
  if (manifest == null) {
    throw new Error(`Unknown deployment template: ${id}`);
  }

  return path.join(packageDirectory, manifest.sourceDirectory);
}
