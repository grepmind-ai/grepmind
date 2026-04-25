import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import type { LocalProjectRecord } from '../db/schema.js';

export async function confirmCleanProjects(
  projects: LocalProjectRecord[],
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('clean requires an interactive terminal confirmation');
  }

  const workspacePath = projects[0]!.workspacePath;
  const summary =
    projects.length === 1
      ? `1 local project registration`
      : `${projects.length} local project registrations`;

  process.stdout.write(
    [
      '',
      `Workspace: ${workspacePath}`,
      `This will delete ${summary} from the local Grepmind agent database.`,
      'It will remove local revisions, files, changes, chunks, materializations, branch state, and sync state for this workspace.',
      'It will not delete server-side bindings, repositories, or agent config.',
      'Type y/yes to continue or n/no to cancel.',
      '',
    ].join('\n'),
  );

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const answer = (await rl.question('Continue? [y/n]: '))
        .trim()
        .toLowerCase();
      if (answer === 'y' || answer === 'yes') {
        return true;
      }
      if (answer === 'n' || answer === 'no') {
        return false;
      }

      process.stdout.write('Please enter y, n, yes, or no.\n');
    }
  } finally {
    rl.close();
  }
}
