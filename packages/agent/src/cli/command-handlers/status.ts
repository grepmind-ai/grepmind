import process from 'node:process';
import type { SearchHeadRpcResult } from '../../runtime/rpc/protocol.js';
import { executeSocketPreferredCommand, resolveWorkspacePath } from '../command-support.js';
import {
  getIntegerFlag,
  getOptionalIntegerFlagStrict,
  getOptionalNumberFlagStrict,
  getOptionalSearchTargetFlag,
  getStringFlag,
  hasBooleanFlag,
  requireStringFlag,
} from '../flags.js';
import type { ParsedArgs } from '../parse-args.js';

export async function stateCommand(args: ParsedArgs): Promise<void> {
  const result = await executeSocketPreferredCommand(args, {
    rpc: (client) => client.request('status', {
      bindingId: getIntegerFlag(args, 'binding-id'),
      branch: getStringFlag(args, 'branch'),
      commitSha: getStringFlag(args, 'commit-sha'),
      limit: getIntegerFlag(args, 'limit') ?? 100,
    }),
  });

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export async function searchHeadCommand(args: ParsedArgs): Promise<void> {
  const query = requireStringFlag(args, 'query');
  const bindingId = getOptionalIntegerFlagStrict(args, 'binding-id');
  const workspaceFlag = getStringFlag(args, 'workspace');
  const workspacePath = bindingId == null
    ? await resolveWorkspacePath(workspaceFlag ?? process.cwd())
    : undefined;
  const target = getOptionalSearchTargetFlag(args, 'target');
  const limit = getOptionalIntegerFlagStrict(args, 'limit');
  const threshold = getOptionalNumberFlagStrict(args, 'threshold');
  const rerank = hasBooleanFlag(args, 'no-rerank') ? false : undefined;

  const result = await executeSocketPreferredCommand(args, {
    rpc: (client) => client.request('searchHead', {
      bindingId,
      workspacePath,
      query,
      target,
      limit,
      threshold,
      rerank,
    }),
  });

  if (hasBooleanFlag(args, 'json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write(formatSearchHeadTextOutput(result));
}

function formatSearchHeadTextOutput(result: SearchHeadRpcResult): string {
  const lines: string[] = [];

  if (result.items.length === 0) {
    lines.push('No results.');
  } else {
    result.items.forEach((item, index) => {
      const location = `${item.relativePath}:${item.symbol.startLine}-${item.symbol.endLine}`;
      const symbolLabel = formatSearchResultSymbol(item);
      lines.push(`${index + 1}. [${item.score.toFixed(3)}] ${location}`);
      if (symbolLabel) {
        lines.push(`   ${symbolLabel}`);
      }
      lines.push(`   ${shortenPreview(item.previewText)}`);
    });
  }

  lines.push('');
  lines.push(`bindingId: ${result.scope.bindingId}`);
  lines.push(`workspacePath: ${result.scope.workspacePath}`);
  lines.push(`branch: ${result.scope.branch}`);
  lines.push(`headCommitSha: ${result.scope.headCommitSha}`);
  lines.push(`revisionId: ${result.scope.revisionId}`);
  lines.push(`durationMs: ${result.meta.durationMs}`);
  lines.push(`totalResults: ${result.meta.totalResults}`);
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function formatSearchResultSymbol(result: SearchHeadRpcResult['items'][number]): string {
  const symbolType = result.symbol.type.trim();
  const symbolName = result.symbol.name.trim();
  if (symbolType && symbolName) {
    return `${symbolType} ${symbolName}`;
  }
  if (symbolName) {
    return symbolName;
  }
  if (symbolType) {
    return symbolType;
  }

  return '';
}

function shortenPreview(value: string, maxLength = 140): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}
