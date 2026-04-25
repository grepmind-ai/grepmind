import { access, chmod, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsdown';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const packageDir = process.cwd();
const packageJsonPath = path.join(packageDir, 'package.json');
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));

const packageName = packageJson.name ?? path.basename(packageDir);
const distDir = path.join(packageDir, 'dist');
const entry = await resolveEntry(packageName);
const externalDependencies = Object.keys({
  ...packageJson.dependencies,
  ...packageJson.peerDependencies,
  ...packageJson.optionalDependencies,
}).map((name) => new RegExp(`^${escapeRegExp(name)}(?:/.*)?$`));

await rm(path.join(packageDir, 'tsconfig.tsbuildinfo'), { force: true });

if (packageName === '@grepmind/agent') {
  const { generateAgentMigrations } = await import(
    pathToFileURL(
      path.join(packageDir, 'scripts/generate-embedded-migrations.mjs'),
    )
  );

  await generateAgentMigrations();
}

await build({
  cwd: packageDir,
  name: packageName,
  entry: {
    index: entry,
  },
  outDir: 'dist',
  clean: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  fixedExtension: false,
  hash: false,
  sourcemap: false,
  dts: {
    sourcemap: false,
  },
  deps: {
    neverBundle: externalDependencies,
    skipNodeModulesBundle: true,
  },
});

if (packageJson.bin != null) {
  await chmod(path.join(distDir, 'index.js'), 0o755);
}

const outputFiles = await readdir(distDir);
const expectedFiles = new Set(['index.js', 'index.d.ts']);
const unexpectedFiles = outputFiles.filter((file) => !expectedFiles.has(file));

if (unexpectedFiles.length > 0) {
  throw new Error(
    `${packageName} build produced extra files in dist: ${unexpectedFiles.join(', ')}`,
  );
}

async function resolveEntry(packageName) {
  if (packageName === '@grepmind/agent') {
    return path.join(rootDir, 'packages/agent/src/cli.ts');
  }

  const tsEntry = path.join(packageDir, 'src/index.ts');
  const jsEntry = path.join(packageDir, 'src/index.js');

  return (await fileExists(tsEntry)) ? tsEntry : jsEntry;
}

function fileExists(filePath) {
  return access(filePath).then(
    () => true,
    () => false,
  );
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}
