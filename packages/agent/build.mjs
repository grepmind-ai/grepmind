import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAgentMigrations } from './scripts/generate-embedded-migrations.mjs';

const require = createRequire(import.meta.url);
const packageDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(packageDir, 'dist');
const tscBin = require.resolve('typescript/bin/tsc');

console.log('Cleaning build output...');
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

console.log('Generating embedded migrations...');
await generateAgentMigrations();

console.log('Type checking source...');
execFileSync(process.execPath, [
  tscBin,
  '-p',
  path.join(packageDir, 'tsconfig.json'),
  '--noEmit',
], {
  cwd: packageDir,
  stdio: 'inherit',
});

console.log('Bundling CLI...');
await esbuild.build({
  entryPoints: [path.join(packageDir, 'src/cli.ts')],
  bundle: true,
  outfile: path.join(distDir, 'index.js'),
  format: 'esm',
  platform: 'node',
  target: 'node18',
  sourcemap: false,
  legalComments: 'none',
  minifyWhitespace: true,
  logLevel: 'info',
  external: [
    '@electric-sql/pglite',
    '@electric-sql/pglite/vector',
  ],
});

console.log('Build complete!');
