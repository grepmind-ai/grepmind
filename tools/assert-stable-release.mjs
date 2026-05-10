import { access, readFile } from 'node:fs/promises';

const publicPackageJsonPaths = [
  'packages/agent-rpc/package.json',
  'packages/agent/package.json',
  'packages/mcp/package.json',
  'packages/deployment/package.json',
  'packages/grepmind/package.json',
];

if (await fileExists(new URL('../.changeset/pre.json', import.meta.url))) {
  throw new Error(
    'Stable releases must not run while Changesets pre mode is active',
  );
}

for (const packageJsonPath of publicPackageJsonPaths) {
  const packageJson = JSON.parse(
    await readFile(new URL(`../${packageJsonPath}`, import.meta.url), 'utf8'),
  );

  if (packageJson.version.includes('-')) {
    throw new Error(
      `Stable release cannot publish prerelease version ${packageJson.name}@${packageJson.version}`,
    );
  }
}

function fileExists(fileUrl) {
  return access(fileUrl).then(
    () => true,
    () => false,
  );
}
