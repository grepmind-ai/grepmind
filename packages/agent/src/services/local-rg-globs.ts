import path from 'node:path';

export interface ParsedUserGlob {
  negated: boolean;
  matcher: RegExp;
  basenameMatcher: RegExp | null;
}

export function parseUserGlobs(globs: string[]): ParsedUserGlob[] {
  return globs.map((rawGlob) => {
    const raw = rawGlob.trim();
    const negated = raw.startsWith('!');
    const pattern = negated ? raw.slice(1) : raw;
    return {
      negated,
      matcher: globToRegExp(pattern),
      basenameMatcher: pattern.includes('/')
        ? null
        : globToRegExp(`**/${pattern}`),
    };
  });
}

export function matchesUserGlobs(
  relativePath: string,
  globs: ParsedUserGlob[] | undefined,
): boolean {
  if (!globs || globs.length === 0) {
    return true;
  }

  let hasPositive = false;
  let positiveMatch = false;
  for (const glob of globs) {
    const matches =
      glob.matcher.test(relativePath) ||
      (glob.basenameMatcher?.test(relativePath) ?? false);
    if (glob.negated) {
      if (matches) {
        return false;
      }
      continue;
    }

    hasPositive = true;
    positiveMatch ||= matches;
  }

  return !hasPositive || positiveMatch;
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern
    .trim()
    .replaceAll(/^[/\\]+/g, '')
    .replaceAll('\\', '/')
    .split(path.sep)
    .join('/');
  let source = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];

    if (char === '*') {
      if (next === '*') {
        const afterGlobstar = normalized[index + 2];
        if (afterGlobstar === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      continue;
    }

    source += escapeRegExp(char);
  }

  source += '$';
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[\\^$+?.()|[\]{}]/g, '\\$&');
}
