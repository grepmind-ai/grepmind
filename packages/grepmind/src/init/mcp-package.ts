export const DEFAULT_MCP_PACKAGE_SPEC = '@grepmind/mcp@0.1.1';

export function resolveMcpPackageSpec(input?: string): string {
  if (input == null) {
    return DEFAULT_MCP_PACKAGE_SPEC;
  }
  if (input.trim() === '') {
    throw new Error('--mcp-package must not be empty');
  }
  return input;
}
