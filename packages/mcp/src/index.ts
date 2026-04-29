#!/usr/bin/env node
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { prepareMcpRuntime } from './runtime-context.js';
import { agentStatusSchema, agentStatusTool } from './tools/agent_status.js';
import { codeSearchSchema, codeSearchTool } from './tools/code_search.js';
import { parseMcpCliArgs, resolveWorkspaceRoot } from './workspace.js';

async function main(): Promise<void> {
  const server = new McpServer({
    name: 'grepmind-search',
    version: '0.1.1',
  });

  server.registerTool(
    'code_search',
    {
      description:
        'Code search — find code by describing what it does in natural language',
      inputSchema: codeSearchSchema,
    },
    codeSearchTool,
  );

  server.registerTool(
    'grepmind_agent_status',
    {
      description:
        'Show Grepmind MCP workspace, auth, runtime, project, and sync status',
      inputSchema: agentStatusSchema,
    },
    agentStatusTool,
  );

  parseMcpCliArgs(process.argv.slice(2));
  const workspacePath = await resolveWorkspaceRoot();
  await prepareMcpRuntime({ workspacePath });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
