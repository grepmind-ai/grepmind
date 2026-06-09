const DEFAULT_HOSTNAME = 'app.grepmind.ai';

export function resolveInitHostname(input: {
  flagHostname?: string;
  existingHostname?: string;
}): string {
  return normalizeHostname(
    input.flagHostname ?? input.existingHostname ?? DEFAULT_HOSTNAME,
    input.flagHostname != null ? '--hostname' : '.grepmind.json hostname',
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
    trimmed.includes('#')
  ) {
    throw new Error(`${source} must be a host with optional port, not a URL`);
  }
  if (/\s/.test(trimmed)) {
    throw new Error(`${source} must not contain whitespace`);
  }

  const colonIndex = trimmed.lastIndexOf(':');
  if (colonIndex >= 0) {
    const host = trimmed.slice(0, colonIndex);
    const port = trimmed.slice(colonIndex + 1);
    if (!host || !/^[0-9]+$/.test(port)) {
      throw new Error(`${source} must be a host with optional numeric port`);
    }
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
      throw new Error(`${source} port must be between 1 and 65535`);
    }
  }

  return trimmed;
}

export function hostnamesEqual(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
