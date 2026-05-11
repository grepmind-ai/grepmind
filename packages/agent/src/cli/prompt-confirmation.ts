import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import type { LocalProjectRecord } from '../db/schema.js';

export async function confirmCleanProjects(
  projects: LocalProjectRecord[],
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('clean requires an interactive terminal confirmation');
  }

  const workspacePaths = [
    ...new Set(projects.map((project) => project.workspacePath)),
  ];
  const summary =
    projects.length === 1
      ? `1 local project registration`
      : `${projects.length} local project registrations`;
  const workspaceLines =
    workspacePaths.length === 1
      ? [`Workspace: ${workspacePaths[0]}`]
      : [
          'Workspaces:',
          ...workspacePaths.map((workspace) => `  - ${workspace}`),
        ];

  process.stdout.write(
    [
      '',
      ...workspaceLines,
      `This will delete ${summary} from the local Grepmind agent database.`,
      'It will remove local revisions, files, changes, chunks, materializations, branch state, and sync state for the selected workspace data.',
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
