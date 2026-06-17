#!/usr/bin/env node
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startMcpRuntimePreparation } from './runtime-context.js';
import { agentStatusSchema, agentStatusTool } from './tools/agent_status.js';
import { codeSearchSchema, codeSearchTool } from './tools/code_search.js';
import { contextLayerSchema, contextLayerTool } from './tools/context_layer.js';
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
        'Code and docs search over the current workspace. Describe intent in query. Optionally add exact.pattern for identifiers, strings, routes, config keys, error text, imports, or regex anchors that should appear in relevant files.',
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

  if (process.env.GREPMIND_CONTEXT_LAYER_SUBAGENT !== '1') {
    server.registerTool(
      'context_layer',
      {
        description:
          'Prepare a read-only multi-file and multi-doc context_pack with evidence quality for a coding agent using a mandatory Codex prompt-refiner stage, bounded Grepmind code_search retrieval, and read-only research subagents. The tool may first return agent_questions with a refinementSession; answer them by calling context_layer again with refinementSession and agentAnswers.',
        inputSchema: contextLayerSchema,
      },
      contextLayerTool,
    );
  }

  parseMcpCliArgs(process.argv.slice(2));
  const workspacePath = await resolveWorkspaceRoot();
  startMcpRuntimePreparation({ workspacePath });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
