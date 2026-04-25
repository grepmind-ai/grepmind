import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(packageDir, 'dist');

const protocolDtsPath = path.join(distDir, 'protocol.d.ts');
const clientDtsPath = path.join(distDir, 'client.d.ts');
const indexDtsPath = path.join(distDir, 'index.d.ts');

const [protocolDts, clientDts] = await Promise.all([
  readFile(protocolDtsPath, 'utf8'),
  readFile(clientDtsPath, 'utf8'),
]);

const bundled = [
  cleanDeclaration(protocolDts),
  cleanClientDeclaration(clientDts),
]
  .filter(Boolean)
  .join('\n\n');

await writeFile(indexDtsPath, `${bundled}\n`, 'utf8');

const distEntries = await readdir(distDir);
await Promise.all(
  distEntries
    .filter(
      (entry) =>
        entry.endsWith('.d.ts.map') ||
        (entry.endsWith('.d.ts') && entry !== 'index.d.ts'),
    )
    .map((entry) => rm(path.join(distDir, entry), { force: true })),
);

function cleanDeclaration(value) {
  return value.replaceAll(/^\/\/# sourceMappingURL=.*$/gm, '').trim();
}

function cleanClientDeclaration(value) {
  return cleanDeclaration(value)
    .replace(/^import\s+\{[\s\S]*?\}\s+from\s+'\.\/protocol\.js';\n?/m, '')
    .replaceAll(/import\("\.\/protocol\.js"\)\./g, '')
    .trim();
}
