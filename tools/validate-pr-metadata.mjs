import { existsSync, readFileSync } from 'node:fs';

const allowedTypes = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
];

const preferredScopes = [
  'agent-rpc',
  'agent',
  'mcp',
  'grepmind',
  'changeset',
  'release',
  'deps',
  'docs',
  'ci',
  'repo',
];

const automatedAuthors = new Set([
  'dependabot[bot]',
  'github-actions[bot]',
  'renovate[bot]',
]);

const titlePattern = new RegExp(
  `^(${allowedTypes.join('|')})(\\([a-z0-9][a-z0-9._/-]*\\))?!?: [^\\s].+$`,
);

function readEventPayload() {
  if (
    process.env.GITHUB_EVENT_PATH &&
    existsSync(process.env.GITHUB_EVENT_PATH)
  ) {
    return JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  }

  if (process.env.PR_TITLE || process.env.PR_BODY) {
    return {
      pull_request: {
        title: process.env.PR_TITLE ?? '',
        body: process.env.PR_BODY ?? '',
        draft: process.env.PR_DRAFT === 'true',
        head: { ref: process.env.PR_HEAD_REF ?? '' },
        user: { login: process.env.PR_AUTHOR ?? '' },
      },
    };
  }

  return null;
}

function annotationValue(value) {
  return value
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}

function stripHtmlComments(value) {
  return value.replace(/<!--[\s\S]*?-->/g, '');
}

function getSection(body, sectionName) {
  const headings = [...body.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)];
  const expected = sectionName.toLowerCase();

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const name = heading[1].trim().toLowerCase();

    if (name !== expected) {
      continue;
    }

    const sectionStart = heading.index + heading[0].length;
    const sectionEnd = headings[index + 1]?.index ?? body.length;
    return body.slice(sectionStart, sectionEnd);
  }

  return null;
}

function meaningfulText(value) {
  return stripHtmlComments(value)
    .replace(/^[-*][ \t]+\[[ xX]\][ \t]+.*$/gm, '')
    .replace(/^#{1,6}[ \t]+.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function validateTitle(title, errors) {
  const trimmedTitle = title.trim();

  if (!trimmedTitle) {
    errors.push('PR title is required.');
    return;
  }

  if (!titlePattern.test(trimmedTitle)) {
    errors.push(
      `PR title must use Conventional Commits format: ${allowedTypes.join(
        '|',
      )}(optional-scope): description.`,
    );
    return;
  }

  const description = trimmedTitle.slice(trimmedTitle.indexOf(':') + 1).trim();

  if (description.length > 72) {
    errors.push('PR title description must be 72 characters or fewer.');
  }
}

function validateBody(body, errors) {
  const normalizedBody = body.trim();

  if (!meaningfulText(normalizedBody)) {
    errors.push(
      'PR description is required. Fill in the repository pull request template.',
    );
    return;
  }

  const summary = getSection(normalizedBody, 'Summary');
  if (summary === null) {
    errors.push("PR description must include a '## Summary' section.");
  } else if (meaningfulText(summary).length < 20) {
    errors.push(
      "PR description 'Summary' must explain the change in at least 20 characters.",
    );
  }

  const validation = getSection(normalizedBody, 'Validation');
  if (validation === null) {
    errors.push("PR description must include a '## Validation' section.");
  } else if (!meaningfulText(validation)) {
    errors.push(
      "PR description 'Validation' must list what was run or why it was not needed.",
    );
  }
}

const eventPayload = readEventPayload();
const pullRequest = eventPayload?.pull_request;

if (!pullRequest) {
  console.log('No pull request payload found. Nothing to validate.');
  process.exit(0);
}

const title = pullRequest.title ?? '';
const body = pullRequest.body ?? '';
const headRef = pullRequest.head?.ref ?? '';
const author = pullRequest.user?.login ?? '';

if (pullRequest.draft) {
  console.log(
    'Draft pull request detected. PR metadata validation is skipped until ready for review.',
  );
  process.exit(0);
}

if (headRef.startsWith('changeset-release/')) {
  console.log(
    'Changesets release pull request detected. PR metadata validation is skipped.',
  );
  process.exit(0);
}

if (automatedAuthors.has(author)) {
  console.log(
    `Automated pull request author '${author}' detected. PR metadata validation is skipped.`,
  );
  process.exit(0);
}

const errors = [];
validateTitle(title, errors);
validateBody(body, errors);

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`::error::${annotationValue(error)}`);
  }

  console.error('');
  console.error('Expected PR title examples:');
  console.error('  feat(agent): add branch sync status output');
  console.error('  fix(mcp): handle missing agent socket');
  console.error('  docs: update local setup instructions');
  console.error('');
  console.error(`Preferred scopes: ${preferredScopes.join(', ')}`);
  process.exit(1);
}

console.log('PR title and description metadata look good.');
