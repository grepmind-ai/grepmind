export type FlagValue = string | boolean;

export interface ParsedArgs {
  command: string | null;
  positionals: string[];
  flags: Map<string, FlagValue>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, FlagValue>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const trimmed = token.slice(2);
    const equalIndex = trimmed.indexOf('=');
    if (equalIndex >= 0) {
      const key = trimmed.slice(0, equalIndex);
      const value = trimmed.slice(equalIndex + 1);
      flags.set(key, value);
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags.set(trimmed, true);
      continue;
    }

    flags.set(trimmed, next);
    index += 1;
  }

  return {
    command: positionals[0] ?? null,
    positionals: positionals.slice(1),
    flags,
  };
}
