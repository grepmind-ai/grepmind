import { access, readFile } from 'node:fs/promises';

const preStatePath = new URL('../.changeset/pre.json', import.meta.url);
const publicPackageJsonPaths = [
  'packages/agent-rpc/package.json',
  'packages/agent/package.json',
  'packages/mcp/package.json',
  'packages/deployment/package.json',
  'packages/grepmind/package.json',
];

if (!(await fileExists(preStatePath))) {
  throw new Error(
    'Beta releases require Changesets pre mode. Merge the beta version PR first.',
  );
}

const state = JSON.parse(await readFile(preStatePath, 'utf8'));
if (state.mode !== 'pre' || state.tag !== 'beta') {
  throw new Error('.changeset/pre.json is not configured for beta releases');
}

for (const packageJsonPath of publicPackageJsonPaths) {
  const packageJson = JSON.parse(
    await readFile(new URL(`../${packageJsonPath}`, import.meta.url), 'utf8'),
  );

  if (!packageJson.version.includes('-beta.')) {
    throw new Error(
      `Beta release expected beta prerelease version for ${packageJson.name}@${packageJson.version}`,
    );
  }
}

function fileExists(fileUrl) {
  return access(fileUrl).then(
    () => true,
    () => false,
  );
}
