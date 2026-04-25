#!/usr/bin/env node
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { codeSearchSchema, codeSearchTool } from './tools/code_search.js';

async function main(): Promise<void> {
  const server = new McpServer({
    name: 'grepmind-search',
    version: '0.1.0',
  });

  server.tool(
    'code_search',
    'Code search — find code by describing what it does in natural language',
    codeSearchSchema.shape,
    codeSearchTool,
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
