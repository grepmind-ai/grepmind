const DEFAULT_HOSTNAME = 'app.grepmind.ai';
const HOSTNAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export function resolveInitHostname(input: {
  flagHostname?: string;
  existingHostname?: string;
}): string {
  return normalizeHostname(
    input.flagHostname ?? input.existingHostname ?? DEFAULT_HOSTNAME,
    input.flagHostname == null ? '.grepmind.json hostname' : '--hostname',
  );
}

export function normalizeHostname(value: string, source = 'hostname'): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${source} must not be empty`);
  }
  if (
    trimmed.includes('://') ||
    trimmed.includes('/') ||
    trimmed.includes('?') ||
    trimmed.includes('#') ||
    trimmed.includes(':')
  ) {
    throw new Error(
      `${source} must be a hostname without scheme, port, path, query, or fragment`,
    );
  }
  if (/\s/.test(trimmed)) {
    throw new Error(`${source} must not contain whitespace`);
  }
  if (trimmed !== 'localhost' && !HOSTNAME_PATTERN.test(trimmed)) {
    throw new Error(`${source} must be a valid hostname`);
  }

  return trimmed;
}

export function hostnamesEqual(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
