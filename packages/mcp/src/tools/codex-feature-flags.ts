const RESEARCH_SUBAGENT_DISABLED_FEATURES = [
  'plugins',
  'apps',
  'browser_use',
  'browser_use_external',
  'in_app_browser',
  'computer_use',
  'image_generation',
  'multi_agent',
  'goals',
  'hooks',
  'mentions_v2',
  'personality',
  'workspace_dependencies',
  'tool_suggest',
  'skill_mcp_dependency_install',
] as const;

const PROMPT_REFINER_EXTRA_DISABLED_FEATURES = [
  'shell_tool',
  'unified_exec',
] as const;

export function getResearchSubagentDisableFeatureArgs(): string[] {
  return buildDisableFeatureArgs(RESEARCH_SUBAGENT_DISABLED_FEATURES);
}

export function getResearchSubagentMcpConfigArgs(): string[] {
  return buildConfigArgs([
    'mcp_servers.node_repl.enabled=false',
    'mcp_servers.playwright.enabled=false',
  ]);
}

export function getPromptRefinerDisableFeatureArgs(): string[] {
  return buildDisableFeatureArgs([
    ...RESEARCH_SUBAGENT_DISABLED_FEATURES,
    ...PROMPT_REFINER_EXTRA_DISABLED_FEATURES,
  ]);
}

export function getPromptRefinerMcpConfigArgs(): string[] {
  return buildConfigArgs([
    'mcp_servers.grepmind.enabled=false',
    'mcp_servers.node_repl.enabled=false',
    'mcp_servers.playwright.enabled=false',
  ]);
}

function buildDisableFeatureArgs(features: readonly string[]): string[] {
  return features.flatMap((feature) => ['--disable', feature]);
}

function buildConfigArgs(configs: readonly string[]): string[] {
  return configs.flatMap((config) => ['--config', config]);
}
