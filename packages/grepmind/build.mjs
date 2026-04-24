import * as esbuild from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(packageDir, 'dist');

console.log('Cleaning build output...');
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

console.log('Bundling CLI...');
await esbuild.build({
  entryPoints: [path.join(packageDir, 'src/index.js')],
  bundle: true,
  outfile: path.join(distDir, 'index.js'),
  format: 'esm',
  platform: 'node',
  target: 'node18',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  external: [
    '@grepmind/agent',
    '@grepmind/agent/cli',
  ],
});

console.log('Build complete!');
