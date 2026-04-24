import type { AgentCommandMode } from '../runtime/rpc/protocol.js';
import type { ParsedArgs } from './parse-args.js';

export function getStringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

export function hasBooleanFlag(args: ParsedArgs | undefined, name: string): boolean {
  return args?.flags.get(name) === true;
}

export function requireStringFlag(args: ParsedArgs, name: string, fallback?: string): string {
  const value = getStringFlag(args, name) ?? fallback;
  if (!value) {
    throw new Error(`--${name} is required`);
  }

  return value;
}

export function getIntegerFlag(args: ParsedArgs, name: string): number | undefined {
  const value = getStringFlag(args, name);
  return toInteger(value);
}

export function getOptionalIntegerFlagStrict(args: ParsedArgs, name: string): number | undefined {
  const value = getStringFlag(args, name);
  if (value == null) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== value.trim()) {
    throw new Error(`--${name} must be a number`);
  }

  return parsed;
}

export function getOptionalNumberFlagStrict(args: ParsedArgs, name: string): number | undefined {
  const value = getStringFlag(args, name);
  if (value == null) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--${name} must be a number`);
  }

  return parsed;
}

export function getOptionalSearchTargetFlag(args: ParsedArgs, name: string): 'code' | 'docs' | undefined {
  const value = getStringFlag(args, name);
  if (value == null) {
    return undefined;
  }
  if (value === 'code' || value === 'docs') {
    return value;
  }

  throw new Error(`--${name} must be code or docs`);
}

export function requireIntegerFlag(args: ParsedArgs, name: string): number {
  const value = getIntegerFlag(args, name);
  if (value == null) {
    throw new Error(`--${name} must be a number`);
  }

  return value;
}

export function toInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function nonEmptyString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function getCommandMode(args: ParsedArgs): AgentCommandMode {
  const mode = getStringFlag(args, 'mode') ?? 'runtime-only';
  if (mode === 'runtime-only') {
    return mode;
  }

  throw new Error('--mode must be runtime-only');
}
