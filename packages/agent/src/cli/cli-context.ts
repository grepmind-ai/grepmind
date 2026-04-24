import process from 'node:process';
import { AgentConsole } from './agent-console.js';
import { hasBooleanFlag } from './flags.js';
import type { ParsedArgs } from './parse-args.js';

export interface AgentCliExecutionContext {
  cliEntrypointUrl: string;
}

export function createAgentConsole(args?: ParsedArgs): AgentConsole {
  return new AgentConsole({
    traceEnabled: isTraceEnabled(args),
  });
}

function isTraceEnabled(args?: ParsedArgs): boolean {
  return hasBooleanFlag(args, 'trace') || process.env.GREPMIND_AGENT_TRACE === '1';
}
