import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export function assertInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  ) {
    return;
  }
  throw new Error(`Refusing to write outside Git workspace: ${target}`);
}

export function assertAllowedProjectWrite(root: string, target: string): void {
  assertInside(root, target);
  const relative = path.relative(root, target);
  if (path.basename(target) === 'AGENTS.md') {
    throw new Error(`Refusing to write AGENTS.md: ${target}`);
  }
  if (
    relative === '.changeset' ||
    relative.startsWith(`.changeset${path.sep}`)
  ) {
    throw new Error(`Refusing to write changeset files by hand: ${target}`);
  }
}

export async function writeTextFileAtomic(input: {
  root: string;
  targetPath: string;
  content: string;
  defaultMode?: number;
}): Promise<void> {
  assertAllowedProjectWrite(input.root, input.targetPath);
  await assertNoSymlinkParents(input.root, input.targetPath);
  const mode = await resolveWriteMode(input.targetPath, input.defaultMode);
  await mkdir(path.dirname(input.targetPath), { recursive: true });

  const temporaryPath = path.join(
    path.dirname(input.targetPath),
    `.${path.basename(input.targetPath)}.${process.pid}.${Date.now()}.tmp`,
  );

  const handle = await open(temporaryPath, 'wx', mode);
  try {
    await handle.writeFile(input.content, 'utf8');
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  } finally {
    await handle.close();
  }

  await rename(temporaryPath, input.targetPath);
}

async function resolveWriteMode(
  targetPath: string,
  defaultMode = 0o644,
): Promise<number> {
  try {
    const targetStat = await lstat(targetPath);
    if (targetStat.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symlink: ${targetPath}`);
    }
    if (!targetStat.isFile()) {
      throw new Error(`Target path is not a file: ${targetPath}`);
    }
    return targetStat.mode & 0o777;
  } catch (error) {
    if (isNotFound(error)) {
      return defaultMode;
    }
    throw error;
  }
}

async function assertNoSymlinkParents(
  root: string,
  targetPath: string,
): Promise<void> {
  let current = path.dirname(targetPath);
  const parents: string[] = [];
  while (current !== root && current.startsWith(root)) {
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

export function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error != null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
