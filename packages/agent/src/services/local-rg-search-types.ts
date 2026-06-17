import type { SearchResultItem } from '../backend/contracts/index.js';

export type LocalRgSearchErrorCode =
  | 'RG_NOT_FOUND'
  | 'RG_INVALID_REGEX'
  | 'RG_TIMEOUT'
  | 'RG_OUTPUT_LIMIT'
  | 'RG_PROCESS_FAILED'
  | 'RG_PATH_OUTSIDE_WORKSPACE'
  | 'RG_WORKSPACE_NOT_FOUND'
  | 'RG_INVALID_INPUT';

export class LocalRgSearchError extends Error {
  readonly retryable: boolean;
  readonly stderrPreview?: string;

  constructor(
    readonly code: LocalRgSearchErrorCode,
    message: string,
    options: { retryable?: boolean; stderrPreview?: string } = {},
  ) {
    super(message);
    this.name = 'LocalRgSearchError';
    this.retryable = options.retryable ?? isRetryableLocalRgError(code);
    this.stderrPreview = options.stderrPreview;
  }
}

export interface LocalRgSearchResult {
  items: SearchResultItem[];
  stats: {
    matchCount: number;
    fileCount: number;
    truncated: boolean;
    durationMs: number;
  };
  warning?: string;
}

function isRetryableLocalRgError(code: LocalRgSearchErrorCode): boolean {
  return (
    code === 'RG_TIMEOUT' ||
    code === 'RG_OUTPUT_LIMIT' ||
    code === 'RG_PROCESS_FAILED'
  );
}
