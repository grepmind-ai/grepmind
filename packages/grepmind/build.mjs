import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(path.dirname(fileURLToPath(import.meta.url)));
await import('../../tools/build-package.mjs');
