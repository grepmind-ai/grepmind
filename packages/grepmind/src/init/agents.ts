export type InitAgentName = 'codex' | 'claude' | 'cursor';
export type DetectedAgentName = InitAgentName | 'opencode' | 'gemini';

export const supportedInitAgents: readonly InitAgentName[] = [
  'codex',
  'claude',
  'cursor',
];

export const unsupportedDetectedAgents: readonly Exclude<
  DetectedAgentName,
  InitAgentName
>[] = ['opencode', 'gemini'];

export function isInitAgentName(value: string): value is InitAgentName {
  return (
    value === 'codex' ||
    value === 'claude' ||
    value === 'cursor'
  );
}

export function formatAgentName(agent: DetectedAgentName): string {
  switch (agent) {
    case 'codex':
      return 'Codex';
    case 'claude':
      return 'Claude Code';
    case 'cursor':
      return 'Cursor';
    case 'opencode':
      return 'OpenCode';
    case 'gemini':
      return 'Gemini CLI';
  }
}
