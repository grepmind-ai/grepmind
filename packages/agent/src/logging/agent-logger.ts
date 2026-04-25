export type AgentLogScope =
  | 'cli'
  | 'config'
  | 'runtime'
  | 'sync'
  | 'publish'
  | 'attach'
  | 'project'
  | 'http';

export interface AgentLogger {
  info(scope: AgentLogScope, message: string): void;
  success(scope: AgentLogScope, message: string): void;
  warn(scope: AgentLogScope, message: string): void;
  error(scope: AgentLogScope, message: string, error?: unknown): void;
  trace(scope: AgentLogScope, message: string): void;
}

export const noopAgentLogger: AgentLogger = {
  info: () => {},
  success: () => {},
  warn: () => {},
  error: () => {},
  trace: () => {},
};
